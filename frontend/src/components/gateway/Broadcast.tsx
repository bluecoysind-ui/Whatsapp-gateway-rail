import { useEffect, useMemo, useState } from "react";
import {
  getBulkJob,
  listChats,
  type BulkJob,
  type BulkJobSummary,
  type BulkJobType,
  type GatewayChat,
} from "@/lib/gateway-client";
import { TEMPLATES } from "@/lib/templates";
import { pickBulkSession, useGateway } from "@/store/gateway-store";
import { cn } from "@/lib/cn";

/** Mirrors BULK_MAX_RECIPIENTS on the backend. */
const MAX_RECIPIENTS = 100;

const TYPE_LABEL: Record<BulkJobType, string> = { text: "Text", image: "Image", document: "Document" };

const STATUS_STYLE: Record<BulkJobSummary["status"], string> = {
  processing: "bg-indigo/20 text-indigo",
  completed: "bg-wa/15 text-wa",
  cancelled: "bg-white/10 text-muted",
  interrupted: "bg-danger/15 text-danger",
};

const field =
  "w-full rounded-xl border border-line bg-night/40 px-3 py-2 text-left text-sm text-ink outline-none placeholder:text-dim";
const label = "block text-left text-[11px] font-medium uppercase tracking-wide text-muted";

function fmtWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function fmtDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const min = Math.round(ms / 60_000);
  return min < 60 ? `~${min} min` : `~${Math.round(min / 6) / 10} h`;
}

/** One line of what a job is sending, for cards and the composer summary. */
function payloadPreview(job: BulkJobSummary): string {
  const p = job.payload as Record<string, string | undefined>;
  if (job.type === "text") return p.message ?? "";
  if (job.type === "image") return p.caption ? `${p.imageUrl} — ${p.caption}` : (p.imageUrl ?? "");
  return p.filename ? `${p.filename} (${p.mimetype ?? "file"})` : (p.documentUrl ?? "");
}

/**
 * Turn a pasted blob into recipients: one per line/comma/semicolon. Anything
 * with an "@" is taken as a JID verbatim; otherwise it must have 7+ digits.
 */
export function parseRecipients(text: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[\n,;]+/)) {
    const token = raw.trim();
    if (!token) continue;
    let value: string;
    if (token.includes("@")) value = token;
    else {
      const digits = token.replace(/\D/g, "");
      if (digits.length < 7 || digits.length > 15) {
        invalid.push(token);
        continue;
      }
      value = digits;
    }
    if (!seen.has(value)) {
      seen.add(value);
      valid.push(value);
    }
  }
  return { valid, invalid };
}

// ---------------------------------------------------------------------------
// Composer (rendered inside the "bulk" overlay)
// ---------------------------------------------------------------------------

