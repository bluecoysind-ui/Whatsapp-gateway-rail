import { create } from "zustand";
import type { Bubble, ChatPreview } from "@/lib/gateway-types";
import {
  addWebhook as apiAddWebhook,
  connectSession,
  deleteSession as apiDeleteSession,
  getQr,
  listChats,
  listMessages,
  listSessions,
  loadWsStats,
  loginDashboard,
  removeWebhook as apiRemoveWebhook,
  sendBulk,
  sendRawApi,
  sendText,
  type GatewayChat,
  type GatewayEvent,
  type GatewayMessage,
  type GatewaySession,
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
type Overlay = null | "qr" | "create-session" | "webhooks" | "bulk" | "templates" | "search";

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
  composer: string;
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
  createSession: (id: string, webhook?: string) => Promise<void>;
  reconnect: (id: string) => Promise<void>;
  removeSession: (id: string) => Promise<void>;
  refreshQr: (id: string) => Promise<void>;
  watchQrSession: (id: string) => void;
  addHook: (url: string, events: string[]) => Promise<void>;
  removeHook: (url: string) => Promise<void>;
  bulkSend: (recipients: string[], message: string) => Promise<void>;
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
  composer: "",
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
  selectAccount: (id) => set({ activeAccountId: id }),
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
    else set({ overlay });
  },
  closeOverlay: () => {
    if (qrWatchTimer) {
      clearInterval(qrWatchTimer);
      qrWatchTimer = null;
    }
    set({ overlay: null, qrSrc: "", qrExpiresAt: null });
  },

  createSession: async (id, webhook) => {
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
    const result = await connectSession(id, body);
    if (!result.success) {
      get().pushToast("error", result.message || "Failed to create session");
      return;
    }
    set((s) => ({
      sessions: [
        ...s.sessions,
        { sessionId: id, name: id, status: "qr_ready", webhooks: webhook ? [{ url: webhook }] : [] },
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

  bulkSend: async (recipients, message) => {
    const session = get().sessions.find((s) => s.status === "connected") ?? get().sessions[0];
    try {
      if (get().live && session) {
        await sendBulk({ sessionId: session.sessionId, recipients, message, delay: 1000 });
      }
    } catch {
      /* already reported to the user via a toast */
    }
    get().pushEvent("message", `Bulk to ${recipients.length} chats: ${message.slice(0, 40)}`);
    get().pushToast("success", `Queued for ${recipients.length} chats`);
    set({ overlay: null });
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
