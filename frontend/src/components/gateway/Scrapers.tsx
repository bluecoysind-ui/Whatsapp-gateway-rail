import { useEffect, useMemo, useState } from "react";
import {
  addContactsToGroup,
  downloadContactsCsv,
  listGroups,
  saveContact,
  scrapeContacts,
  scrapeGroups,
  type GroupRow,
  type ScrapedContact,
} from "@/lib/gateway-client";
import { parseRecipients } from "./Broadcast";
import { useGateway } from "@/store/gateway-store";
import { cn } from "@/lib/cn";

const field =
  "w-full rounded-xl border border-line bg-night/40 px-3 py-2 text-left text-sm text-ink outline-none placeholder:text-dim";
const label = "block text-left text-[11px] font-medium uppercase tracking-wide text-muted";

function Section({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <section className="glass rounded-2xl p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mb-3 text-[11.5px] text-muted">{sub}</p>
      {children}
    </section>
  );
}

/** Checkbox list of connected accounts, with select-all. */
function AccountPicker({ selected, onToggle, onAll }: { selected: string[]; onToggle: (id: string) => void; onAll: (on: boolean) => void }) {
  const sessions = useGateway((s) => s.sessions);
  const connected = sessions.filter((s) => s.status === "connected");
  const allOn = connected.length > 0 && connected.every((s) => selected.includes(s.sessionId));
  if (connected.length === 0) {
    return <p className="rounded-xl border border-line bg-night/30 px-3 py-2 text-[11px] text-danger">No connected account.</p>;
  }
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className={label}>Accounts</span>
        {connected.length > 1 ? (
          <button type="button" className="text-[11px] text-indigo hover:underline" onClick={() => onAll(!allOn)}>
            {allOn ? "Clear all" : "Select all"}
          </button>
        ) : null}
      </div>
      <div className="scroll-thin mt-1 max-h-32 space-y-0.5 overflow-auto rounded-xl border border-line bg-night/30 p-1">
        {connected.map((s) => (
          <label key={s.sessionId} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-white/5">
            <input type="checkbox" checked={selected.includes(s.sessionId)} onChange={() => onToggle(s.sessionId)} className="accent-wa" />
            <span className="min-w-0 flex-1 truncate">
              {s.name || s.sessionId}
              {s.phoneNumber ? <span className="text-dim"> · {s.phoneNumber}</span> : null}
            </span>
            {s.proxy ? <span className="shrink-0 rounded-full border border-indigo/40 px-1.5 text-[9px] text-indigo">proxy</span> : null}
          </label>
        ))}
      </div>
    </div>
  );
}

