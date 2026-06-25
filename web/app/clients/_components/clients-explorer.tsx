"use client";

// Clients explorer (v2, test page): the clients table + a module multiselect filter. Pick one or
// more modules; "all" (default) shows clients that have EVERY selected module, "any" shows clients
// with at least one. Plus free-text search, status filter, and sortable columns. Native React — no
// DataTables/jQuery dependency.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Backbone, ClientStatus } from "@prisma/client";
import { MODULES } from "@/lib/modules/catalog";
import { SyncButton } from "./sync-button";
import { AddClientDialog } from "./add-client-dialog";
import { SystemsEditor } from "./systems-editor";

export type ClientVM = {
  id: string; slug: string; name: string; primaryDomain: string;
  backbone: Backbone | null; status: ClientStatus; coreId: string | null;
  region: string | null; usernamePattern: string; systemKeys: string[]; systemCount: number; modeled: boolean;
  coverage: "own" | "parent" | "none"; parentName: string | null; parentSystemKeys: string[];
};

const NAME: Record<string, string> = Object.fromEntries(MODULES.map((m) => [m.key, m.name]));
const BACKBONE_LABEL: Record<string, string> = { entra: "Entra", google: "Google", ad_synced: "AD synced", ad_standalone: "AD standalone" };

// Hover text for the systems cell: own systems inline, or — for a via-parent client — a header
// line then the parent's full system list.
// Render the email/UPN format as chips: a filled "primary" chip + dim "fallback" chips (the parts
// after each "|", used when the primary username is already taken).
function EmailFormat({ pattern }: { pattern: string }) {
  if (!pattern) return <span className="muted">—</span>;
  const parts = pattern.split("|").map((s) => s.trim()).filter(Boolean);
  return (
    <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
      {parts.map((p, i) => (
        <span key={i} className={`email-chip ${i === 0 ? "primary" : "fallback"}`} title={i === 0 ? "primary format" : "fallback — used when the primary username is taken"}>
          {i > 0 && "↳ "}{p}
        </span>
      ))}
    </span>
  );
}

function systemsTitle(c: ClientVM): string {
  if (c.coverage === "parent") {
    return `Inherited from ${c.parentName ?? "parent"}:\n\n${c.parentSystemKeys.join(", ") || "(parent has no systems)"}`;
  }
  return c.systemKeys.length ? c.systemKeys.join(", ") : "no systems (not modeled)";
}

type SortKey = "name" | "coreId" | "primaryDomain" | "systemCount";

