import { useEffect, useMemo, useState } from "react";
import { API_ENDPOINTS, sampleBodyFor } from "@/lib/gateway-client";
import { TEMPLATES } from "@/lib/templates";
import { useGateway } from "@/store/gateway-store";
import { cn } from "@/lib/cn";
import { BulkComposer } from "./Broadcast";

export function Overlays() {
  const overlay = useGateway((s) => s.overlay);
  const close = useGateway((s) => s.closeOverlay);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);
  if (!overlay) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-night/70 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      {overlay === "qr" && <QrModal />}
      {overlay === "create-session" && <CreateSessionModal />}
      {overlay === "webhooks" && <WebhooksModal />}
      {overlay === "proxy" && <ProxyModal />}
      {overlay === "bulk" && <BulkModal />}
      {overlay === "templates" && <TemplatesModal />}
      {overlay === "search" && <SearchModal />}
    </div>
  );
}

function Card({
  title,
  sub,
  children,
  wide,
  size,
}: {
  title: string;
  sub?: string;
  children: React.ReactNode;
  wide?: boolean;
  size?: "xl";
}) {
  return (
    <div
      className={cn(
        "glass max-h-[90vh] overflow-y-auto rounded-3xl p-7 text-center",
        size === "xl" ? "w-full max-w-4xl" : wide ? "w-full max-w-xl" : "w-full max-w-md",
      )}
    >
      <h2 className="text-lg font-semibold">{title}</h2>
      {sub ? <p className="mt-1 text-sm text-muted">{sub}</p> : null}
      <div className="mt-5">{children}</div>
    </div>
  );
}

function QrModal() {
  const {
    qrSession,
    qrSrc,
    qrExpiresAt,
    pairingCode,
    pairingExpiresAt,
    pairingLoading,
    refreshQr,
    requestPairingCode,
    closeOverlay,
  } = useGateway();
  const [now, setNow] = useState(() => Date.now());
  const [phone, setPhone] = useState("");

  // Tick every second so the pairing countdown stays live.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (qrSession) void refreshQr(qrSession);
  }, [qrSession, refreshQr]);

  const secondsLeft =
    qrExpiresAt !== null ? Math.max(0, Math.ceil((qrExpiresAt - now) / 1000)) : null;
  const countdown =
    secondsLeft !== null
      ? `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`
      : null;
  const timerLabel =
    secondsLeft === null
      ? "Waiting for QR…"
      : secondsLeft > 0
        ? `QR expires in ${countdown}`
        : "QR expired — revoking session…";

  const pairingSecondsLeft =
    pairingExpiresAt !== null ? Math.max(0, Math.ceil((pairingExpiresAt - now) / 1000)) : null;
  const formattedCode = useMemo(() => {
    const raw = pairingCode.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    if (raw.length === 8) return `${raw.slice(0, 4)}-${raw.slice(4)}`;
    return pairingCode;
  }, [pairingCode]);

  const submitPhone = () => {
    void requestPairingCode(phone);
  };

  return (
    <Card title="Link WhatsApp" sub={`Session: ${qrSession || "—"}`}>
      <div className="mx-auto inline-block rounded-xl bg-white p-3">
        {qrSrc ? <img src={qrSrc} alt="QR" width={220} height={220} className="block size-[220px]" /> : <div className="size-[220px] animate-pulse bg-zinc-200" />}
      </div>
      <p className={cn("mt-3 text-center text-xs font-semibold tabular-nums", secondsLeft !== null && secondsLeft <= 20 ? "text-danger" : "text-muted")}>
        {timerLabel}
      </p>
      <p className="mt-2 text-xs text-muted">Open WhatsApp → Linked Devices → Link a Device</p>

      <div className="my-5 flex items-center gap-3 text-[11px] uppercase tracking-wide text-muted">
        <span className="h-px flex-1 bg-line" />
        or link with phone number
        <span className="h-px flex-1 bg-line" />
      </div>

      <label className="block text-left text-xs text-muted">
        Phone number (with country code)
        <span className="mt-1 flex gap-2">
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitPhone();
            }}
            placeholder="919876543210"
            inputMode="tel"
            autoComplete="tel"
            className="min-w-0 flex-1 rounded-xl border border-line bg-night/40 px-3 py-2.5 text-sm text-ink outline-none"
          />
          <button
            type="button"
            disabled={pairingLoading || !phone.replace(/\D/g, "")}
            className="shrink-0 rounded-xl bg-wa px-3 py-2 text-sm font-semibold text-night disabled:opacity-50"
            onClick={submitPhone}
          >
            {pairingLoading ? "…" : "Get code"}
          </button>
        </span>
      </label>

      {formattedCode ? (
        <div className="mt-4 rounded-2xl border border-line bg-night/30 px-4 py-3">
          <p className="text-[11px] uppercase tracking-wide text-muted">Pairing code</p>
          <p className="mt-1 font-mono text-2xl font-semibold tracking-[0.2em] text-ink">{formattedCode}</p>
          <p className="mt-2 text-xs text-muted">
            WhatsApp → Linked Devices → Link with phone number instead
            {pairingSecondsLeft !== null
              ? pairingSecondsLeft > 0
                ? ` · expires in ${pairingSecondsLeft}s`
                : " · expired — request a new code"
              : ""}
          </p>
        </div>
      ) : (
        <p className="mt-3 text-left text-xs text-muted">
          Use the same number as the phone that will enter the code, including country code (India: 91…). No + or spaces.
        </p>
      )}

      <button className="mt-5 rounded-xl border border-line px-4 py-2 text-sm" onClick={closeOverlay}>
        Close
      </button>
    </Card>
  );
}