export function BulkComposer() {
  const sessions = useGateway((s) => s.sessions);
  const activeAccountId = useGateway((s) => s.activeAccountId);
  const bulkSessionId = useGateway((s) => s.bulkSessionId);
  const startBulk = useGateway((s) => s.startBulk);
  const closeOverlay = useGateway((s) => s.closeOverlay);
  const live = useGateway((s) => s.live);

  const connected = sessions.filter((s) => s.status === "connected");
  const [sessionId, setSessionId] = useState(
    () => pickBulkSession(sessions, bulkSessionId || activeAccountId)?.sessionId ?? "",
  );
  const session = sessions.find((s) => s.sessionId === sessionId);

  // Recipients
  const [source, setSource] = useState<"chats" | "paste">("chats");
  const [chats, setChats] = useState<GatewayChat[]>([]);
  const [chatsLoading, setChatsLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<"all" | "dm" | "group">("all");
  const [pasted, setPasted] = useState("");

  // Content
  const [type, setType] = useState<BulkJobType>("text");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [documentUrl, setDocumentUrl] = useState("");
  const [filename, setFilename] = useState("");
  const [mimetype, setMimetype] = useState("application/pdf");
  const [caption, setCaption] = useState("");

  // Pacing — defaults deliberately slower than the API's 1s: bursts get numbers flagged.
  const [delay, setDelay] = useState(3000);
  const [jitter, setJitter] = useState(2000);
  const [typing, setTyping] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  // The picker lists the chosen session's chats, not whichever one the inbox loaded.
  useEffect(() => {
    if (!live || !session || session.status !== "connected") {
      setChats([]);
      return;
    }
    let cancelled = false;
    setChatsLoading(true);
    listChats(session.sessionId, 500)
      .then((r) => {
        if (!cancelled) setChats(r.success && r.data ? r.data.chats : []);
      })
      .catch(() => {
        if (!cancelled) setChats([]);
      })
      .finally(() => {
        if (!cancelled) setChatsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [live, session?.sessionId, session?.status]);

  // Switching sessions invalidates the chat selection but not pasted numbers.
  useEffect(() => {
    setSelected(new Set());
  }, [sessionId]);

  const visibleChats = useMemo(() => {
    const q = search.trim().toLowerCase();
    return chats.filter((c) => {
      if (kind === "dm" && c.isGroup) return false;
      if (kind === "group" && !c.isGroup) return false;
      if (!q) return true;
      return (c.name ?? "").toLowerCase().includes(q) || (c.phone ?? "").includes(q) || c.id.includes(q);
    });
  }, [chats, search, kind]);

  const parsed = useMemo(() => parseRecipients(pasted), [pasted]);
  const recipients = useMemo(() => {
    const out = new Set<string>(selected);
    for (const r of parsed.valid) out.add(r);
    return [...out];
  }, [selected, parsed.valid]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectVisible = (on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const c of visibleChats) {
        if (on) next.add(c.id);
        else next.delete(c.id);
      }
      return next;
    });

  const problem = (() => {
    if (!live) return "Gateway offline";
    if (!session || session.status !== "connected") return "Pick a connected session";
    if (recipients.length === 0) return "Add at least one recipient";
    if (recipients.length > MAX_RECIPIENTS) return `Max ${MAX_RECIPIENTS} recipients per campaign`;
    if (type === "text" && !message.trim()) return "Write a message";
    if (type === "image" && !imageUrl.trim()) return "Image URL is required";
    if (type === "document" && (!documentUrl.trim() || !filename.trim())) return "Document URL and filename are required";
    return null;
  })();

  const estimate = recipients.length > 1 ? (recipients.length - 1) * (delay + jitter / 2) + recipients.length * typing : 0;

  const submit = async () => {
    if (problem || submitting) return;
    setSubmitting(true);
    const payload =
      type === "text"
        ? { message: message.trim() }
        : type === "image"
          ? { imageUrl: imageUrl.trim(), caption: caption.trim() }
          : { documentUrl: documentUrl.trim(), filename: filename.trim(), mimetype: mimetype.trim() || undefined, caption: caption.trim() };
    await startBulk({
      sessionId,
      type,
      recipients,
      payload,
      name: name.trim() || undefined,
      options: { delayBetweenMessages: delay, delayJitter: jitter, typingTime: typing },
    });
    setSubmitting(false);
  };

  return (
    <div className="text-left">
      <div className="grid gap-5 md:grid-cols-2">
        {/* ---------------- Recipients ---------------- */}
        <section className="space-y-3">
          <label className={label}>
            Send from
            <select value={sessionId} onChange={(e) => setSessionId(e.target.value)} className={cn(field, "mt-1")}>
              {sessions.length === 0 ? <option value="">No sessions</option> : null}
              {sessions.map((s) => (
                <option key={s.sessionId} value={s.sessionId} disabled={s.status !== "connected"}>
                  {s.name || s.sessionId}
                  {s.phoneNumber ? ` · ${s.phoneNumber}` : ""}
                  {s.status !== "connected" ? ` (${s.status})` : ""}
                </option>
              ))}
            </select>
            {connected.length === 0 ? (
              <span className="mt-1 block text-[11px] normal-case tracking-normal text-danger">
                No connected session — link a phone first.
              </span>
            ) : null}
          </label>

          <div>
            <div className="flex items-center justify-between">
              <span className={label}>Recipients</span>
              <div className="flex gap-1 rounded-lg border border-line bg-night/30 p-0.5 text-[11px]">
                {(["chats", "paste"] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSource(s)}
                    className={cn("rounded-md px-2 py-1", source === s ? "bg-indigo/30 text-indigo" : "text-muted")}
                  >
                    {s === "chats" ? "From chats" : "Paste numbers"}
                  </button>
                ))}
              </div>
            </div>

            {source === "chats" ? (
              <div className="mt-2 rounded-xl border border-line bg-night/30">
                <div className="flex items-center gap-2 border-b border-line p-2">
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Filter chats…"
                    className="min-w-0 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-dim"
                  />
                  <select
                    value={kind}
                    onChange={(e) => setKind(e.target.value as typeof kind)}
                    className="rounded-md border border-line bg-night/40 px-1.5 py-1 text-[11px]"
                  >
                    <option value="all">All</option>
                    <option value="dm">Contacts</option>
                    <option value="group">Groups</option>
                  </select>
                </div>
                <div className="scroll-thin max-h-48 overflow-auto p-1">
                  {chatsLoading ? (
                    <p className="p-4 text-center text-xs text-muted">Loading chats…</p>
                  ) : visibleChats.length === 0 ? (
                    <p className="p-4 text-center text-xs text-muted">
                      {chats.length === 0 ? "No chats on this session yet." : "No chats match."}
                    </p>
                  ) : (
                    visibleChats.map((c) => (
                      <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-white/5">
                        <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} className="accent-wa" />
                        <span className="min-w-0 flex-1 truncate">{c.name || c.phone || c.id.split("@")[0]}</span>
                        <span className="shrink-0 text-[10px] text-dim">{c.isGroup ? "group" : (c.phone ?? "")}</span>
                      </label>
                    ))
                  )}
                </div>
                <div className="flex items-center justify-between border-t border-line px-2 py-1.5 text-[11px] text-muted">
                  <span>{selected.size} selected</span>
                  <span className="flex gap-2">
                    <button type="button" className="hover:text-ink" onClick={() => selectVisible(true)}>
                      Select shown
                    </button>
                    <button type="button" className="hover:text-ink" onClick={() => selectVisible(false)}>
                      Clear shown
                    </button>
                  </span>
                </div>
              </div>
            ) : (
              <div className="mt-2">
                <textarea
                  value={pasted}
                  onChange={(e) => setPasted(e.target.value)}
                  rows={7}
                  placeholder={"One number per line (or comma-separated)\n628123456789\n628987654321\n120363...@g.us"}
                  className={cn(field, "font-mono text-xs")}
                />
                <p className="mt-1 text-[11px] text-muted">
                  {parsed.valid.length} valid
                  {parsed.invalid.length ? (
                    <span className="text-danger"> · {parsed.invalid.length} ignored: {parsed.invalid.slice(0, 3).join(", ")}{parsed.invalid.length > 3 ? "…" : ""}</span>
                  ) : null}
                </p>
              </div>
            )}
            {selected.size > 0 && parsed.valid.length > 0 ? (
              <p className="mt-1 text-[11px] text-muted">Chats and pasted numbers are combined.</p>
            ) : null}
          </div>
        </section>

        {/* ---------------- Content ---------------- */}
        <section className="space-y-3">
          <label className={label}>
            Campaign name <span className="normal-case tracking-normal text-dim">(optional)</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="September promo" className={cn(field, "mt-1")} />
          </label>

          <div>
            <span className={label}>Message type</span>
            <div className="mt-1 flex gap-1 rounded-xl border border-line bg-night/30 p-1">
              {(["text", "image", "document"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setType(t)}
                  className={cn("flex-1 rounded-lg py-1.5 text-xs font-medium", type === t ? "bg-indigo/30 text-indigo" : "text-muted hover:text-ink")}
                >
                  {TYPE_LABEL[t]}
                </button>
              ))}
            </div>
          </div>

          {type === "text" ? (
            <label className={label}>
              <span className="flex items-center justify-between">
                Message
                <select
                  value=""
                  onChange={(e) => {
                    const t = TEMPLATES.find((x) => x.id === e.target.value);
                    if (t) setMessage(t.body);
                  }}
                  className="rounded-md border border-line bg-night/40 px-1.5 py-0.5 text-[11px] normal-case tracking-normal"
                >
                  <option value="">Insert template…</option>
                  {TEMPLATES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
                </select>
              </span>
              <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={5} placeholder="Hello from WA Gateway!" className={cn(field, "mt-1")} />
            </label>
          ) : null}

          {type === "image" ? (
            <>
              <label className={label}>
                Image URL
                <input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://example.com/image.jpg" className={cn(field, "mt-1")} />
              </label>
              <label className={label}>
                Caption <span className="normal-case tracking-normal text-dim">(optional)</span>
                <textarea value={caption} onChange={(e) => setCaption(e.target.value)} rows={3} className={cn(field, "mt-1")} />
              </label>
            </>
          ) : null}

          {type === "document" ? (
            <>
              <label className={label}>
                Document URL
                <input value={documentUrl} onChange={(e) => setDocumentUrl(e.target.value)} placeholder="https://example.com/brochure.pdf" className={cn(field, "mt-1")} />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className={label}>
                  Filename
                  <input value={filename} onChange={(e) => setFilename(e.target.value)} placeholder="brochure.pdf" className={cn(field, "mt-1")} />
                </label>
                <label className={label}>
                  MIME type
                  <input value={mimetype} onChange={(e) => setMimetype(e.target.value)} placeholder="application/pdf" className={cn(field, "mt-1")} />
                </label>
              </div>
              <label className={label}>
                Caption <span className="normal-case tracking-normal text-dim">(optional)</span>
                <input value={caption} onChange={(e) => setCaption(e.target.value)} className={cn(field, "mt-1")} />
              </label>
            </>
          ) : null}

          <div>
            <span className={label}>Pacing</span>
            <div className="mt-1 grid grid-cols-3 gap-2">
              {(
                [
                  ["Delay (ms)", delay, setDelay, 0],
                  ["Jitter (ms)", jitter, setJitter, 0],
                  ["Typing (ms)", typing, setTyping, 0],
                ] as const
              ).map(([lbl, val, setter, min]) => (
                <label key={lbl} className="text-[10px] text-muted">
                  {lbl}
                  <input
                    type="number"
                    min={min}
                    step={500}
                    value={val}
                    onChange={(e) => setter(Math.max(min, Number(e.target.value) || 0))}
                    className={cn(field, "mt-0.5 px-2 py-1.5 text-xs")}
                  />
                </label>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-muted">
              Waits delay + random 0–jitter between messages. Steady, varied pacing is what keeps a number from being flagged.
            </p>
          </div>
        </section>
      </div>

      {/* ---------------- Footer ---------------- */}
      <div className="mt-5 flex flex-col items-center justify-between gap-3 border-t border-line pt-4 sm:flex-row">
        <div className="text-[12px] text-muted">
          {recipients.length > 0 ? (
            <>
              <span className={cn("font-semibold", recipients.length > MAX_RECIPIENTS ? "text-danger" : "text-ink")}>
                {recipients.length}
              </span>{" "}
              recipient{recipients.length === 1 ? "" : "s"}
              {estimate > 0 ? <> · about {fmtDuration(estimate)}</> : null}
            </>
          ) : (
            "No recipients yet"
          )}
        </div>
        <div className="flex gap-2">
          <button type="button" className="rounded-xl border border-line px-4 py-2 text-sm" onClick={closeOverlay}>
            Cancel
          </button>
          <button
            type="button"
            disabled={Boolean(problem) || submitting}
            title={problem ?? undefined}
            onClick={() => void submit()}
            className="rounded-xl bg-wa px-4 py-2 text-sm font-semibold text-night disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Starting…" : problem ?? `Start campaign`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Broadcast panel (main stage)
// ---------------------------------------------------------------------------

export function BroadcastPanel() {
  const sessions = useGateway((s) => s.sessions);
  const live = useGateway((s) => s.live);
  const bulkSessionId = useGateway((s) => s.bulkSessionId);
  const bulkJobs = useGateway((s) => s.bulkJobs);
  const bulkLoading = useGateway((s) => s.bulkLoading);
  const loadBulkJobs = useGateway((s) => s.loadBulkJobs);
  const setBulkSession = useGateway((s) => s.setBulkSession);
  const openOverlay = useGateway((s) => s.openOverlay);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Re-fetch when the gateway comes online or sessions appear after mount.
  useEffect(() => {
    void loadBulkJobs();
  }, [loadBulkJobs, live, sessions.length]);

  const session = sessions.find((s) => s.sessionId === bulkSessionId);
  const running = bulkJobs.filter((j) => j.status === "processing").length;
  const totals = bulkJobs.reduce(
    (acc, j) => ({ sent: acc.sent + j.sent, failed: acc.failed + j.failed }),
    { sent: 0, failed: 0 },
  );

  return (
    <div className="glass scroll-thin flex min-w-0 flex-1 flex-col overflow-auto rounded-2xl p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">Broadcast</h2>
          <p className="text-[12px] text-muted">
            Campaigns go out one message at a time with a randomised gap, and keep running after you close this page.
          </p>
        </div>
        {sessions.length > 1 ? (
          <select
            value={bulkSessionId}
            onChange={(e) => setBulkSession(e.target.value)}
            className="rounded-xl border border-line bg-night/40 px-3 py-2 text-sm"
          >
            {sessions.map((s) => (
              <option key={s.sessionId} value={s.sessionId}>
                {s.name || s.sessionId}
                {s.status !== "connected" ? ` (${s.status})` : ""}
              </option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          onClick={() => openOverlay("bulk")}
          className="rounded-xl bg-wa px-4 py-2 text-sm font-semibold text-night"
        >
          + New campaign
        </button>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2 sm:max-w-md">
        {[
          ["Running", running, running ? "text-indigo" : ""],
          ["Delivered", totals.sent, "text-wa"],
          ["Failed", totals.failed, totals.failed ? "text-danger" : ""],
        ].map(([lbl, val, color]) => (
          <div key={lbl as string} className="rounded-xl border border-line bg-night/30 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-muted">{lbl}</div>
            <div className={cn("text-lg font-semibold", color as string)}>{val}</div>
          </div>
        ))}
      </div>

      <div className="mt-4 space-y-2">
        {!live ? (
          <p className="px-4 py-10 text-center text-[12.5px] text-muted">Gateway offline — campaigns need the backend.</p>
        ) : !session ? (
          <p className="px-4 py-10 text-center text-[12.5px] text-muted">Create a session and link a phone to start a campaign.</p>
        ) : bulkJobs.length === 0 ? (
          <p className="px-4 py-10 text-center text-[12.5px] text-muted">
            {bulkLoading ? "Loading campaigns…" : `No campaigns on ${session.name || session.sessionId} yet.`}
          </p>
        ) : (
          bulkJobs.map((job) => (
            <JobCard
              key={job.jobId}
              job={job}
              canRetry={session.status === "connected"}
              expanded={expanded === job.jobId}
              onToggle={() => setExpanded((cur) => (cur === job.jobId ? null : job.jobId))}
            />
          ))
        )}
      </div>
    </div>
  );
}

function JobCard({
  job,
  canRetry,
  expanded,
  onToggle,
}: {
  job: BulkJobSummary;
  canRetry: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const cancelBulk = useGateway((s) => s.cancelBulk);
  const retryBulk = useGateway((s) => s.retryBulk);
  const running = job.status === "processing";
  const unsent = job.failed + job.skipped;
  const done = job.sent + job.failed + job.skipped;

  return (
    <div className="rounded-xl border border-line bg-night/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", STATUS_STYLE[job.status])}>
          {job.cancelRequested && running ? "stopping" : job.status}
        </span>
        <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-muted">{TYPE_LABEL[job.type]}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{job.name || payloadPreview(job) || job.jobId}</span>
        <span className="text-[11px] text-dim">{fmtWhen(job.createdAt)}</span>
      </div>

      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
        <div
          className={cn("h-full rounded-full transition-[width]", job.status === "interrupted" ? "bg-danger" : "bg-wa")}
          style={{ width: `${job.total ? Math.round((done / job.total) * 100) : 0}%` }}
        />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
        <span>
          <span className="text-ink">{done}</span>/{job.total}
        </span>
        <span className="text-wa">{job.sent} sent</span>
        {job.failed ? <span className="text-danger">{job.failed} failed</span> : null}
        {job.skipped ? <span>{job.skipped} skipped</span> : null}
        {job.error ? <span className="text-danger">· {job.error}</span> : null}
        <span className="ml-auto flex gap-3">
          <button type="button" className="hover:text-ink" onClick={onToggle}>
            {expanded ? "Hide details" : "Details"}
          </button>
          {running ? (
            <button
              type="button"
              disabled={job.cancelRequested}
              className="text-danger hover:underline disabled:opacity-50"
              onClick={() => void cancelBulk(job.jobId)}
            >
              Cancel
            </button>
          ) : unsent > 0 ? (
            <button
              type="button"
              disabled={!canRetry}
              title={canRetry ? undefined : "Session must be connected"}
              className="text-indigo hover:underline disabled:opacity-50"
              onClick={() => void retryBulk(job.jobId)}
            >
              Retry {unsent} unsent
            </button>
          ) : null}
        </span>
      </div>

      {expanded ? <JobDetails jobId={job.jobId} running={running} /> : null}
    </div>
  );
}

/** Per-recipient outcomes; re-fetched every 2s while the job is still sending. */
function JobDetails({ jobId, running }: { jobId: string; running: boolean }) {
  const [job, setJob] = useState<BulkJob | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await getBulkJob(jobId);
        if (cancelled) return;
        if (r.success && r.data) setJob(r.data);
        else setError(r.message || "Could not load details");
      } catch {
        if (!cancelled) setError("Could not load details");
      }
    };
    void load();
    const timer = running ? setInterval(() => void load(), 2000) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [jobId, running]);

  if (error) return <p className="mt-3 text-[11px] text-danger">{error}</p>;
  if (!job) return <p className="mt-3 text-[11px] text-muted">Loading…</p>;

  const pending = job.recipients.slice(job.details.length);
  return (
    <div className="mt-3 border-t border-line pt-3">
      <p className="mb-2 truncate text-[11px] text-muted" title={payloadPreview(job)}>
        {payloadPreview(job)} · delay {job.options.delayBetweenMessages}ms + jitter {job.options.delayJitter}ms
        {job.options.typingTime ? ` · typing ${job.options.typingTime}ms` : ""}
      </p>
      <div className="scroll-thin max-h-56 overflow-auto rounded-lg border border-line">
        <table className="w-full text-[11px]">
          <tbody>
            {job.details.map((d) => (
              <tr key={`${d.recipient}-${d.timestamp}`} className="border-b border-line last:border-0">
                <td className="px-2 py-1 font-mono">{d.recipient}</td>
                <td
                  className={cn(
                    "px-2 py-1",
                    d.status === "sent" ? "text-wa" : d.status === "failed" ? "text-danger" : "text-muted",
                  )}
                >
                  {d.status}
                </td>
                <td className="max-w-[260px] truncate px-2 py-1 text-muted" title={d.error}>
                  {d.error ?? (d.messageId ? `id ${d.messageId}` : "")}
                </td>
                <td className="px-2 py-1 text-right text-dim">{fmtWhen(d.timestamp)}</td>
              </tr>
            ))}
            {pending.map((r) => (
              <tr key={`pending-${r}`} className="border-b border-line last:border-0 opacity-60">
                <td className="px-2 py-1 font-mono">{r}</td>
                <td className="px-2 py-1 text-dim">queued</td>
                <td className="px-2 py-1" />
                <td className="px-2 py-1" />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
