import { useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Bubble, BubbleMedia, ChatPreview } from "@/lib/gateway-types";
import { type GatewaySession } from "@/lib/gateway-client";
import { cn } from "@/lib/cn";
import { useGateway } from "@/store/gateway-store";
import { Overlays, Toasts, ToolsPanel } from "./Overlays";
import { BroadcastPanel } from "./Broadcast";
import Aurora from "./Aurora";
import {
  IconBell,
  IconChat,
  IconDots,
  IconGear,
  IconPhone,
  IconSearch,
  IconSend,
  IconSun,
  IconTools,
  IconUsers,
  IconVideo,
  IconWA,
} from "./icons";

export function GatewayApp() {
  const init = useGateway((s) => s.init);
  const openOverlay = useGateway((s) => s.openOverlay);
  useEffect(() => {
    void init();
  }, [init]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openOverlay("search");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openOverlay]);

  return (
    <div className="relative h-dvh overflow-hidden text-ink">
      <div className="app-bg">
        <Aurora colorStops={["#f8a66d", "#B497CF", "#5227FF"]} blend={0.5} amplitude={1} speed={0.5} />
      </div>
      <div className="relative z-10 flex h-full flex-col p-3 sm:p-4">
        <Header />
        <div className="mt-3 flex min-h-0 flex-1 gap-3">
          <AccountsRail />
          <MainStage />
        </div>
        <MobileDock />
      </div>
      <Overlays />
      <Toasts />
    </div>
  );
}