function CreateSessionModal() {
  const { createSession, closeOverlay } = useGateway();
  const [id, setId] = useState("");
  const [hook, setHook] = useState("");
  const [proxy, setProxy] = useState("");
  return (
    <Card title="Create New Session" sub="Connect another WhatsApp number">
      <label className="mb-3 block text-left text-xs text-muted">
        Session ID
        <input
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder="my-session-1"
          className="mt-1 w-full rounded-xl border border-line bg-night/40 px-3 py-2.5 text-sm text-ink outline-none"
        />
      </label>
      <label className="mb-3 block text-left text-xs text-muted">
        Webhook URL (optional)
        <input
          value={hook}
          onChange={(e) => setHook(e.target.value)}
          placeholder="https://your-server.com/webhook"
          className="mt-1 w-full rounded-xl border border-line bg-night/40 px-3 py-2.5 text-sm text-ink outline-none"
        />
      </label>
      <div className="mb-4">
        <ProxyField value={proxy} onChange={setProxy} />
      </div>
      <div className="flex justify-center gap-3">
        <button className="rounded-xl border border-line px-4 py-2 text-sm" onClick={closeOverlay}>
          Cancel
        </button>
        <button
          className="rounded-xl bg-wa px-4 py-2 text-sm font-semibold text-night"
          onClick={() => void createSession(id.trim(), hook.trim() || undefined, proxy.trim() || undefined)}
        >
          Create & Connect
        </button>
      </div>
    </Card>
  );
}

/**
 * Proxy URL input with a "Test" button that fetches the egress IP through it.
 * Shared by the create-session and proxy modals.
 */
function ProxyField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const testProxy = useGateway((s) => s.testProxy);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string; latencyMs?: number } | null>(null);
  const run = async () => {
    if (!value.trim()) return;
    setChecking(true);
    setResult(await testProxy(value.trim()));
    setChecking(false);
  };
  return (
    <label className="block text-left text-xs text-muted">
      Proxy (optional)
      <span className="mt-1 flex gap-2">
        <input
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setResult(null);
          }}
          placeholder="socks5://user:pass@host:1080"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-xl border border-line bg-night/40 px-3 py-2.5 font-mono text-[12px] text-ink outline-none"
        />
        <button
          type="button"
          disabled={!value.trim() || checking}
          onClick={() => void run()}
          className="shrink-0 rounded-xl border border-line px-3 py-2 text-xs disabled:opacity-50"
        >
          {checking ? "Testing…" : "Test"}
        </button>
      </span>
      <span className="mt-1 block text-[11px]">
        {result ? (
          <span className={result.ok ? "text-wa" : "text-danger"}>
            {result.message}
            {result.ok && result.latencyMs ? ` · ${result.latencyMs} ms` : ""}
          </span>
        ) : (
          <span className="text-dim">socks5:// or http(s)://. Every connection of this session — socket and media — goes through it.</span>
        )}
      </span>
    </label>
  );
}

