import { create } from "zustand";
import type { Bubble, ChatPreview } from "@/lib/gateway-types";
import {
  addWebhook as apiAddWebhook,
  cancelBulkJob,
  connectSession,
  deleteSession as apiDeleteSession,
  getQr,
  listBulkJobs,
  listChats,
  listMessages,
  listSessions,
  loadWsStats,
  loginDashboard,
  removeWebhook as apiRemoveWebhook,
  retryBulkJob,
  sendRawApi,
  sendText,
  startBulkJob,
  testProxy as apiTestProxy,
  updateSessionConfig,
  type BulkJobSummary,
  type GatewayChat,
  type GatewayEvent,
  type GatewayMessage,
  type GatewaySession,
  type StartBulkInput,
} from "@/lib/gateway-client";

/** WhatsApp timestamps are seconds; the UI wants a short local clock. */
function clockFrom(ts: number | undefined): string {
  if (!ts) return "";
  const ms = ts > 1e12 ? ts : ts * 1000;
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function initialsFrom(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

/** Backend /chats/overview row -> the ChatPreview the UI already renders. */
function toChatPreview(c: GatewayChat): ChatPreview {
  const name = c.name || c.phone || c.id.split("@")[0];
  return {
    id: c.id,
    name,
    preview: c.lastMessage ?? "",
    time: clockFrom(c.lastMessageTimestamp),
    unread: c.unreadCount ?? 0,
    kind: c.isGroup ? "group" : "dm",
    avatar: c.profilePicture ? "photo" : "initials",
    photo: c.profilePicture ?? undefined,
    initials: initialsFrom(name),
    phone: c.phone ?? undefined,
  };
}

/** Backend message -> chat bubble. Media has no text, so label it by type.
 *  Reactions arrive as an object ({ emoji, targetMessageId }) — never render it raw. */
function toBubble(m: GatewayMessage): Bubble {
  const content = m.content;
  const text =
    typeof content === "string" && content
      ? content
      : content && typeof content === "object"
        ? `${content.emoji ?? "👍"} reacted to a message`
        : (m.caption ?? `[${m.type}]`);
  return {
    id: m.id,
    kind: "text",
    from: m.fromMe ? "me" : "them",
    text,
    time: clockFrom(m.timestamp),
  };
}

type NavId = "chats" | "contacts" | "groups" | "broadcast" | "tools" | "settings";
type Filter = "all" | "unread" | "groups";
type Overlay = null | "qr" | "create-session" | "webhooks" | "proxy" | "bulk" | "templates" | "search";

type State = {
  live: boolean;
  user: string;
  apiKey: string;
  wsConnected: boolean;
  wsClients: number;
  sessions: GatewaySession[];
  events: GatewayEvent[];
  chats: ChatPreview[];
  threads: Record<string, Bubble[]>;
  activeChatId: string;
  activeAccountId: string;
  nav: NavId;
  filter: Filter;
  query: string;
  overlay: Overlay;
  qrSession: string;
  qrSrc: string;
  qrExpiresAt: number | null;
  webhookSessionId: string;
  /** Session the proxy modal edits. */
  proxySessionId: string;
  composer: string;
  /** Session whose campaigns the Broadcast panel shows. */
  bulkSessionId: string;
  bulkJobs: BulkJobSummary[];
  bulkLoading: boolean;
  toasts: Array<{ id: string; type: "success" | "error" | "info"; message: string }>;
  contactTab: "info" | "media" | "files" | "links";
  mobilePane: "list" | "chat" | "profile";
  init: () => Promise<void>;
  loadChats: () => Promise<void>;
  loadMessages: (chatId: string) => Promise<void>;
  setNav: (id: NavId) => void;
  setFilter: (f: Filter) => void;
  setQuery: (q: string) => void;
  selectChat: (id: string) => void;
  selectAccount: (id: string) => void;
  setComposer: (v: string) => void;
  sendComposer: () => Promise<void>;
  openOverlay: (o: Overlay, extra?: string) => void;
  closeOverlay: () => void;
  createSession: (id: string, webhook?: string, proxy?: string) => Promise<void>;
  /** Save (or clear, with null) the proxy a session connects through. Resolves true on success. */
  setProxy: (sessionId: string, proxy: string | null) => Promise<boolean>;
  /** Fetch the egress IP through a proxy URL without saving it. */
  testProxy: (proxy: string) => Promise<{ ok: boolean; message: string; ip?: string; latencyMs?: number }>;
  refreshSessions: () => Promise<void>;
  reconnect: (id: string) => Promise<void>;
  removeSession: (id: string) => Promise<void>;
  refreshQr: (id: string) => Promise<void>;
  watchQrSession: (id: string) => void;
  addHook: (url: string, events: string[]) => Promise<void>;
  removeHook: (url: string) => Promise<void>;
  setBulkSession: (id: string) => void;
  loadBulkJobs: () => Promise<void>;
  startBulk: (input: Omit<StartBulkInput, "sessionId"> & { sessionId?: string }) => Promise<string | null>;
  cancelBulk: (jobId: string) => Promise<void>;
  retryBulk: (jobId: string) => Promise<void>;
  applyTemplate: (body: string) => void;
  pushToast: (type: "success" | "error" | "info", message: string) => void;
  dismissToast: (id: string) => void;
  pushEvent: (type: GatewayEvent["type"], content: string) => void;
  clearEvents: () => void;
  runApi: (method: string, path: string, body: string) => Promise<unknown>;
  login: (user: string, pass: string, key?: string) => Promise<boolean>;
  logout: () => void;
  setApiKey: (k: string) => void;
  setContactTab: (t: State["contactTab"]) => void;
  setMobilePane: (p: State["mobilePane"]) => void;
};

function nid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Poll interval that watches a pairing session while the QR modal is open. */
let qrWatchTimer: ReturnType<typeof setInterval> | null = null;

/** Poll interval that refreshes campaign progress while any job is still sending. */
let bulkWatchTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Which session a campaign should go out from: the account picked in the rail
 * if it can send, else the first connected one, else whatever exists.
 */
export function pickBulkSession(sessions: GatewaySession[], preferred: string): GatewaySession | undefined {
  const chosen = sessions.find((s) => s.sessionId === preferred);
  if (chosen?.status === "connected") return chosen;
  return sessions.find((s) => s.status === "connected") ?? chosen ?? sessions[0];
}

export const useGateway = create<State>((set, get) => ({
  live: false,
  user: typeof sessionStorage !== "undefined" ? (sessionStorage.getItem("dashboard_user") ?? "") : "",
  apiKey: typeof window !== "undefined" ? sessionStorage.getItem("api_key") || "" : "",
  wsConnected: false,
  wsClients: 0,
  sessions: [],
  events: [],
  chats: [],
  threads: {},
  activeChatId: "",
  activeAccountId: "",
  nav: "chats",
  filter: "all",
  query: "",
  overlay: null,
  qrSession: "",
  qrSrc: "",
  qrExpiresAt: null,
  webhookSessionId: "",
  proxySessionId: "",
  composer: "",
  bulkSessionId: "",
  bulkJobs: [],
  bulkLoading: false,
  toasts: [],
  contactTab: "info",
  mobilePane: "list",

  init: async () => {
    try {
      const result = await listSessions();
      if (result.success && Array.isArray(result.data)) {
        set({ live: true, sessions: result.data, wsConnected: true });
        get().pushEvent("connection", "Connected to live gateway");
        await get().loadChats();
      } else {
        // A reachable gateway that still says no: keep the seeded UI, say why.
        set({ live: false, wsConnected: false });
        get().pushEvent("error", result.message ?? "Gateway returned no sessions");
      }
    } catch {
      set({ live: false, wsConnected: false });
      get().pushEvent("error", "Gateway not reachable");
    }
    try {
      const stats = await loadWsStats();
      if (stats.success) set({ wsClients: stats.data?.totalConnections ?? 0 });
    } catch {
      set({ wsClients: 1 });
    }
  },

  /**
   * Load the account's conversations. Only a *connected* session has history,
   * so anything else leaves the list empty and states the reason — the panes
   * render an explicit empty state rather than pretending to hold data.
   */
  loadChats: async () => {
    const session = get().sessions.find((s) => s.status === "connected");
    if (!session) {
      set({ chats: [], threads: {}, activeChatId: "" });
      get().pushEvent("connection", "No connected session — scan the QR to load chats.");
      return;
    }
    try {
      const result = await listChats(session.sessionId);
      if (!result.success || !result.data) {
        get().pushEvent("error", result.message ?? "Could not load chats");
        return;
      }
      const chats = result.data.chats.map(toChatPreview);
      if (chats.length === 0) {
        set({ chats: [], threads: {}, activeChatId: "" });
        get().pushEvent("connection", "Connected — no chat history on this account yet.");
        return;
      }
      set((s) => ({ chats, activeChatId: chats.some((c) => c.id === s.activeChatId) ? s.activeChatId : chats[0].id }));
      get().pushEvent("connection", `Loaded ${chats.length} real chats`);
      await get().loadMessages(get().activeChatId);
    } catch {
      get().pushEvent("error", "Could not load chats");
    }
  },

  /** Load one conversation's history into `threads` on demand. */
  loadMessages: async (chatId) => {
    const { live, sessions } = get();
    if (!live || !chatId) return;
    const session = sessions.find((s) => s.status === "connected");
    if (!session) return;
    try {
      const result = await listMessages(session.sessionId, chatId);
      if (!result.success || !result.data) return;
      // Backend returns newest-first; the bubble list renders oldest at top.
      const bubbles = result.data.messages.map(toBubble).reverse();
      if (bubbles.length === 0) return;
      set((s) => ({ threads: { ...s.threads, [chatId]: bubbles } }));
    } catch {
      /* keep whatever is already on screen */
    }
  },

  setNav: (nav) => set({ nav }),
  setFilter: (filter) => set({ filter }),
  setQuery: (query) => set({ query }),
  selectChat: (id) => {
    set((s) => ({
      activeChatId: id,
      mobilePane: "chat",
      chats: s.chats.map((c) => (c.id === id ? { ...c, unread: 0 } : c)),
    }));
    // Fire-and-forget: opening a chat must not block on history.
    void get().loadMessages(id);
  },
  // The Broadcast panel follows the account picked in the rail.
  selectAccount: (id) => set((s) => (s.bulkSessionId === id ? { activeAccountId: id } : { activeAccountId: id, bulkSessionId: id, bulkJobs: [] })),
  setComposer: (composer) => set({ composer }),
  setContactTab: (contactTab) => set({ contactTab }),
  setMobilePane: (mobilePane) => set({ mobilePane }),

  sendComposer: async () => {
    const { composer, activeChatId, live, sessions, chats, pushToast, pushEvent } = get();
    const text = composer.trim();
    if (!text) return;
    const time = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const bubble: Bubble = { id: nid(), kind: "text", from: "me", text, time };
    set((s) => ({
      composer: "",
      threads: {
        ...s.threads,
        [activeChatId]: [...(s.threads[activeChatId] ?? []), bubble],
      },
      chats: s.chats.map((c) => (c.id === activeChatId ? { ...c, preview: text, time } : c)),
    }));
    pushEvent("message", `Sent: ${text.slice(0, 60)}`);
    if (live) {
      const session = sessions.find((x) => x.status === "connected") ?? sessions[0];
      const chat = chats.find((c) => c.id === activeChatId);
      try {
        await sendText({
          sessionId: session?.sessionId ?? "",
          chatId: chat?.phone?.replace(/\s/g, "") ?? activeChatId,
          message: text,
        });
      } catch {
        // Roll the optimistic bubble back — nothing was delivered.
        set((s) => ({
          threads: {
            ...s.threads,
            [activeChatId]: (s.threads[activeChatId] ?? []).filter((b) => b.id !== bubble.id),
          },
        }));
        pushToast("error", "Send failed — message not delivered");
        pushEvent("error", `Send failed: ${text.slice(0, 60)}`);
      }
    } else {
      set((s) => ({
        threads: {
          ...s.threads,
          [activeChatId]: (s.threads[activeChatId] ?? []).filter((b) => b.id !== bubble.id),
        },
      }));
      pushToast("error", "Not connected to the gateway");
    }
  },

  openOverlay: (overlay, extra) => {
    if (overlay === "qr") {
      set({ overlay, qrSession: extra ?? "" });
      if (extra) get().watchQrSession(extra);
    } else if (overlay === "webhooks") set({ overlay, webhookSessionId: extra ?? "" });
    else if (overlay === "proxy") set({ overlay, proxySessionId: extra ?? "" });
    else set({ overlay });
  },
  closeOverlay: () => {
    if (qrWatchTimer) {
      clearInterval(qrWatchTimer);
      qrWatchTimer = null;
    }
    set({ overlay: null, qrSrc: "", qrExpiresAt: null });
  },

  createSession: async (id, webhook, proxy) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      get().pushToast("error", "Invalid session ID");
      return;
    }
    if (!get().live) {
      get().pushToast("error", "Not connected to the gateway");
      return;
    }
    const body: Record<string, unknown> = {};
    if (webhook) body.webhooks = [{ url: webhook }];
    if (proxy) body.proxy = proxy;
    let result: Awaited<ReturnType<typeof connectSession>>;
    try {
      result = await connectSession(id, body);
    } catch {
      get().pushToast("error", "Gateway unreachable — session not created");
      return;
    }
    if (!result.success) {
      get().pushToast("error", result.message || "Failed to create session");
      return;
    }
    set((s) => ({
      sessions: [
        ...s.sessions,
        {
          sessionId: id,
          name: id,
          status: "qr_ready",
          webhooks: webhook ? [{ url: webhook }] : [],
          proxy: proxy ? proxy.replace(/:([^:@/]+)@/, ":***@") : null,
        },
      ],
      overlay: "qr",
      qrSession: id,
      qrSrc: "",
    }));
    get().pushEvent("connection", `Session ${id} created`);
    get().pushToast("success", "Scan QR to connect");
    await get().refreshQr(id);
    get().watchQrSession(id);
  },

  reconnect: async (id) => {
    try {
      if (get().live) await connectSession(id, {});
      get().pushToast("success", "Reconnecting…");
      get().openOverlay("qr", id);
      await get().refreshQr(id);
    } catch {
      get().pushToast("error", "Failed to reconnect");
    }
  },

  removeSession: async (id) => {
    try {
      if (get().live) await apiDeleteSession(id);
    } catch {
      /* already reported to the user via a toast */
    }
    set((s) => ({ sessions: s.sessions.filter((x) => x.sessionId !== id) }));
    get().pushToast("success", "Session deleted");
  },

  refreshQr: async (id) => {
    set({ qrSession: id, qrSrc: "" });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const result = await getQr(id);
        if (result.success && result.data?.qrCode) {
          set({
            qrSrc: result.data.qrCode,
            qrSession: id,
            qrExpiresAt: result.data.qrExpiresAt ?? null,
          });
          return;
        }
      } catch {
        /* Retry while the session is still generating its QR code. */
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  },

  /**
   * While the QR modal is open, poll the gateway: keep the QR image fresh as
   * the backend rotates it, and close the modal the moment pairing finishes
   * (connected) or is revoked (qr_expired). The dashboard has no push channel
   * to the backend, so this watcher is what closes the loop.
   */
  watchQrSession: (id) => {
    if (qrWatchTimer) clearInterval(qrWatchTimer);
    qrWatchTimer = setInterval(async () => {
      const { overlay, qrSession } = get();
      if (overlay !== "qr" || !qrSession || qrSession !== id) return;
      try {
        const [qr, list] = await Promise.all([getQr(qrSession), listSessions()]);
        if (qr.success && qr.data?.qrCode && qr.data.qrCode !== get().qrSrc) {
          set({ qrSrc: qr.data.qrCode });
        }
        if (qr.success && qr.data?.qrExpiresAt && qr.data.qrExpiresAt !== get().qrExpiresAt) {
          set({ qrExpiresAt: qr.data.qrExpiresAt });
        }
        const sessions = list.success && Array.isArray(list.data) ? list.data : undefined;
        const status = sessions?.find((s) => s.sessionId === qrSession)?.status;
        if (status === "connected") {
          get().closeOverlay();
          get().pushToast("success", "WhatsApp linked successfully");
          get().pushEvent("connection", `Session ${qrSession} connected`);
          await get().loadChats();
        } else if (status === "qr_expired") {
          set((s) => ({ sessions: sessions ?? s.sessions }));
          get().closeOverlay();
          get().pushToast("error", "QR expired — session revoked. Reconnect for a new QR.");
          get().pushEvent("error", `Session ${qrSession} QR expired`);
        } else if (sessions) {
          set({ sessions });
        }
      } catch {
        /* gateway hiccup — retry on the next tick */
      }
    }, 2000);
  },

  refreshSessions: async () => {
    if (!get().live) return;
    try {
      const result = await listSessions();
      if (result.success && Array.isArray(result.data)) set({ sessions: result.data });
    } catch {
      /* keep what we have */
    }
  },

  setProxy: async (sessionId, proxy) => {
    if (!get().live) {
      get().pushToast("error", "Not connected to the gateway");
      return false;
    }
    try {
      const result = await updateSessionConfig(sessionId, { proxy });
      if (!result.success || !result.data) {
        get().pushToast("error", result.message || "Could not save proxy");
        return false;
      }
      const saved = result.data.proxy;
      set((s) => ({
        sessions: s.sessions.map((sess) => (sess.sessionId === sessionId ? { ...sess, proxy: saved } : sess)),
      }));
      get().pushToast(result.data.proxyApplied ? "success" : "info", result.message || "Proxy saved");
      get().pushEvent("connection", `Session ${sessionId} proxy ${saved ? `set to ${saved}` : "removed"}`);
      // A live session restarts through the new proxy — pick up its status changes.
      if (result.data.proxyApplied) setTimeout(() => void get().refreshSessions(), 6000);
      return true;
    } catch {
      get().pushToast("error", "Gateway unreachable — proxy not saved");
      return false;
    }
  },

  testProxy: async (proxy) => {
    if (!get().live) return { ok: false, message: "Not connected to the gateway" };
    try {
      const result = await apiTestProxy({ proxy });
      const data = result.data;
      return {
        ok: Boolean(result.success && data?.ok),
        message: result.message || (data?.ok ? `Egress IP ${data.ip}` : data?.error || "Proxy check failed"),
        ip: data?.ip,
        latencyMs: data?.latencyMs,
      };
    } catch {
      return { ok: false, message: "Gateway unreachable" };
    }
  },

  addHook: async (url, events) => {
    const sid = get().webhookSessionId;
    try {
      if (get().live) await apiAddWebhook(sid, url, events);
    } catch {
      /* already reported to the user via a toast */
    }
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.sessionId === sid
          ? { ...sess, webhooks: [...(sess.webhooks ?? []), { url, events }] }
          : sess,
      ),
    }));
    get().pushToast("success", "Webhook added");
  },

  removeHook: async (url) => {
    const sid = get().webhookSessionId;
    try {
      if (get().live) await apiRemoveWebhook(sid, url);
    } catch {
      /* already reported to the user via a toast */
    }
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.sessionId === sid
          ? { ...sess, webhooks: (sess.webhooks ?? []).filter((w) => w.url !== url) }
          : sess,
      ),
    }));
    get().pushToast("success", "Webhook removed");
  },

  setBulkSession: (id) => {
    if (id === get().bulkSessionId) return;
    set({ bulkSessionId: id, bulkJobs: [] });
    void get().loadBulkJobs();
  },

  /**
   * Refresh the campaign list for `bulkSessionId` (falling back to the best
   * available session) and keep polling every 2s while any job is sending.
   */
  loadBulkJobs: async () => {
    const { live, sessions, bulkSessionId, activeAccountId } = get();
    if (!live) return;
    const session =
      sessions.find((s) => s.sessionId === bulkSessionId) ?? pickBulkSession(sessions, activeAccountId);
    if (!session) {
      set({ bulkJobs: [], bulkSessionId: "" });
      return;
    }
    if (session.sessionId !== bulkSessionId) set({ bulkSessionId: session.sessionId });
    set({ bulkLoading: true });
    try {
      const result = await listBulkJobs(session.sessionId);
      if (result.success && Array.isArray(result.data)) {
        const previous = get().bulkJobs;
        set({ bulkJobs: result.data });
        // Announce jobs that finished since the last poll.
        for (const job of result.data) {
          const before = previous.find((j) => j.jobId === job.jobId);
          if (before && before.status === "processing" && job.status !== "processing") {
            const label = job.name || `${job.type} campaign`;
            if (job.status === "completed") {
              get().pushToast(job.failed ? "info" : "success", `${label}: ${job.sent} sent, ${job.failed} failed`);
            } else {
              get().pushToast("error", `${label} ${job.status} — ${job.sent}/${job.total} sent`);
            }
            get().pushEvent("message", `Campaign ${job.jobId} ${job.status}: ${job.sent} sent, ${job.failed} failed`);
          }
        }
      } else if (!result.success) {
        get().pushEvent("error", result.message ?? "Could not load campaigns");
      }
    } catch {
      get().pushEvent("error", "Could not load campaigns");
    } finally {
      set({ bulkLoading: false });
    }

    const running = get().bulkJobs.some((j) => j.status === "processing");
    if (running && !bulkWatchTimer) {
      bulkWatchTimer = setInterval(() => void get().loadBulkJobs(), 2000);
    } else if (!running && bulkWatchTimer) {
      clearInterval(bulkWatchTimer);
      bulkWatchTimer = null;
    }
  },

  /** Start a campaign. Resolves with the jobId, or null when nothing was queued. */
  startBulk: async (input) => {
    const { live, sessions, activeAccountId, pushToast, pushEvent } = get();
    if (!live) {
      pushToast("error", "Not connected to the gateway");
      return null;
    }
    const session = input.sessionId
      ? sessions.find((s) => s.sessionId === input.sessionId)
      : pickBulkSession(sessions, activeAccountId);
    if (!session || session.status !== "connected") {
      pushToast("error", "Pick a connected session to send from");
      return null;
    }
    try {
      const result = await startBulkJob({ ...input, sessionId: session.sessionId });
      if (!result.success || !result.data) {
        pushToast("error", result.message || "Could not start campaign");
        return null;
      }
      pushEvent("message", `Campaign ${result.data.jobId} started: ${result.data.total} recipients`);
      pushToast("success", `Sending to ${result.data.total} recipients`);
      set({ overlay: null, nav: "broadcast", bulkSessionId: session.sessionId });
      await get().loadBulkJobs();
      return result.data.jobId;
    } catch {
      pushToast("error", "Gateway unreachable — campaign not started");
      return null;
    }
  },

  cancelBulk: async (jobId) => {
    try {
      const result = await cancelBulkJob(jobId);
      if (!result.success) {
        get().pushToast("error", result.message || "Could not cancel");
      } else {
        get().pushToast("info", "Stopping after the current message…");
        get().pushEvent("message", `Campaign ${jobId} cancel requested`);
      }
    } catch {
      get().pushToast("error", "Gateway unreachable — could not cancel");
    }
    await get().loadBulkJobs();
  },

  retryBulk: async (jobId) => {
    const sid = get().bulkSessionId;
    const session = get().sessions.find((s) => s.sessionId === sid);
    if (!session || session.status !== "connected") {
      get().pushToast("error", "Session must be connected to retry");
      return;
    }
    try {
      const result = await retryBulkJob(sid, jobId);
      if (!result.success || !result.data) {
        get().pushToast("error", result.message || "Could not retry");
        return;
      }
      get().pushToast("success", `Retrying ${result.data.total} recipient(s)`);
      get().pushEvent("message", `Campaign ${result.data.jobId} retries ${jobId}`);
    } catch {
      get().pushToast("error", "Gateway unreachable — could not retry");
    }
    await get().loadBulkJobs();
  },

  applyTemplate: (body) => set({ composer: body, overlay: null }),

  pushToast: (type, message) => {
    const id = nid();
    set((s) => ({ toasts: [...s.toasts, { id, type, message }] }));
    setTimeout(() => get().dismissToast(id), 3800);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  pushEvent: (type, content) =>
    set((s) => ({
      events: [{ id: nid(), time: new Date().toLocaleTimeString(), type, content }, ...s.events].slice(0, 100),
    })),
  clearEvents: () => set({ events: [] }),

  runApi: async (method, path, body) => {
    try {
      const result = await sendRawApi(method, path, body);
      get().pushEvent("connection", `${method} ${path}`);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      get().pushEvent("error", `${method} ${path} failed: ${message}`);
      return { success: false, method, path, message };
    }
  },

  login: async (user, pass, key) => {
    try {
      const data = await loginDashboard(user, pass);
      if (data.success) {
        sessionStorage.setItem("dashboard_auth", "authenticated");
        sessionStorage.setItem("dashboard_user", user);
        set({ user });
        if (key) {
          sessionStorage.setItem("api_key", key);
          set({ apiKey: key, live: true });
        }
        get().pushToast("success", "Logged in");
        await get().init();
        return true;
      }
      get().pushToast("error", data.message || "Login failed");
      return false;
    } catch {
      get().pushToast("error", "Gateway unreachable — could not sign in");
      return false;
    }
  },

  logout: () => {
    sessionStorage.removeItem("dashboard_auth");
    sessionStorage.removeItem("api_key");
    sessionStorage.removeItem("dashboard_user");
    set({ apiKey: "", user: "", live: false });
    get().pushToast("success", "Logged out");
  },

  setApiKey: (k) => {
    sessionStorage.setItem("api_key", k);
    set({ apiKey: k });
  },
}));