function IconBtn({
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return (
    <button
      type="button"
      className={cn(
        "relative grid size-9 place-items-center rounded-[10px] border border-line bg-white/5 text-ink/80 hover:bg-white/10",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

function Header() {
  const user = useGateway((s) => s.user);
  const live = useGateway((s) => s.live);
  const wsConnected = useGateway((s) => s.wsConnected);
  const openOverlay = useGateway((s) => s.openOverlay);
  return (
    <header className="glass flex h-16 shrink-0 items-center gap-3 overflow-hidden rounded-2xl px-3 sm:px-4">
      <div className="flex min-w-0 shrink-0 items-center gap-2.5">
        <div className="size-9 overflow-hidden rounded-[10px] bg-white shadow-[0_4px_12px_rgba(37,211,102,0.35)]">
          <img src="/__grok/logo.png" alt="WA Gateway" className="size-full object-cover" />
        </div>
        <div className="leading-tight">
          <div className="text-[15px] font-semibold tracking-tight">WA Gateway</div>
          <div className="hidden text-[11px] text-muted sm:block">Multi-account Control Center</div>
        </div>
      </div>
      <button
        onClick={() => openOverlay("search")}
        className="mx-2 hidden h-10 min-w-0 flex-1 items-center gap-2 rounded-xl border border-line bg-white/5 px-3 text-sm text-dim lg:flex"
      >
        <IconSearch />
        <span className="min-w-0 flex-1 truncate text-left">Search messages, contacts, groups...</span>
        <kbd className="shrink-0 rounded-md border border-line bg-white/5 px-1.5 py-0.5 text-[10px] text-muted">Ctrl K</kbd>
      </button>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <span className="hidden items-center gap-2 rounded-full border border-line bg-night/40 px-3 py-1.5 text-[11px] text-muted xl:flex">
          <span className={cn("size-2 rounded-full", wsConnected || live ? "bg-wa shadow-[0_0_8px_#25d366]" : "bg-danger")} />
          {live ? "Live API" : "Offline"}
        </span>
        <IconBtn className="lg:hidden" onClick={() => openOverlay("search")}>
          <IconSearch />
        </IconBtn>
        <IconBtn>
          <IconBell />
          <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-danger" />
        </IconBtn>
        <IconBtn className="hidden sm:grid">
          <IconSun />
        </IconBtn>
        <div className="flex items-center gap-2 rounded-full border border-line bg-white/5 py-1 pr-2 pl-1 sm:pr-3">
          <div className="grid size-7 place-items-center rounded-full bg-gradient-to-br from-indigo to-violet text-[11px] font-semibold">
            {(user || "?").slice(0, 1).toUpperCase()}
          </div>
          <div className="hidden leading-tight md:block">
            <div className="text-[12px] font-medium">{user || "Not signed in"}</div>
            <div className="text-[10px] text-muted">{user ? "Dashboard user" : "Sign in to manage"}</div>
          </div>
        </div>
      </div>
    </header>
  );
}

function MobileDock() {
  const nav = useGateway((s) => s.nav);
  const setNav = useGateway((s) => s.setNav);
  const items = [
    { id: "chats" as const, label: "Chats", icon: <IconChat /> },
    { id: "tools" as const, label: "Tools", icon: <IconTools /> },
    { id: "settings" as const, label: "Settings", icon: <IconGear /> },
  ];
  return (
    <nav className="glass mt-3 flex shrink-0 items-center justify-around rounded-2xl py-2 md:hidden">
      {items.map((item) => (
        <button
          key={item.id}
          onClick={() => setNav(item.id)}
          className={cn(
            "flex min-h-11 min-w-11 flex-col items-center gap-0.5 text-[10px]",
            nav === item.id ? "text-indigo" : "text-muted",
          )}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </nav>
  );
}

function AccountsRail() {
  const nav = useGateway((s) => s.nav);
  const setNav = useGateway((s) => s.setNav);
  const sessions = useGateway((s) => s.sessions);
  const activeAccountId = useGateway((s) => s.activeAccountId);
  const selectAccount = useGateway((s) => s.selectAccount);
  const openOverlay = useGateway((s) => s.openOverlay);
  const online = sessions.filter((s) => s.status === "connected").length;
  const [peek, setPeek] = useState<{
    label: string;
    phone?: string;
    proxy?: string | null;
    status: string;
    connected: boolean;
    x: number;
    y: number;
  } | null>(null);
  const showPeek = (target: HTMLElement, a: GatewaySession) => {
    const r = target.getBoundingClientRect();
    setPeek({
      label: a.name || a.sessionId,
      phone: a.phoneNumber,
      proxy: a.proxy,
      status: a.status,
      connected: a.status === "connected",
      x: r.right,
      y: r.top + r.height / 2,
    });
  };
  const items = [
    { id: "tools" as const, label: "Tools", icon: <IconTools /> },
    { id: "settings" as const, label: "Settings", icon: <IconGear /> },
  ];
  return (
    <aside className="glass relative z-40 hidden min-h-0 w-[76px] shrink-0 flex-col items-center overflow-hidden rounded-2xl py-4 md:flex">
      <div className="text-[9px] font-semibold tracking-[0.12em] text-muted">ACCOUNTS</div>
      <div className="text-lg font-bold leading-none">{sessions.length}</div>
      <div className="mb-3 text-[10px] text-wa">{online} online</div>
      <div className="scroll-thin flex min-h-0 w-full flex-1 flex-col items-center gap-2 overflow-y-auto overscroll-contain pr-0.5">
        {sessions.map((a) => {
          const label = a.name || a.sessionId;
          const connected = a.status === "connected";
          return (
            <div key={a.sessionId} className="group relative">
              <button
                onClick={() => {
                  selectAccount(a.sessionId);
                  setNav("chats");
                }}
                aria-label={`${label}, ${a.phoneNumber ?? "not linked"}`}
                onMouseEnter={(e) => showPeek(e.currentTarget, a)}
                onMouseLeave={() => setPeek(null)}
                onFocus={(e) => showPeek(e.currentTarget, a)}
                onBlur={() => setPeek(null)}
                className={cn(
                  "relative size-11 overflow-hidden rounded-2xl border-2",
                  activeAccountId === a.sessionId
                    ? "border-indigo shadow-[0_0_0_2px_rgba(99,102,241,0.25)]"
                    : "border-transparent",
                )}
              >
                <span className="grid size-full place-items-center bg-gradient-to-br from-indigo-500 to-violet-500 text-sm font-semibold">
                  {label.slice(0, 2).toUpperCase()}
                </span>
                {connected ? (
                  <span className="absolute right-0.5 bottom-0.5 size-2.5 rounded-full border-2 border-night bg-wa" />
                ) : null}
              </button>
            </div>
          );
        })}
      </div>
      <button
        onClick={() => openOverlay("create-session")}
        title="Add account"
        className="mt-2 grid size-11 shrink-0 place-items-center rounded-2xl border border-dashed border-white/20 text-xl text-muted"
      >
        +
      </button>
      <nav className="mt-auto flex shrink-0 flex-col gap-1">
        {items.map((item) => (
          <button
            key={item.id}
            onClick={() => setNav(item.id)}
            title={item.label}
            className={cn(
              "grid size-11 shrink-0 place-items-center rounded-xl text-muted",
              nav === item.id && "bg-indigo/25 text-indigo",
            )}
          >
            {item.icon}
          </button>
        ))}
      </nav>
      {peek
        ? createPortal(
            <div
              style={{ left: peek.x + 12, top: peek.y }}
              className="pointer-events-none fixed z-50 w-44 -translate-y-1/2 rounded-xl border border-white/15 bg-[rgba(24,20,58,0.82)] p-3 text-left shadow-[0_12px_30px_rgba(8,4,28,0.45)] backdrop-blur-xl"
            >
              <div className="truncate text-sm font-semibold text-white">{peek.label}</div>
              <div className="mt-1 truncate text-xs text-cyan-200">{peek.phone ?? "Not linked"}</div>
              {peek.proxy ? <div className="mt-0.5 truncate font-mono text-[10px] text-indigo-200">via {peek.proxy}</div> : null}
              <div className="mt-2 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.12em] text-wa">
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    peek.connected ? "bg-wa shadow-[0_0_8px_#25d366]" : "bg-white/30",
                  )}
                />
                {peek.status}
              </div>
            </div>,
            document.body,
          )
        : null}
    </aside>
  );
}

function MainStage() {
  const nav = useGateway((s) => s.nav);
  const mobilePane = useGateway((s) => s.mobilePane);
  if (nav === "tools" || nav === "settings") {
    return (
      <div className="glass scroll-thin min-w-0 flex-1 overflow-auto rounded-2xl p-4">
        <h2 className="mb-4 text-base font-semibold">{nav === "tools" ? "Gateway Tools" : "Settings"}</h2>
        <ToolsPanel />
      </div>
    );
  }
  if (nav === "contacts") return <Directory title="Contacts" kind="dm" />;
  if (nav === "groups") return <Directory title="Groups" kind="group" />;
  if (nav === "broadcast") return <BroadcastPanel />;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 gap-3">
      <div className={cn("h-full w-full max-w-[320px] shrink-0", mobilePane !== "list" && "hidden lg:block")}>
        <ChatList />
      </div>
      <div className={cn("flex h-full min-h-0 min-w-0 flex-1", mobilePane === "list" && "hidden lg:flex")}>
        <Conversation />
      </div>
      <div className={cn("h-full w-[280px] shrink-0", mobilePane !== "profile" && "hidden xl:block")}>
        <ContactPanel />
      </div>
    </div>
  );
}

function Directory({ title, kind }: { title: string; kind: "dm" | "group" }) {
  const chats = useGateway((s) => s.chats);
  const select = useGateway((s) => s.selectChat);
  const setNav = useGateway((s) => s.setNav);
  return (
    <div className="glass scroll-thin min-w-0 flex-1 overflow-auto rounded-2xl p-4">
      <h2 className="mb-4 text-base font-semibold">{title}</h2>
      {chats.filter((c) => c.kind === kind).length === 0 ? (
        <EmptyState>
          {kind === "group" ? "No groups yet." : "No contacts yet."} Connect a session to load them.
        </EmptyState>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {chats
          .filter((c) => c.kind === kind)
          .map((c) => (
            <button
              key={c.id}
              className="flex items-center gap-3 rounded-2xl border border-line bg-night/30 p-3 text-left"
              onClick={() => {
                select(c.id);
                setNav("chats");
              }}
            >
              <ChatAvatar chat={c} />
              <div>
                <div className="text-sm font-medium">{c.name}</div>
                <div className="text-xs text-muted">{c.phone || c.preview}</div>
              </div>
            </button>
          ))}
      </div>
    </div>
  );
}

/** Neutral placeholder for a pane with nothing to show. */
function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-10 text-center text-[12.5px] text-muted">{children}</div>;
}

/** Why the chat list is empty: no search hit, or no data at all. */
function emptyChatsMessage(total: number, query: string): string {
  if (total > 0) return query ? `No chats match "${query}".` : "No chats match this filter.";
  return "No chats yet. Connect a session and scan the QR to load your conversations.";
}

function ChatList() {
  const chats = useGateway((s) => s.chats);
  const chatsHasMore = useGateway((s) => s.chatsHasMore);
  const chatsLoading = useGateway((s) => s.chatsLoading);
  const loadMoreChats = useGateway((s) => s.loadMoreChats);
  const filter = useGateway((s) => s.filter);
  const setFilter = useGateway((s) => s.setFilter);
  const active = useGateway((s) => s.activeChatId);
  const select = useGateway((s) => s.selectChat);
  const query = useGateway((s) => s.query);
  const account = useGateway((s) => s.sessions.find((x) => x.sessionId === s.activeAccountId));
  const filtered = useMemo(() => {
    return chats.filter((c) => {
      if (filter === "unread" && c.unread === 0) return false;
      if (filter === "groups" && c.kind !== "group") return false;
      if (query && !`${c.name} ${c.preview}`.toLowerCase().includes(query.toLowerCase())) return false;
      return true;
    });
  }, [chats, filter, query]);
  return (
    <section className="glass flex h-full flex-col rounded-2xl">
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1 text-[16px] font-semibold">All Chats</div>
          {account ? (
            <div className="truncate text-[11px] text-muted">
              {account.name || account.sessionId}
              {account.phoneNumber ? ` · ${account.phoneNumber}` : ""}
              {account.status !== "connected" ? ` · ${account.status}` : ""}
            </div>
          ) : null}
        </div>
        <IconBtn className="size-8">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
        </IconBtn>
      </div>
      <div className="flex items-center gap-1.5 px-4 pb-3">
        <FilterChip active={filter === "all"} onClick={() => setFilter("all")} count={chats.length}>
          All
        </FilterChip>
        <FilterChip
          active={filter === "unread"}
          onClick={() => setFilter("unread")}
          count={chats.filter((c) => c.unread > 0).length}
        >
          Unread
        </FilterChip>
        <FilterChip
          active={filter === "groups"}
          onClick={() => setFilter("groups")}
          count={chats.filter((c) => c.kind === "group").length}
        >
          Groups
        </FilterChip>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {filtered.length === 0 ? <EmptyState>{emptyChatsMessage(chats.length, query)}</EmptyState> : null}
        {filtered.map((c) => (
          <button
            key={c.id}
            onClick={() => select(c.id)}
            className={cn(
              "mb-0.5 flex w-full items-center gap-3 rounded-2xl px-2.5 py-2.5 text-left",
              active === c.id ? "bg-indigo/20" : "hover:bg-white/5",
            )}
          >
            <ChatAvatar chat={c} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[13.5px] font-medium">{c.name}</span>
                <span className="shrink-0 text-[11px] text-dim">{c.time}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[12.5px] text-muted">{c.preview}</span>
                {c.unread > 0 ? (
                  <span className="grid min-w-[18px] place-items-center rounded-full bg-indigo px-1.5 text-[11px] font-semibold">
                    {c.unread}
                  </span>
                ) : null}
              </div>
            </div>
          </button>
        ))}
        {chatsHasMore && !query && filter === "all" ? (
          <button
            type="button"
            disabled={chatsLoading}
            onClick={() => void loadMoreChats()}
            className="mt-1 w-full rounded-xl border border-line py-2 text-xs text-muted hover:text-ink disabled:opacity-50"
          >
            {chatsLoading ? "Loading…" : "Load more chats"}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function FilterChip({
  active,
  count,
  children,
  onClick,
}: {
  active?: boolean;
  count: number;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium",
        active
          ? "bg-gradient-to-r from-indigo to-violet text-white shadow-[0_2px_8px_rgba(99,102,241,0.35)]"
          : "bg-white/5 text-muted",
      )}
    >
      {children}
      <span className={cn("rounded-full px-1.5 text-[10px]", active ? "bg-white/20" : "bg-white/10")}>{count}</span>
    </button>
  );
}

function ChatAvatar({ chat, size = 44 }: { chat: ChatPreview; size?: number }) {
  const iconMap: Record<string, string> = {
    users: "👥",
    code: "</>",
    chart: "📊",
    headset: "🎧",
    palette: "🎨",
    support: "BC",
  };
  return (
    <div className="relative shrink-0 overflow-hidden rounded-full bg-white/10" style={{ width: size, height: size }}>
      {chat.avatar === "photo" && chat.photo ? (
        <img src={chat.photo} alt="" className="size-full object-cover" />
      ) : chat.avatar === "initials" ? (
        <span className="grid size-full place-items-center bg-gradient-to-br from-blue-500 to-indigo-700 text-[13px] font-bold">
          {chat.initials}
        </span>
      ) : (
        <span className="grid size-full place-items-center bg-gradient-to-br from-indigo to-violet text-sm">
          {iconMap[chat.icon ?? "users"]}
        </span>
      )}
      {chat.online ? <span className="absolute right-0 bottom-0 size-2.5 rounded-full border-2 border-[#12102a] bg-wa" /> : null}
    </div>
  );
}

function Conversation() {
  const chats = useGateway((s) => s.chats);
  const threads = useGateway((s) => s.threads);
  const id = useGateway((s) => s.activeChatId);
  const meta = useGateway((s) => s.threadMeta[s.activeChatId]);
  const loadOlder = useGateway((s) => s.loadOlderMessages);
  const composer = useGateway((s) => s.composer);
  const setComposer = useGateway((s) => s.setComposer);
  const send = useGateway((s) => s.sendComposer);
  const sendAttachment = useGateway((s) => s.sendAttachment);
  const setMobilePane = useGateway((s) => s.setMobilePane);
  const openOverlay = useGateway((s) => s.openOverlay);
  const chat = chats.find((c) => c.id === id);
  const messages = threads[id] ?? [];
  const [attachment, setAttachment] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const lastId = messages.length ? messages[messages.length - 1].id : "";

  // Stick to the bottom when a new message lands; leave the scroll alone when
  // older pages are prepended.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [id, lastId]);

  const submit = async () => {
    if (attachment) {
      setSending(true);
      const ok = await sendAttachment(attachment, composer.trim());
      setSending(false);
      if (ok) setAttachment(null);
      return;
    }
    await send();
  };
  if (!chat) {
    return (
      <section className="glass flex h-full min-w-0 flex-1 items-center justify-center rounded-2xl">
        <EmptyState>Select a chat to open the conversation.</EmptyState>
      </section>
    );
  }
  return (
    <section className="glass flex h-full min-w-0 flex-1 flex-col rounded-2xl">
      <div className="flex h-[68px] items-center gap-3 border-b border-line px-4">
        <button className="text-muted lg:hidden" onClick={() => setMobilePane("list")}>
          ←
        </button>
        <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => setMobilePane("profile")}>
          <ChatAvatar chat={chat} />
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold">{chat.name}</div>
            <div className="text-xs text-wa">{chat.online ? "online" : chat.lastSeen || "offline"}</div>
          </div>
        </button>
        <IconBtn onClick={() => openOverlay("search")}>
          <IconSearch />
        </IconBtn>
        <IconBtn>
          <IconPhone />
        </IconBtn>
        <IconBtn>
          <IconVideo />
        </IconBtn>
        <IconBtn>
          <IconDots />
        </IconBtn>
      </div>
      <div ref={scroller} className="chat-wallpaper scroll-thin flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-6 py-5">
        {meta?.hasMore ? (
          <button
            type="button"
            disabled={meta.loading}
            onClick={() => void loadOlder(id)}
            className="self-center rounded-full border border-line bg-white/8 px-3.5 py-1 text-[11.5px] text-muted hover:text-ink disabled:opacity-50"
          >
            {meta.loading ? "Loading…" : "Load older messages"}
          </button>
        ) : messages.length > 0 ? (
          <div className="self-center rounded-full bg-white/8 px-3.5 py-1 text-[11.5px] text-muted">
            {meta?.loading ? "Loading…" : "Beginning of history"}
          </div>
        ) : (
          <EmptyState>{meta?.loading ? "Loading messages…" : "No messages in this chat yet."}</EmptyState>
        )}
        {messages.map((m) => (m.kind === "promo" ? <PromoCard key={m.id} time={m.time} /> : <MessageBubble key={m.id} chatId={id} m={m} />))}
      </div>
      <form
        className="border-t border-line px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {attachment ? (
          <div className="mb-2 flex items-center gap-3 rounded-xl border border-line bg-white/5 px-3 py-2 text-[12.5px]">
            <span className="text-lg">{attachment.type.startsWith("image/") ? "🖼️" : attachment.type.startsWith("video/") ? "🎬" : attachment.type.startsWith("audio/") ? "🎵" : "📄"}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{attachment.name}</div>
              <div className="text-[11px] text-muted">
                {fmtBytes(attachment.size)} · {attachment.type || "file"} — add a caption below, then send
              </div>
            </div>
            <button type="button" className="text-xs text-danger" onClick={() => setAttachment(null)}>
              Remove
            </button>
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            hidden
            accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) setAttachment(f);
              e.target.value = "";
            }}
          />
          <IconBtn type="button" title="Attach image, video, audio or document" onClick={() => fileInput.current?.click()}>
            📎
          </IconBtn>
          <input
            value={composer}
            onChange={(e) => setComposer(e.target.value)}
            placeholder={attachment ? "Caption (optional)…" : "Type a message..."}
            className="h-10 min-w-0 flex-1 rounded-xl border border-line bg-white/5 px-4 text-[13.5px] text-ink outline-none placeholder:text-dim"
          />
          <button
            type="submit"
            disabled={sending || (!attachment && !composer.trim())}
            className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-indigo to-violet text-white shadow-[0_4px_14px_rgba(99,102,241,0.4)] disabled:opacity-50"
          >
            {sending ? "…" : <IconSend />}
          </button>
        </div>
      </form>
    </section>
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function MessageBubble({ chatId, m }: { chatId: string; m: Extract<Bubble, { kind: "text" }> }) {
  const mine = m.from === "me";
  return (
    <div className={cn("flex max-w-[68%] flex-col", mine ? "self-end" : "self-start")}>
      <div
        className={cn(
          "overflow-hidden rounded-2xl text-[13.5px] leading-relaxed",
          mine ? "rounded-br-sm bg-gradient-to-br from-wa to-wa-deep text-white" : "rounded-bl-sm bg-bubble-in",
          m.pending && "opacity-70",
        )}
      >
        {m.sender ? <div className="px-3.5 pt-2 text-[11px] font-semibold text-indigo-200">{m.sender}</div> : null}
        {m.media ? <MediaView chatId={chatId} messageId={m.id} media={m.media} mine={mine} /> : null}
        {m.text ? <div className="px-3.5 py-2.5 whitespace-pre-wrap break-words">{m.text}</div> : null}
      </div>
      <div className={cn("mt-0.5 px-1 text-[10.5px] text-dim", mine && "text-right")}>
        {m.time}
        {mine ? (m.pending ? " ◌" : " ✓✓") : ""}
      </div>
    </div>
  );
}

/** Render an attachment inline, or offer to fetch it from WhatsApp when it is not on the server yet. */
function MediaView({ chatId, messageId, media, mine }: { chatId: string; messageId: string; media: BubbleMedia; mine: boolean }) {
  const loadMedia = useGateway((s) => s.loadMedia);
  const name = media.filename || `${media.type}-${messageId}`;
  const download = media.url ? (
    <a
      href={media.url}
      download={name}
      target="_blank"
      rel="noreferrer"
      className={cn("text-[11px] underline underline-offset-2", mine ? "text-white/90" : "text-indigo")}
    >
      Download
    </a>
  ) : null;

  if (!media.url) {
    const label = { image: "Photo", video: "Video", audio: "Audio", ptt: "Voice message", document: media.filename || "Document", sticker: "Sticker" }[media.type];
    return (
      <div className="flex items-center gap-3 px-3.5 py-2.5">
        <span className="text-lg">{{ image: "🖼️", video: "🎬", audio: "🎵", ptt: "🎤", document: "📄", sticker: "🏷️" }[media.type]}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px]">{label}</div>
          <button
            type="button"
            disabled={media.loading}
            onClick={() => void loadMedia(chatId, messageId)}
            className={cn("text-[11px] underline underline-offset-2 disabled:opacity-60", mine ? "text-white/90" : "text-indigo")}
          >
            {media.loading ? "Fetching from WhatsApp…" : "Load"}
          </button>
        </div>
      </div>
    );
  }

  if (media.type === "image" || media.type === "sticker") {
    return (
      <div>
        <a href={media.url} target="_blank" rel="noreferrer">
          <img src={media.url} alt={media.filename ?? ""} className={cn("block max-h-72 w-auto max-w-full object-contain", media.type === "sticker" ? "max-h-32 p-2" : "")} />
        </a>
        <div className="px-3.5 pt-1.5 pb-1">{download}</div>
      </div>
    );
  }
  if (media.type === "video") {
    return (
      <div>
        <video src={media.url} controls preload="metadata" className="block max-h-72 w-full" />
        <div className="px-3.5 pt-1.5 pb-1">{download}</div>
      </div>
    );
  }
  if (media.type === "audio" || media.type === "ptt") {
    return (
      <div className="px-3.5 py-2">
        <audio src={media.url} controls preload="metadata" className="w-64 max-w-full" />
        <div className="pt-1">{download}</div>
      </div>
    );
  }
  return (
    <a
      href={media.url}
      download={name}
      target="_blank"
      rel="noreferrer"
      className={cn("flex items-center gap-3 px-3.5 py-2.5 hover:bg-white/5", mine ? "text-white" : "")}
    >
      <span className="text-lg">📄</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium">{media.filename || "Document"}</span>
        <span className={cn("block text-[11px]", mine ? "text-white/80" : "text-muted")}>{media.mimetype || "file"} · click to download</span>
      </span>
    </a>
  );
}

function PromoCard({ time }: { time: string }) {
  return (
    <div className="max-w-[320px] self-start overflow-hidden rounded-2xl border border-line bg-gradient-to-br from-slate-900 to-indigo-950 p-4">
      <div className="flex items-center gap-3">
        <div>
          <div className="text-[15px] font-bold leading-snug">
            Grow
            <br />
            Your Business
            <br />
            with <span className="text-wa">WhatsApp</span>
          </div>
          <div className="mt-1 text-[11.5px] text-muted">Faster. Smarter. Together.</div>
        </div>
        <div className="grid size-12 shrink-0 place-items-center rounded-full bg-gradient-to-br from-wa to-wa-deep text-white shadow-[0_4px_16px_rgba(37,211,102,0.4)]">
          <IconWA />
        </div>
      </div>
      <div className="mt-1 text-right text-[10.5px] text-dim">{time}</div>
    </div>
  );
}

function ContactPanel() {
  const chats = useGateway((s) => s.chats);
  const id = useGateway((s) => s.activeChatId);
  const thread = useGateway((s) => s.threads[s.activeChatId]);
  const tab = useGateway((s) => s.contactTab);
  const setTab = useGateway((s) => s.setContactTab);
  const openOverlay = useGateway((s) => s.openOverlay);
  const chat = chats.find((c) => c.id === id);
  const attachments = useMemo(
    () =>
      (thread ?? [])
        .filter((b): b is Extract<Bubble, { kind: "text" }> => b.kind === "text" && Boolean(b.media))
        .reverse(),
    [thread],
  );
  if (!chat) return null;
  const visual = attachments.filter((b) => b.media && ["image", "video", "sticker"].includes(b.media.type));
  const files = attachments.filter((b) => b.media && ["document", "audio", "ptt"].includes(b.media.type));
  return (
    <aside className="glass scroll-thin flex h-full flex-col overflow-auto rounded-2xl p-5">
      <div className="text-center">
        <div className="relative mx-auto size-[72px] overflow-hidden rounded-full border-[3px] border-indigo/30">
          <ChatAvatar chat={chat} size={72} />
        </div>
        <div className="mt-2 text-[16px] font-semibold">{chat.name}</div>
        <div className="text-[12.5px] text-muted">{chat.phone || "Group conversation"}</div>
        <div className="text-[11.5px] text-dim">{chat.lastSeen || (chat.kind === "group" ? "8 participants" : "")}</div>
      </div>
      <div className="mt-4 flex justify-center gap-3">
        {[
          { icon: <IconPhone />, label: "Call" },
          { icon: <IconVideo />, label: "Video" },
          { icon: <IconSearch />, label: "Search", action: () => openOverlay("search") },
          { icon: <IconDots />, label: "More" },
        ].map((a) => (
          <button key={a.label} className="flex flex-col items-center gap-1" onClick={a.action}>
            <span className="grid size-10 place-items-center rounded-full border border-line bg-white/5">{a.icon}</span>
            <span className="text-[11px] text-muted">{a.label}</span>
          </button>
        ))}
      </div>
      <div className="mt-4 flex border-b border-line text-[12.5px]">
        {(["info", "media", "files", "links"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "flex-1 py-2 capitalize",
              tab === t ? "border-b-2 border-indigo font-medium text-indigo" : "text-dim",
            )}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "info" ? (
        <>
          <div className="mt-4 flex items-center gap-3 rounded-xl border border-wa/20 bg-wa/10 px-3 py-3">
            <span className="grid size-8 place-items-center rounded-lg bg-wa text-white">
              <IconWA width={16} height={16} />
            </span>
            <div className="text-[12.5px]">
              <div className="font-medium text-wa">Connected & online</div>
              <div className="text-[11px] text-muted">Using WhatsApp</div>
            </div>
          </div>
          <div className="mt-5 text-[12px] font-semibold tracking-wide text-muted uppercase">Quick Actions</div>
          <ActionRow icon={<IconSend />} color="bg-indigo/20 text-indigo" title="Send Message" sub="Send to this contact" onClick={() => {}} />
          <ActionRow icon={<IconUsers />} color="bg-wa/15 text-wa" title="Bulk Message" sub="Send to multiple chats" onClick={() => openOverlay("bulk")} />
          <ActionRow
            icon={<span className="text-sm">📄</span>}
            color="bg-violet/20 text-violet"
            title="Message Templates"
            sub="Use saved templates"
            onClick={() => openOverlay("templates")}
          />
          <button className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-danger/20 bg-danger/10 py-2.5 text-[13px] font-medium text-danger">
            Block Contact
          </button>
        </>
      ) : tab === "media" || tab === "files" ? (
        <AttachmentList chatId={id} items={tab === "media" ? visual : files} empty={`No ${tab} in the loaded history`} />
      ) : (
        <p className="mt-8 text-center text-sm text-muted">No {tab} yet</p>
      )}
    </aside>
  );
}

/** Attachments of the open conversation (what is loaded so far), newest first, each downloadable. */
function AttachmentList({ chatId, items, empty }: { chatId: string; items: Array<Extract<Bubble, { kind: "text" }>>; empty: string }) {
  const loadMedia = useGateway((s) => s.loadMedia);
  if (items.length === 0) return <p className="mt-8 text-center text-sm text-muted">{empty}</p>;
  return (
    <div className="mt-3 space-y-1.5">
      {items.map((b) => {
        const media = b.media!;
        const name = media.filename || `${media.type}-${b.id}`;
        return (
          <div key={b.id} className="flex items-center gap-2.5 rounded-xl border border-line bg-white/4 px-2.5 py-2">
            {media.url && (media.type === "image" || media.type === "sticker") ? (
              <img src={media.url} alt="" className="size-10 shrink-0 rounded-lg object-cover" />
            ) : (
              <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-white/8 text-base">
                {{ image: "🖼️", video: "🎬", audio: "🎵", ptt: "🎤", document: "📄", sticker: "🏷️" }[media.type]}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] font-medium">{media.filename || b.text || media.type}</div>
              <div className="text-[10.5px] text-muted">
                {b.time} · {b.from === "me" ? "sent" : "received"}
              </div>
            </div>
            {media.url ? (
              <a href={media.url} download={name} target="_blank" rel="noreferrer" className="shrink-0 text-[11px] text-indigo underline underline-offset-2">
                Download
              </a>
            ) : (
              <button type="button" disabled={media.loading} onClick={() => void loadMedia(chatId, b.id)} className="shrink-0 text-[11px] text-indigo underline underline-offset-2 disabled:opacity-60">
                {media.loading ? "…" : "Load"}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ActionRow({
  icon,
  color,
  title,
  sub,
  onClick,
}: {
  icon: ReactNode;
  color: string;
  title: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="mt-2 flex w-full items-center gap-3 rounded-xl border border-line bg-white/4 px-3 py-2.5 text-left hover:bg-white/8"
    >
      <span className={cn("grid size-9 place-items-center rounded-[10px]", color)}>{icon}</span>
      <span className="flex-1">
        <span className="block text-[13px] font-medium">{title}</span>
        <span className="block text-[11px] text-muted">{sub}</span>
      </span>
      <span className="text-dim">›</span>
    </button>
  );
}