export function ClientsExplorer({ clients }: { clients: ClientVM[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"active" | "archived" | "all">("active");
  const [backboneFilter, setBackboneFilter] = useState<string>(""); // "" = any
  const [coverageFilter, setCoverageFilter] = useState<"all" | "own" | "parent" | "none">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editDomain, setEditDomain] = useState<string | null>(null); // slug being edited
  const [editSlug, setEditSlug] = useState<string | null>(null); // systems editor target
  const [busy, setBusy] = useState(false);

  // Per-row Archive / Restore / Hard-refresh — confirm, PATCH /api/clients/:slug, refresh.
  async function rowAction(c: ClientVM, action: "archive" | "restore" | "hard-refresh") {
    const prompts: Record<string, string> = {
      archive: `Archive ${c.name}? It’s marked archived and removed from the active list. You can restore it.`,
      "hard-refresh": `Hard refresh ${c.name} from ServiceNow? This overwrites its SN-owned fields and discards manual edits.`,
      restore: "",
    };
    if (prompts[action] && !confirm(prompts[action])) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/clients/${c.slug}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }),
      });
      if (!r.ok) alert((await r.json().catch(() => null))?.error ?? `could not ${action}`);
      else router.refresh();
    } finally { setBusy(false); }
  }

  async function saveDomain(slug: string, value: string) {
    setEditDomain(null);
    const v = value.trim();
    if (!v) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/clients/${slug}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set-domain", domain: v }),
      });
      if (!r.ok) alert((await r.json().catch(() => null))?.error ?? "could not set domain");
      else router.refresh();
    } finally { setBusy(false); }
  }
  const [match, setMatch] = useState<"all" | "any">("all");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  // module options: every system in use, with a usage count, most-used first
  const moduleOptions = useMemo(() => {
    const count = new Map<string, number>();
    for (const c of clients) for (const k of c.systemKeys) count.set(k, (count.get(k) ?? 0) + 1);
    return [...count.entries()]
      .map(([key, n]) => ({ key, name: NAME[key] ?? key, n }))
      .sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
  }, [clients]);

  const toggleModule = (k: string) =>
    setSelected((s) => { const x = new Set(s); x.has(k) ? x.delete(k) : x.add(k); return x; });

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sel = [...selected];
    const rows = clients.filter((c) => {
      if (statusFilter !== "all" && c.status !== statusFilter) return false;
      if (backboneFilter && c.backbone !== backboneFilter) return false;
      if (coverageFilter !== "all" && c.coverage !== coverageFilter) return false;
      if (q && ![c.name, c.coreId, c.primaryDomain, c.region, c.usernamePattern].some((v) => v?.toLowerCase().includes(q))) return false;
      if (sel.length) {
        const have = sel.filter((k) => c.systemKeys.includes(k)).length;
        if (match === "all" ? have !== sel.length : have === 0) return false;
      }
      return true;
    });
    const cmp = (a: ClientVM, b: ClientVM) => {
      const av = a[sortKey] as string | number | null, bv = b[sortKey] as string | number | null;
      if (av == null || av === "") return 1;
      if (bv == null || bv === "") return -1;
      if (typeof av === "number" && typeof bv === "number") return av - bv;
      return String(av).localeCompare(String(bv));
    };
    rows.sort(cmp);
    if (sortDir === "desc") rows.reverse();
    return rows;
  }, [clients, query, statusFilter, backboneFilter, coverageFilter, selected, match, sortKey, sortDir]);

  const toggleSort = (k: SortKey) => k === sortKey ? setSortDir((d) => (d === "asc" ? "desc" : "asc")) : (setSortKey(k), setSortDir("asc"));
  const SortHead = ({ k, label }: { k: SortKey; label: string }) => (
    <th className="sortable" onClick={() => toggleSort(k)}>{label}{sortKey === k && <span className="arrow">{sortDir === "asc" ? "▲" : "▼"}</span>}</th>
  );

  return (
    <>
      <div className="toolbar" style={{ marginTop: "1rem" }}>
        <SyncButton />
        <AddClientDialog />
      </div>

      <div className="filters">
        <input className="search" placeholder="Search name, CORE id, domain, region…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <ModulePicker options={moduleOptions} selected={selected} onToggle={toggleModule} onClear={() => setSelected(new Set())} match={match} onMatch={setMatch} />
        <select className="inline" value={backboneFilter} onChange={(e) => setBackboneFilter(e.target.value)} title="Filter by identity backbone">
          <option value="">Any backbone</option>
          <option value="entra">Entra</option>
          <option value="google">Google</option>
          <option value="ad_synced">AD synced</option>
          <option value="ad_standalone">AD standalone</option>
        </select>
        <select className="inline" value={coverageFilter} onChange={(e) => setCoverageFilter(e.target.value as never)} title="Modeled directly, inherited from a parent account, or not modeled at all">
          <option value="all">All</option>
          <option value="own">Modeled</option>
          <option value="parent">Modeled via parent</option>
          <option value="none">Not modeled</option>
        </select>
        <select className="inline" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as never)}>
          <option value="active">Active</option><option value="archived">Archived</option><option value="all">All statuses</option>
        </select>
        <span className="grow" />
        <span className="note">{visible.length} of {clients.length}</span>
      </div>

      {selected.size > 0 && (
        <p className="note" style={{ marginTop: ".4rem" }}>
          Showing clients with <strong>{match === "all" ? "all" : "any"}</strong> of:{" "}
          {[...selected].map((k) => <span key={k} className="badge" style={{ marginRight: 4 }}>{NAME[k] ?? k}</span>)}
        </p>
      )}

      <table>
        <thead>
          <tr>
            <SortHead k="name" label="Name" /><SortHead k="coreId" label="CORE id" />
            <th title="Email/UPN name format (a | separates the conflict fallback)">Email format</th>
            <SortHead k="primaryDomain" label="Domain" /><th>Backbone</th><SortHead k="systemCount" label="Systems" /><th>Status</th><th></th>
          </tr>
        </thead>
        <tbody>
          {visible.map((c) => (
            <tr key={c.id}>
              <td><Link href={`/clients/${c.slug}`}>{c.name}</Link></td>
              <td className="muted">{c.coreId ?? "—"}</td>
              <td><EmailFormat pattern={c.usernamePattern} /></td>
              <td className="muted" title="Double-click to edit the domain" onDoubleClick={() => setEditDomain(c.slug)} style={{ cursor: "text" }}>
                {editDomain === c.slug ? (
                  <input
                    autoFocus defaultValue={c.primaryDomain ?? ""} placeholder="example.com" disabled={busy}
                    onKeyDown={(e) => { if (e.key === "Enter") saveDomain(c.slug, (e.target as HTMLInputElement).value); if (e.key === "Escape") setEditDomain(null); }}
                    onBlur={(e) => saveDomain(c.slug, e.target.value)} style={{ width: 150 }}
                  />
                ) : (c.primaryDomain || "—")}
              </td>
              <td>
                {c.backbone ? <span className="badge modeled">{BACKBONE_LABEL[c.backbone] ?? c.backbone}</span>
                  : c.coverage === "parent" ? <span className="badge" title={`inherits from ${c.parentName ?? "parent"}`}>↳ via parent</span>
                  : <span className="badge unmodeled">not modeled</span>}
              </td>
              <td className="muted" style={{ cursor: c.systemCount || c.coverage === "parent" ? "help" : "default" }} title={systemsTitle(c)}>
                {c.coverage === "parent" && c.systemCount === 0 ? <span className="note">↳ {c.parentName}</span> : c.systemCount}
              </td>
              <td>{c.status === "archived" ? <span className="badge archived">archived</span> : <span className="badge">active</span>}</td>
              <td>
                <span className="icon-stack">
                  <button className="icon-btn" title="Edit systems" onClick={() => setEditSlug(c.slug)}>✎</button>
                  <button className="icon-btn" title="Hard refresh from ServiceNow (discards manual edits)" disabled={busy} onClick={() => rowAction(c, "hard-refresh")}>↻</button>
                  {c.status === "archived"
                    ? <button className="icon-btn" title="Restore (unarchive)" disabled={busy} onClick={() => rowAction(c, "restore")}>↩</button>
                    : <button className="icon-btn" title="Archive (offboard the client)" disabled={busy} onClick={() => rowAction(c, "archive")}>🗄</button>}
                </span>
              </td>
            </tr>
          ))}
          {visible.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: "center", padding: "2rem" }}>No matches.</td></tr>}
        </tbody>
      </table>

      <SystemsEditor slug={editSlug} open={!!editSlug} onClose={() => setEditSlug(null)} />
    </>
  );
}

