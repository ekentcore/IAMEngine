"use client";

// Clients explorer (v2, test page): the clients table + a module multiselect filter. Pick one or
// more modules; "all" (default) shows clients that have EVERY selected module, "any" shows clients
// with at least one. Plus free-text search, status filter, and sortable columns. Native React — no
// DataTables/jQuery dependency.
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Backbone, ClientStatus } from "@prisma/client";
import { MODULES } from "@/lib/modules/catalog";

export type ClientVM = {
  id: string; slug: string; name: string; primaryDomain: string;
  backbone: Backbone | null; status: ClientStatus; coreId: string | null;
  region: string | null; systemKeys: string[]; systemCount: number; modeled: boolean;
};

const NAME: Record<string, string> = Object.fromEntries(MODULES.map((m) => [m.key, m.name]));
const BACKBONE_LABEL: Record<string, string> = { entra: "Entra", google: "Google", ad_synced: "AD synced", ad_standalone: "AD standalone" };

type SortKey = "name" | "coreId" | "region" | "primaryDomain" | "systemCount";

export function ClientsExplorer({ clients }: { clients: ClientVM[] }) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"active" | "archived" | "all">("active");
  const [backboneFilter, setBackboneFilter] = useState<string>(""); // "" = any
  const [modeledFilter, setModeledFilter] = useState<"all" | "modeled" | "unmodeled">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
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
      if (modeledFilter === "modeled" && !c.modeled) return false;
      if (modeledFilter === "unmodeled" && c.modeled) return false;
      if (q && ![c.name, c.coreId, c.primaryDomain, c.region].some((v) => v?.toLowerCase().includes(q))) return false;
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
  }, [clients, query, statusFilter, backboneFilter, modeledFilter, selected, match, sortKey, sortDir]);

  const toggleSort = (k: SortKey) => k === sortKey ? setSortDir((d) => (d === "asc" ? "desc" : "asc")) : (setSortKey(k), setSortDir("asc"));
  const SortHead = ({ k, label }: { k: SortKey; label: string }) => (
    <th className="sortable" onClick={() => toggleSort(k)}>{label}{sortKey === k && <span className="arrow">{sortDir === "asc" ? "▲" : "▼"}</span>}</th>
  );

  return (
    <>
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
        <select className="inline" value={modeledFilter} onChange={(e) => setModeledFilter(e.target.value as never)} title="Modeled = has a profile/systems">
          <option value="all">All</option>
          <option value="modeled">Modeled</option>
          <option value="unmodeled">Not modeled</option>
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
            <SortHead k="name" label="Name" /><SortHead k="coreId" label="CORE id" /><SortHead k="region" label="Region" />
            <SortHead k="primaryDomain" label="Domain" /><th>Backbone</th><SortHead k="systemCount" label="Systems" /><th>Status</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((c) => (
            <tr key={c.id}>
              <td><Link href={`/clients/${c.slug}`}>{c.name}</Link></td>
              <td className="muted">{c.coreId ?? "—"}</td>
              <td className="muted">{c.region ?? "—"}</td>
              <td className="muted">{c.primaryDomain || "—"}</td>
              <td>{c.backbone ? <span className="badge modeled">{BACKBONE_LABEL[c.backbone] ?? c.backbone}</span> : <span className="badge unmodeled">not modeled</span>}</td>
              <td className="muted" style={{ cursor: c.systemCount ? "help" : "default" }} title={c.systemKeys.length ? c.systemKeys.join(", ") : "no systems (not modeled)"}>{c.systemCount}</td>
              <td>{c.status === "archived" ? <span className="badge archived">archived</span> : <span className="badge">active</span>}</td>
            </tr>
          ))}
          {visible.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: "center", padding: "2rem" }}>No matches.</td></tr>}
        </tbody>
      </table>
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