function ProxyModal() {
  const { proxySessionId, sessions, setProxy, closeOverlay } = useGateway();
  const session = sessions.find((s) => s.sessionId === proxySessionId);
  const current = session?.proxy ?? null;
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const live = session ? ["connecting", "qr_ready", "connected"].includes(session.status) : false;
  const save = async (proxy: string | null) => {
    setSaving(true);
    const ok = await setProxy(proxySessionId, proxy);
    setSaving(false);
    if (ok) closeOverlay();
  };
  return (
    <Card title="Session Proxy" sub={`Session: ${proxySessionId}`}>
      <div className="mb-3 rounded-xl border border-line bg-night/30 px-3 py-2 text-left text-xs">
        <div className="text-[10px] uppercase tracking-wide text-muted">Current</div>
        <div className={cn("mt-0.5 font-mono text-[12px] break-all", current ? "text-ink" : "text-dim")}>{current ?? "Direct connection (no proxy)"}</div>
      </div>
      <ProxyField value={value} onChange={setValue} />
      <p className="mt-2 text-left text-[11px] text-muted">
        {live
          ? "Saving restarts the session through the new proxy (a few seconds offline; no new QR needed once paired)."
          : "The proxy is used the next time this session connects."}
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        <button className="rounded-xl border border-line px-4 py-2 text-sm" onClick={closeOverlay}>
          Cancel
        </button>
        {current ? (
          <button className="rounded-xl border border-danger/30 px-4 py-2 text-sm text-danger disabled:opacity-50" disabled={saving} onClick={() => void save(null)}>
            Remove proxy
          </button>
        ) : null}
        <button
          className="rounded-xl bg-wa px-4 py-2 text-sm font-semibold text-night disabled:opacity-50"
          disabled={saving || !value.trim()}
          onClick={() => void save(value.trim())}
        >
          {saving ? "Saving…" : live ? "Save & reconnect" : "Save"}
        </button>
      </div>
    </Card>
  );
}

function WebhooksModal() {
  const { webhookSessionId, sessions, addHook, removeHook, closeOverlay } = useGateway();
  const session = sessions.find((s) => s.sessionId === webhookSessionId);
  const [url, setUrl] = useState("");
  return (
    <Card title="Manage Webhooks" sub={`Session: ${webhookSessionId}`} wide>
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://your-server.com/webhook"
        className="mb-3 w-full rounded-xl border border-line bg-night/40 px-3 py-2.5 text-left text-sm text-ink outline-none"
      />
      <button
        className="mb-4 w-full rounded-xl bg-wa py-2.5 text-sm font-semibold text-night"
        onClick={() => {
          if (url) void addHook(url, ["message"]);
          setUrl("");
        }}
      >
        Add webhook
      </button>
      <div className="space-y-2 text-left">
        {(session?.webhooks ?? []).length === 0 ? (
          <p className="text-sm text-muted">No webhooks configured</p>
        ) : (
          (session?.webhooks ?? []).map((w) => (
            <div key={w.url} className="flex items-center justify-between rounded-xl border border-line bg-night/30 px-3 py-2">
              <div>
                <div className="break-all text-sm">{w.url}</div>
                <div className="text-[11px] text-muted">{w.events?.join(", ") || "All events"}</div>
              </div>
              <button className="text-danger text-xs" onClick={() => void removeHook(w.url)}>
                Remove
              </button>
            </div>
          ))
        )}
      </div>
      <button className="mt-4 rounded-xl border border-line px-4 py-2 text-sm" onClick={closeOverlay}>
        Close
      </button>
    </Card>
  );
}

function BulkModal() {
  return (
    <Card title="New campaign" sub="Send one message to many chats — runs in the background with progress tracking" size="xl">
      <BulkComposer />
    </Card>
  );
}

function TemplatesModal() {
  const applyTemplate = useGateway((s) => s.applyTemplate);
  return (
    <Card title="Message Templates" sub="Insert a saved reply">
      <div className="space-y-2 text-left">
        {TEMPLATES.map((t) => (
          <button
            key={t.id}
            className="w-full rounded-xl border border-line bg-night/30 px-3 py-3 text-left hover:border-indigo/50"
            onClick={() => applyTemplate(t.body)}
          >
            <div className="text-sm font-medium">{t.title}</div>
            <div className="text-xs text-muted">{t.body}</div>
          </button>
        ))}
      </div>
    </Card>
  );
}

function SearchModal() {
  const { chats, query, setQuery, selectChat, closeOverlay } = useGateway();
  const hits = chats.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()) || c.preview.toLowerCase().includes(query.toLowerCase()));
  return (
    <Card title="Search" sub="Messages, contacts, groups" wide>
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Type to search…"
        className="mb-3 w-full rounded-xl border border-line bg-night/40 px-3 py-2.5 text-left text-sm text-ink outline-none"
      />
      <div className="max-h-64 space-y-1 overflow-auto text-left">
        {hits.map((c) => (
          <button
            key={c.id}
            className="w-full rounded-xl px-3 py-2 text-left text-sm hover:bg-glass"
            onClick={() => {
              selectChat(c.id);
              closeOverlay();
            }}
          >
            <div className="font-medium">{c.name}</div>
            <div className="truncate text-xs text-muted">{c.preview}</div>
          </button>
        ))}
      </div>
    </Card>
  );
}