/** A scraped-contacts result table with a CSV download. */
function ResultTable({ contacts, filename }: { contacts: ScrapedContact[]; filename: string }) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return contacts;
    return contacts.filter((c) => c.phone.includes(s) || (c.name ?? "").toLowerCase().includes(s));
  }, [contacts, q]);
  if (contacts.length === 0) return null;
  return (
    <div className="mt-3">
      <div className="mb-2 flex items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Filter ${contacts.length}…`} className={cn(field, "h-8 py-1")} />
        <button
          type="button"
          onClick={() => downloadContactsCsv(shown, filename)}
          className="shrink-0 rounded-xl bg-wa px-3 py-1.5 text-xs font-semibold text-night"
        >
          ⬇ CSV ({shown.length})
        </button>
      </div>
      <div className="scroll-thin max-h-72 overflow-auto rounded-xl border border-line">
        <table className="w-full text-[11.5px]">
          <thead className="sticky top-0 bg-night/80 text-left text-muted">
            <tr>
              <th className="px-2 py-1 font-medium">Phone</th>
              <th className="px-2 py-1 font-medium">Name</th>
              <th className="px-2 py-1 font-medium">Groups / Accounts</th>
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, 500).map((c) => (
              <tr key={c.jid + (c.groupName ?? "")} className="border-t border-line">
                <td className="px-2 py-1 font-mono">{c.phone}</td>
                <td className="max-w-[160px] truncate px-2 py-1">{c.name || <span className="text-dim">—</span>}</td>
                <td className="max-w-[220px] truncate px-2 py-1 text-muted">
                  {(c.groups ?? (c.groupName ? [c.groupName] : [])).join(", ") || (c.sources ?? (c.sessionId ? [c.sessionId] : [])).join(", ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shown.length > 500 ? <p className="mt-1 text-[11px] text-muted">Showing first 500 — the CSV holds all {shown.length}.</p> : null}
    </div>
  );
}

function ContactScraper() {
  const pushToast = useGateway((s) => s.pushToast);
  const activeAccountId = useGateway((s) => s.activeAccountId);
  const [selected, setSelected] = useState<string[]>(activeAccountId ? [activeAccountId] : []);
  const [dedupe, setDedupe] = useState(true);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ScrapedContact[] | null>(null);

  const run = async () => {
    if (selected.length === 0) return pushToast("error", "Pick at least one account");
    setLoading(true);
    setResult(null);
    try {
      const r = await scrapeContacts(selected, { dedupe });
      if (!r.success || !r.data) return pushToast("error", r.message || "Scrape failed");
      setResult(r.data.contacts);
      pushToast("success", `Scraped ${r.data.total} contacts from ${r.data.accounts.length} account(s)`);
    } catch {
      pushToast("error", "Gateway unreachable");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Section title="Contact Scraper" sub="Pull the saved contacts from one or more connected accounts.">
      <AccountPicker
        selected={selected}
        onToggle={(id) => setSelected((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))}
        onAll={(on) => {
          const conn = useGateway.getState().sessions.filter((s) => s.status === "connected").map((s) => s.sessionId);
          setSelected(on ? conn : []);
        }}
      />
      <label className="mt-2 flex items-center gap-2 text-[12px] text-muted">
        <input type="checkbox" checked={dedupe} onChange={(e) => setDedupe(e.target.checked)} className="accent-wa" />
        Merge duplicates across accounts
      </label>
      <button
        type="button"
        disabled={loading || selected.length === 0}
        onClick={() => void run()}
        className="mt-3 rounded-xl bg-indigo px-4 py-2 text-sm font-medium disabled:opacity-50"
      >
        {loading ? "Scraping…" : "Scrape contacts"}
      </button>
      {result ? <ResultTable contacts={result} filename="contacts.csv" /> : null}
    </Section>
  );
}

function GroupScraper() {
  const pushToast = useGateway((s) => s.pushToast);
  const sessions = useGateway((s) => s.sessions);
  const activeAccountId = useGateway((s) => s.activeAccountId);
  const connected = sessions.filter((s) => s.status === "connected");
  const [sessionId, setSessionId] = useState(() => (connected.find((s) => s.sessionId === activeAccountId) ?? connected[0])?.sessionId ?? "");
  const [scope, setScope] = useState<"all" | "pick">("all");
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ScrapedContact[] | null>(null);

  // Load the account's groups when "choose groups" is selected.
  useEffect(() => {
    if (scope !== "pick" || !sessionId) return;
    let cancelled = false;
    setGroupsLoading(true);
    listGroups(sessionId)
      .then((r) => {
        if (!cancelled) setGroups(r.success && r.data ? r.data.groups : []);
      })
      .catch(() => !cancelled && setGroups([]))
      .finally(() => !cancelled && setGroupsLoading(false));
    return () => {
      cancelled = true;
    };
  }, [scope, sessionId]);

  useEffect(() => {
    setPicked([]);
    setResult(null);
  }, [sessionId]);

  const run = async () => {
    if (!sessionId) return pushToast("error", "Pick a connected account");
    if (scope === "pick" && picked.length === 0) return pushToast("error", "Pick at least one group");
    setLoading(true);
    setResult(null);
    try {
      const r = await scrapeGroups([sessionId], scope === "all" ? null : picked, { dedupe: true });
      if (!r.success || !r.data) return pushToast("error", r.message || "Scrape failed");
      setResult(r.data.contacts);
      pushToast("success", `Scraped ${r.data.total} members from ${r.data.groups.length} group(s)`);
    } catch {
      pushToast("error", "Gateway unreachable");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Section title="Group Scraper" sub="Pull members from all groups on an account, or just the groups you choose.">
      <label className={label}>
        Account
        <select value={sessionId} onChange={(e) => setSessionId(e.target.value)} className={cn(field, "mt-1")}>
          {connected.length === 0 ? <option value="">No connected account</option> : null}
          {connected.map((s) => (
            <option key={s.sessionId} value={s.sessionId}>
              {s.name || s.sessionId}
              {s.phoneNumber ? ` · ${s.phoneNumber}` : ""}
            </option>
          ))}
        </select>
      </label>

      <div className="mt-2 flex gap-1 rounded-xl border border-line bg-night/30 p-1 text-[12px]">
        {(["all", "pick"] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setScope(v)}
            className={cn("flex-1 rounded-lg py-1.5", scope === v ? "bg-indigo/30 text-indigo" : "text-muted")}
          >
            {v === "all" ? "All groups" : "Choose groups"}
          </button>
        ))}
      </div>

      {scope === "pick" ? (
        <div className="scroll-thin mt-2 max-h-40 space-y-0.5 overflow-auto rounded-xl border border-line bg-night/30 p-1">
          {groupsLoading ? (
            <p className="p-3 text-center text-xs text-muted">Loading groups…</p>
          ) : groups.length === 0 ? (
            <p className="p-3 text-center text-xs text-muted">No groups on this account.</p>
          ) : (
            groups.map((g) => (
              <label key={g.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-white/5">
                <input
                  type="checkbox"
                  checked={picked.includes(g.id)}
                  onChange={() => setPicked((p) => (p.includes(g.id) ? p.filter((x) => x !== g.id) : [...p, g.id]))}
                  className="accent-wa"
                />
                <span className="min-w-0 flex-1 truncate">{g.name || g.id}</span>
                <span className="shrink-0 text-[10px] text-dim">{g.participantsCount ?? "?"}</span>
              </label>
            ))
          )}
        </div>
      ) : null}

      <button
        type="button"
        disabled={loading || !sessionId}
        onClick={() => void run()}
        className="mt-3 rounded-xl bg-indigo px-4 py-2 text-sm font-medium disabled:opacity-50"
      >
        {loading ? "Scraping…" : scope === "all" ? "Scrape all groups" : `Scrape ${picked.length || ""} group(s)`}
      </button>
      {result ? <ResultTable contacts={result} filename="group-members.csv" /> : null}
    </Section>
  );
}

function AddToGroup() {
  const pushToast = useGateway((s) => s.pushToast);
  const sessions = useGateway((s) => s.sessions);
  const activeAccountId = useGateway((s) => s.activeAccountId);
  const connected = sessions.filter((s) => s.status === "connected");
  const [sessionId, setSessionId] = useState(() => (connected.find((s) => s.sessionId === activeAccountId) ?? connected[0])?.sessionId ?? "");
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [groupId, setGroupId] = useState("");
  const [numbers, setNumbers] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<Array<{ phone: string; ok: boolean; msg: string }> | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    listGroups(sessionId)
      .then((r) => {
        if (cancelled) return;
        const gs = r.success && r.data ? r.data.groups : [];
        setGroups(gs);
        setGroupId((cur) => (gs.some((g) => g.id === cur) ? cur : gs[0]?.id ?? ""));
      })
      .catch(() => !cancelled && setGroups([]));
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const parsed = useMemo(() => parseRecipients(numbers), [numbers]);

  const run = async () => {
    if (!sessionId || !groupId) return pushToast("error", "Pick an account and a group");
    if (parsed.valid.length === 0) return pushToast("error", "Add at least one valid number");
    setBusy(true);
    setLog(null);
    try {
      const r = await addContactsToGroup({ sessionId, groupId, phones: parsed.valid, name: name.trim() || undefined });
      if (!r.data) return pushToast("error", r.message || "Failed");
      setLog(r.data.results.map((x) => ({ phone: x.phone, ok: x.success, msg: x.message || (x.success ? "added" : "failed") })));
      pushToast(r.data.added > 0 ? "success" : "error", `Added ${r.data.added}/${r.data.results.length}. Each number is saved as a contact first.`);
    } catch {
      pushToast("error", "Gateway unreachable");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Add Contacts to a Group" sub="Each number is saved to the account's address book first, then added to the group.">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className={label}>
          Account
          <select value={sessionId} onChange={(e) => setSessionId(e.target.value)} className={cn(field, "mt-1")}>
            {connected.length === 0 ? <option value="">No connected account</option> : null}
            {connected.map((s) => (
              <option key={s.sessionId} value={s.sessionId}>
                {s.name || s.sessionId}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          Group
          <select value={groupId} onChange={(e) => setGroupId(e.target.value)} className={cn(field, "mt-1")}>
            {groups.length === 0 ? <option value="">No groups</option> : null}
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name || g.id}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className={cn(label, "mt-2")}>
        Contact name <span className="normal-case tracking-normal text-dim">(optional — used for all)</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Lead" className={cn(field, "mt-1")} />
      </label>
      <label className={cn(label, "mt-2")}>
        Phone numbers
        <textarea
          value={numbers}
          onChange={(e) => setNumbers(e.target.value)}
          rows={5}
          placeholder={"One per line\n628123456789\n628987654321"}
          className={cn(field, "mt-1 font-mono text-xs")}
        />
      </label>
      <p className="mt-1 text-[11px] text-muted">
        {parsed.valid.length} valid
        {parsed.invalid.length ? <span className="text-danger"> · {parsed.invalid.length} ignored</span> : null}
        {" · only the group's admins can add members, and some numbers reject being added by strangers."}
      </p>
      <button
        type="button"
        disabled={busy || !groupId || parsed.valid.length === 0}
        onClick={() => void run()}
        className="mt-3 rounded-xl bg-wa px-4 py-2 text-sm font-semibold text-night disabled:opacity-50"
      >
        {busy ? "Adding…" : `Save & add ${parsed.valid.length || ""} to group`}
      </button>
      {log ? (
        <div className="scroll-thin mt-3 max-h-56 space-y-1 overflow-auto rounded-xl border border-line p-1 text-[11.5px]">
          {log.map((l) => (
            <div key={l.phone} className="flex items-center gap-2 px-2 py-1">
              <span className={cn("size-1.5 shrink-0 rounded-full", l.ok ? "bg-wa" : "bg-danger")} />
              <span className="font-mono">{l.phone}</span>
              <span className={cn("truncate", l.ok ? "text-muted" : "text-danger")}>{l.msg}</span>
            </div>
          ))}
        </div>
      ) : null}
    </Section>
  );
}

export function ScrapersPanel() {
  return (
    <div className="glass scroll-thin min-w-0 flex-1 overflow-auto rounded-2xl p-4">
      <h2 className="mb-1 text-base font-semibold">Scrapers &amp; Contacts</h2>
      <p className="mb-4 text-[12px] text-muted">Export contacts, pull group members, and add saved contacts into groups.</p>
      <div className="grid gap-4 xl:grid-cols-2">
        <ContactScraper />
        <GroupScraper />
        <div className="xl:col-span-2">
          <AddToGroup />
        </div>
      </div>
    </div>
  );
}