function ModulePicker({ options, selected, onToggle, onClear, match, onMatch }: {
  options: { key: string; name: string; n: number }[]; selected: Set<string>;
  onToggle: (k: string) => void; onClear: () => void; match: "all" | "any"; onMatch: (m: "all" | "any") => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  const f = filter.trim().toLowerCase();
  const shown = f ? options.filter((o) => o.key.includes(f) || o.name.toLowerCase().includes(f)) : options;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button onClick={() => setOpen((o) => !o)}>Modules{selected.size ? ` (${selected.size})` : ""} ▾</button>
      {open && (
        <div style={{ position: "absolute", zIndex: 20, marginTop: 4, width: 280, maxHeight: 360, overflow: "auto", background: "var(--bg, #fff)", border: "1px solid var(--line, #e5e5e5)", borderRadius: 6, padding: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.1)" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
            <label style={{ margin: 0 }}><input type="radio" name="match" checked={match === "all"} onChange={() => onMatch("all")} style={{ width: "auto" }} /> all</label>
            <label style={{ margin: 0 }}><input type="radio" name="match" checked={match === "any"} onChange={() => onMatch("any")} style={{ width: "auto" }} /> any</label>
            {selected.size > 0 && <button style={{ marginLeft: "auto", fontSize: 11 }} onClick={onClear}>clear</button>}
          </div>
          <input className="search" placeholder="filter modules…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: "100%", marginBottom: 6 }} />
          {shown.map((o) => (
            <label key={o.key} style={{ display: "flex", alignItems: "center", gap: 6, margin: "2px 0", fontSize: 13 }}>
              <input type="checkbox" checked={selected.has(o.key)} onChange={() => onToggle(o.key)} style={{ width: "auto" }} />
              <span style={{ flex: 1 }}>{o.name} <span className="note">({o.key})</span></span>
              <span className="note">{o.n}</span>
            </label>
          ))}
          {shown.length === 0 && <p className="note">no match</p>}
        </div>
      )}
    </div>
  );
}