export function ToolsPanel() {
  const {
    sessions,
    events,
    clearEvents,
    openOverlay,
    reconnect,
    removeSession,
    live,
    wsConnected,
    wsClients,
    runApi,
    apiKey,
    setApiKey,
    logout,
    login,
    setNav,
  } = useGateway();
  const [endpoint, setEndpoint] = useState(API_ENDPOINTS[0].value);
  const [sessionId, setSessionId] = useState("");
  const [jobId, setJobId] = useState("");
  const [body, setBody] = useState("{}");
  const [help, setHelp] = useState("");
  const [response, setResponse] = useState("Response will appear here…");
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");

  useEffect(() => {
    const [method, path] = endpoint.split("|");
    const sample = sampleBodyFor(path, method);
    setBody(sample.body ? JSON.stringify(sample.body, null, 2) : "");
    setHelp(sample.help);
  }, [endpoint]);

  const groups = useMemo(() => {
    const map = new Map<string, typeof API_ENDPOINTS>();
    for (const e of API_ENDPOINTS) {
      const list = map.get(e.group) ?? [];
      list.push(e);
      map.set(e.group, list);
    }
    return [...map.entries()];
  }, []);

  return (
    <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
      <div className="space-y-4">
        <section className="glass rounded-2xl p-4">
          <h3 className="mb-3 text-sm font-semibold">Sections</h3>
          <div className="flex flex-wrap gap-2">
            {(
              [
                { id: "chats" as const, label: "Chats" },
                { id: "contacts" as const, label: "Contacts" },
                { id: "groups" as const, label: "Groups" },
                { id: "broadcast" as const, label: "Broadcast" },
                { id: "scrapers" as const, label: "Scrapers" },
              ]
            ).map((s) => (
              <button
                key={s.id}
                onClick={() => setNav(s.id)}
                className="rounded-xl border border-line bg-night/30 px-3 py-1.5 text-xs font-medium hover:border-indigo/40 hover:text-indigo"
              >
                {s.label}
              </button>
            ))}
          </div>
        </section>

        <section className="glass rounded-2xl p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Sessions</h3>
            <button className="rounded-lg bg-wa px-3 py-1.5 text-xs font-semibold text-night" onClick={() => openOverlay("create-session")}>
              + New Session
            </button>
          </div>
          <p className="mb-3 text-[11px] text-muted">
            {live ? "Live gateway" : "Gateway offline"} · WS {wsConnected ? "connected" : "offline"} · {wsClients} clients
          </p>
          <div className="space-y-2">
            {sessions.map((s) => (
              <div key={s.sessionId} className="flex items-center gap-3 rounded-xl border border-line bg-night/30 p-3">
                <div className="grid size-10 place-items-center rounded-full bg-gradient-to-br from-wa to-wa-deep text-sm font-bold text-night">
                  {(s.name || s.sessionId)[0].toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{s.name || s.sessionId}</div>
                  <div className="truncate text-xs text-muted">{s.phoneNumber || s.sessionId}</div>
                  {s.proxyInfo?.active ? (
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px]">
                      <span
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          s.proxyInfo.connected ? "bg-indigo-300 shadow-[0_0_6px_#818cf8]" : "bg-white/30",
                        )}
                      />
                      <span className={cn("font-medium", s.proxyInfo.connected ? "text-indigo-200" : "text-muted")}>
                        {s.proxyInfo.connected ? "via" : "idle"}
                      </span>
                      <span className="truncate font-mono text-indigo-100" title={s.proxyInfo.active}>
                        {s.proxyInfo.active}
                      </span>
                      {s.proxyInfo.source === "pool" && s.proxyInfo.poolSize > 0 ? (
                        <span className="rounded-full border border-indigo/40 px-1.5 py-px text-indigo">
                          pool {(s.proxyInfo.index ?? 0) + 1}/{s.proxyInfo.poolSize}
                        </span>
                      ) : (
                        <span className="rounded-full border border-indigo/40 px-1.5 py-px text-indigo">
                          {s.proxyInfo.source === "session" ? "session" : "single"}
                        </span>
                      )}
                      {s.proxyInfo.required ? (
                        <span className="rounded-full bg-emerald-500/15 px-1.5 py-px text-emerald-300">no direct</span>
                      ) : null}
                      {s.proxyInfo.rotations > 0 ? <span className="text-muted">· {s.proxyInfo.rotations}× rotated</span> : null}
                    </div>
                  ) : (
                    <div className="mt-1 text-[10px] text-white/40">Direct connection (no proxy)</div>
                  )}
                </div>
                <span className={cn("rounded-full px-2 py-0.5 text-[11px]", s.status === "connected" ? "bg-wa/15 text-wa" : "bg-danger/15 text-danger")}>
                  {s.status}
                </span>
                <button className="text-xs text-muted" onClick={() => openOverlay("qr", s.sessionId)}>
                  QR
                </button>
                <button className="text-xs text-muted" onClick={() => void reconnect(s.sessionId)}>
                  Reconnect
                </button>
                <button className="text-xs text-muted" onClick={() => openOverlay("webhooks", s.sessionId)}>
                  Hooks
                </button>
                <button className={cn("text-xs", s.proxy ? "text-indigo" : "text-muted")} onClick={() => openOverlay("proxy", s.sessionId)}>
                  Proxy
                </button>
                <button className="text-xs text-danger" onClick={() => void removeSession(s.sessionId)}>
                  Delete
                </button>
              </div>
            ))}
          </div>
        </section>

        <section className="glass rounded-2xl p-4">
          <h3 className="mb-3 text-sm font-semibold">API Tester</h3>
          <select
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            className="mb-3 w-full rounded-xl border border-line bg-night/40 px-3 py-2 text-sm"
          >
            {groups.map(([g, items]) => (
              <optgroup key={g} label={g}>
                {items.map((i) => (
                  <option key={i.value} value={i.value}>
                    {i.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {endpoint.includes("{sessionId}") && (
            <input
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
              placeholder="Session ID"
              className="mb-2 w-full rounded-xl border border-line bg-night/40 px-3 py-2 text-sm"
            />
          )}
          {endpoint.includes("{jobId}") && (
            <input
              value={jobId}
              onChange={(e) => setJobId(e.target.value)}
              placeholder="Job ID"
              className="mb-2 w-full rounded-xl border border-line bg-night/40 px-3 py-2 text-sm"
            />
          )}
          {body !== "" && (
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              className="mb-2 w-full rounded-xl border border-line bg-night/40 px-3 py-2 font-mono text-xs"
            />
          )}
          {help ? <p className="mb-2 text-[11px] text-muted">{help}</p> : null}
          <button
            className="rounded-xl bg-indigo px-4 py-2 text-sm font-medium"
            onClick={async () => {
              const [method, rawPath] = endpoint.split("|");
              let path = rawPath;
              if (path.includes("{sessionId}")) path = path.replace("{sessionId}", sessionId);
              if (path.includes("{jobId}")) path = path.replace("{jobId}", jobId);
              const res = await runApi(method, path, body);
              setResponse(JSON.stringify(res, null, 2));
            }}
          >
            Send Request
          </button>
          <pre className="mt-3 max-h-48 overflow-auto rounded-xl border border-line bg-night/40 p-3 text-left font-mono text-[11px] text-muted">
            {response}
          </pre>
        </section>
      </div>

      <div className="space-y-4">
        <section className="glass rounded-2xl p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Live Events</h3>
            <button className="text-xs text-muted" onClick={clearEvents}>
              Clear
            </button>
          </div>
          <div className="scroll-thin h-72 overflow-auto font-mono text-[11px]">
            {events.length === 0 ? <p className="p-6 text-center text-muted">No events yet</p> : null}
            {events.map((ev) => (
              <div key={ev.id} className="flex gap-2 border-b border-line px-2 py-2">
                <span className="text-dim">{ev.time}</span>
                <span className="text-wa">{ev.type}</span>
                <span className="text-muted">{ev.content}</span>
              </div>
            ))}
          </div>
        </section>
        <section className="glass rounded-2xl p-4 text-left">
          <h3 className="mb-3 text-sm font-semibold">Gateway credentials</h3>
          <input
            value={user}
            onChange={(e) => setUser(e.target.value)}
            placeholder="Username"
            className="mb-2 w-full rounded-xl border border-line bg-night/40 px-3 py-2 text-sm"
          />
          <input
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            placeholder="Password"
            className="mb-2 w-full rounded-xl border border-line bg-night/40 px-3 py-2 text-sm"
          />
          <input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="API key (optional)"
            className="mb-3 w-full rounded-xl border border-line bg-night/40 px-3 py-2 text-sm"
          />
          <div className="flex gap-2">
            <button className="rounded-xl bg-wa px-3 py-2 text-xs font-semibold text-night" onClick={() => void login(user, pass, apiKey)}>
              Connect backend
            </button>
            <button className="rounded-xl border border-line px-3 py-2 text-xs" onClick={logout}>
              Logout
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useGateway((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed right-5 bottom-5 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto glass rounded-xl px-4 py-3 text-sm shadow-lg">
          {t.message}
        </div>
      ))}
    </div>
  );
}
