"use client";

// Clients explorer (v2): the full clients table in the denser v2 shape — identity folded into one
// cell (name + flags, CORE id/region beneath), plus the module multiselect and coverage filters
// that only exist here. Functionality parity with ClientsTable (v1) is a requirement: search,
// modeled/readiness/status filters with counts, bulk hard-refresh, inline domain/backbone/email-
// format editing, intake + restricted flags, readiness column, and the mobile card list all work
// the same — the row vocabulary is shared via client-vm.ts.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { MODULES } from "@/lib/modules/catalog";
import { SyncButton } from "./sync-button";
import { AddClientDialog } from "./add-client-dialog";
import { SystemsEditor } from "./systems-editor";
import { type ClientVM, BACKBONE_LABEL, READINESS, effective, haystack, compareClients, tallyCounts } from "./client-vm";
import { patchClient, hardRefreshClients } from "./client-actions";
import { ReadinessBadge } from "./readiness-badge";
import { ClientFlagBadges } from "./client-flag-badges";
import { EmailFormatEditor, UsernamePatternDatalist } from "./email-format-editor";

export type { ClientVM } from "./client-vm";

const NAME: Record<string, string> = Object.fromEntries(MODULES.map((m) => [m.key, m.name]));

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

type SortKey = "name" | "coreId" | "primaryDomain" | "onboardingRating" | "systemCount" | "status";
type SortDir = "asc" | "desc";

export function ClientsExplorer({ clients, canRestrict = false }: { clients: ClientVM[]; canRestrict?: boolean }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"active" | "archived" | "all">("active");
  const [backboneFilter, setBackboneFilter] = useState<string>(""); // "" = any
  const [coverageFilter, setCoverageFilter] = useState<"all" | "own" | "parent" | "none">("all");
  const [modeledFilter, setModeledFilter] = useState<"all" | "modeled" | "unmodeled">("all");
  const [readyFilter, setReadyFilter] = useState<"all" | "ready" | "partial" | "not_set_up" | "no_systems">("all");
  const [moduleSel, setModuleSel] = useState<Set<string>>(new Set());
  const [match, setMatch] = useState<"all" | "any">("all");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [editSlug, setEditSlug] = useState<string | null>(null); // systems editor target
  const [busy, setBusy] = useState<string | null>(null);

  // inline cell editing (double-click), same vocabulary as v1
  const [cell, setCell] = useState<{ slug: string; field: "domain" | "backbone" | "username" } | null>(null);
  const [savingCell, setSavingCell] = useState(false);

  // archive confirmation
  const confirmRef = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState<ClientVM | null>(null);

  // multi-select + hard refresh
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const hrRef = useRef<HTMLDialogElement>(null);
  const [hrTarget, setHrTarget] = useState<{ slugs: string[]; label: string } | null>(null);
  const [hrBusy, setHrBusy] = useState(false);

  function toggleSelect(slug: string) {
    setSelected((s) => { const n = new Set(s); n.has(slug) ? n.delete(slug) : n.add(slug); return n; });
  }
  function askHardRefresh(target: { slugs: string[]; label: string }) {
    setHrTarget(target);
    hrRef.current?.showModal();
  }
  async function confirmHardRefresh() {
    const t = hrTarget;
    if (!t) return;
    setHrBusy(true);
    try {
      const r = await hardRefreshClients(t.slugs);
      // On failure keep the dialog + selection so the operator can retry — closing silently
      // would read as success.
      if (!r.ok) { alert(`Hard refresh failed: ${r.error}`); return; }
      hrRef.current?.close();
      setHrTarget(null);
      setSelected(new Set());
      router.refresh();
    } finally {
      setHrBusy(false);
    }
  }

  async function saveCell(slug: string, action: string, payload: Record<string, unknown>) {
    setSavingCell(true);
    try {
      const r = await patchClient(slug, action, payload);
      if (!r.ok) alert(`Failed: ${r.error}`);
      else {
        setCell(null);
        router.refresh();
      }
    } finally {
      setSavingCell(false);
    }
  }

  function askArchive(c: ClientVM) {
    setPending(c);
    confirmRef.current?.showModal();
  }
  async function patch(c: ClientVM, action: "archive" | "restore") {
    setBusy(c.slug);
    try {
      const r = await patchClient(c.slug, action);
      if (!r.ok) alert(`Failed: ${r.error}`);
      else router.refresh();
    } finally {
      setBusy(null);
    }
  }
  async function confirmArchive() {
    const c = pending;
    confirmRef.current?.close();
    setPending(null);
    if (c) await patch(c, "archive");
  }

  // module options: every system in use, with a usage count, most-used first
  const moduleOptions = useMemo(() => {
    const count = new Map<string, number>();
    for (const c of clients) for (const k of c.systemKeys) count.set(k, (count.get(k) ?? 0) + 1);
    return [...count.entries()]
      .map(([key, n]) => ({ key, name: NAME[key] ?? key, n }))
      .sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
  }, [clients]);

  const toggleModule = (k: string) =>
    setModuleSel((s) => { const x = new Set(s); x.has(k) ? x.delete(k) : x.add(k); return x; });

  // Via-parent resolution (shared with v1 — see client-vm.ts), computed once per roster: the
  // filter pass, counts, desktop rows, and mobile cards all read the same cached view.
  const effById = useMemo(() => {
    const byId = new Map(clients.map((c) => [c.id, c]));
    return new Map(clients.map((c) => [c.id, effective(c, byId)]));
  }, [clients]);
  const eff = (c: ClientVM) => effById.get(c.id)!;

  // Search haystacks don't depend on any filter — build them once per roster, not per keystroke.
  const hayById = useMemo(() => new Map(clients.map((c) => [c.id, haystack(c, effById.get(c.id)!)])), [clients, effById]);

  // Multi-term AND search ("entra finance" narrows to both); matches the visible columns.
  const terms = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query]);
  const matchesSearch = (c: ClientVM) => {
    if (terms.length === 0) return true;
    const hay = hayById.get(c.id)!;
    return terms.every((t) => hay.includes(t));
  };

  const matchesNonStatus = (c: ClientVM) => {
    if (backboneFilter && c.backbone !== backboneFilter) return false;
    if (coverageFilter !== "all" && c.coverage !== coverageFilter) return false;
    if (modeledFilter === "modeled" && !c.modeled) return false;
    if (modeledFilter === "unmodeled" && c.modeled) return false;
    if (readyFilter !== "all" && (eff(c).readiness?.tier ?? "no_systems") !== readyFilter) return false;
    if (moduleSel.size) {
      const sel = [...moduleSel];
      const have = sel.filter((k) => c.systemKeys.includes(k)).length;
      if (match === "all" ? have !== sel.length : have === 0) return false;
    }
    return matchesSearch(c);
  };

  const visible = useMemo(() => {
    const filtered = clients.filter((c) => (statusFilter === "all" || c.status === statusFilter) && matchesNonStatus(c));
    const sorted = [...filtered].sort((a, b) => compareClients(a, b, sortKey));
    if (sortDir === "desc") sorted.reverse();
    return sorted;
    // matchesNonStatus closes over the filter states, which are the real dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clients, terms, statusFilter, backboneFilter, coverageFilter, modeledFilter, readyFilter, moduleSel, match, sortKey, sortDir]);

  // When a search has results that the STATUS filter is hiding, offer a one-click widen — this is
  // the usual "search looks broken" cause (you searched an archived client while viewing active).
  const hiddenByStatus = useMemo(() => {
    if (terms.length === 0 || statusFilter === "all") return 0;
    return clients.filter((c) => c.status !== statusFilter && matchesNonStatus(c)).length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clients, terms, statusFilter, backboneFilter, coverageFilter, modeledFilter, readyFilter, moduleSel, match]);

  // modeled/readiness counted within the current status filter so the numbers match what's on screen.
  const counts = useMemo(
    () => tallyCounts(clients.filter((c) => statusFilter === "all" || c.status === statusFilter), eff),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clients, statusFilter, effById]
  );

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  }
  function SortHead({ k, label, num }: { k: SortKey; label: string; num?: boolean }) {
    return (
      <th className={`sortable${num ? " num" : ""}${sortKey === k ? " sorted" : ""}`} onClick={() => toggleSort(k)}>
        {label}
        <span className="arrow">{sortKey === k ? (sortDir === "asc" ? "▲" : "▼") : ""}</span>
      </th>
    );
  }

  return (
    <>
      <div className="toolbar" style={{ marginTop: "1rem" }}>
        <SyncButton />
        <AddClientDialog />
        {selected.size > 0 && (
          <button
            className="btn-danger"
            onClick={() => askHardRefresh({ slugs: [...selected], label: `${selected.size} selected client${selected.size > 1 ? "s" : ""}` })}
          >
            ↻ Hard refresh {selected.size} selected
          </button>
        )}
      </div>

      <div className="filters">
        <div className="search-field">
          <span className="search-icon" aria-hidden>⌕</span>
          <input
            className="search"
            placeholder="Search name, CORE id, domain, backbone, system…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
          {query && (
            <button type="button" className="search-clear" aria-label="Clear search" onClick={() => setQuery("")}>×</button>
          )}
        </div>
        <ModulePicker options={moduleOptions} selected={moduleSel} onToggle={toggleModule} onClear={() => setModuleSel(new Set())} match={match} onMatch={setMatch} />
        <select className="inline" value={backboneFilter} onChange={(e) => setBackboneFilter(e.target.value)} title="Filter by identity backbone">
          <option value="">Any backbone</option>
          <option value="entra">Entra</option>
          <option value="google">Google</option>
          <option value="ad_synced">AD synced</option>
          <option value="ad_standalone">AD standalone</option>
        </select>
        <select className="inline" value={coverageFilter} onChange={(e) => setCoverageFilter(e.target.value as never)} title="Modeled directly, inherited from a parent account, or not modeled at all">
          <option value="all">Any coverage</option>
          <option value="own">Modeled directly</option>
          <option value="parent">Via parent</option>
          <option value="none">Not modeled</option>
        </select>
        <select className="inline" value={modeledFilter} onChange={(e) => setModeledFilter(e.target.value as never)}>
          <option value="all">All ({counts.total})</option>
          <option value="modeled">Modeled — can do ({counts.modeled})</option>
          <option value="unmodeled">Not modeled ({counts.unmodeled})</option>
        </select>
        <select className="inline" value={readyFilter} onChange={(e) => setReadyFilter(e.target.value as never)} title="Filter by run-readiness">
          <option value="all">Any readiness</option>
          <option value="ready">Ready ({counts.ready})</option>
          <option value="partial">Partial ({counts.partial})</option>
          <option value="not_set_up">Not set up ({counts.not_set_up})</option>
          <option value="no_systems">No systems ({counts.no_systems})</option>
        </select>
        <select className="inline" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as never)}>
          <option value="active">Active</option>
          <option value="archived">Archived</option>
          <option value="all">All statuses</option>
        </select>
        <span className="grow" />
        <span className="note result-count">
          {visible.length === clients.length ? `${clients.length} clients` : `${visible.length} of ${clients.length}`}
        </span>
      </div>
      <p className="note" style={{ margin: "0.35rem 0 0" }}>Double-click a domain, backbone, or email-format cell to edit it.</p>

      {moduleSel.size > 0 && (
        <p className="note" style={{ marginTop: ".4rem" }}>
          Showing clients with <strong>{match === "all" ? "all" : "any"}</strong> of:{" "}
          {[...moduleSel].map((k) => <span key={k} className="badge" style={{ marginRight: 4 }}>{NAME[k] ?? k}</span>)}
        </p>
      )}

      {hiddenByStatus > 0 && (
        <p className="note filter-hint">
          {hiddenByStatus} more match{hiddenByStatus === 1 ? "es" : ""} outside the {statusFilter} filter ·{" "}
          <button type="button" className="linklike" onClick={() => setStatusFilter("all")}>show all statuses</button>
        </p>
      )}

      <UsernamePatternDatalist />

      <div className="table-scroll desk-only">
      <table className="data-table clients-table">
        <thead>
          <tr>
            <th style={{ width: 28 }}>
              <input
                type="checkbox"
                aria-label="Select all visible"
                style={{ width: "auto" }}
                checked={visible.length > 0 && visible.every((c) => selected.has(c.slug))}
                ref={(el) => { if (el) el.indeterminate = visible.some((c) => selected.has(c.slug)) && !visible.every((c) => selected.has(c.slug)); }}
                onChange={(e) => setSelected(e.target.checked ? new Set(visible.map((c) => c.slug)) : new Set())}
              />
            </th>
            <SortHead k="name" label="Client" />
            <SortHead k="primaryDomain" label="Domain" />
            <th className="help" title="Email/UPN name format. Add a conflict fallback after a | — e.g. {first}.{last} | {first}.{mi} (used when the primary username is already taken).">Email format</th>
            <th>Backbone</th>
            <SortHead k="onboardingRating" label="On / Off" num />
            <SortHead k="systemCount" label="Systems" num />
            <th className="help" title="Run-readiness, computed from wired credentials + connection-test results. ready = all systems wired and tested; partial = core wired but some missing/untested/failing; not set up = nothing wired.">Ready</th>
            <SortHead k="status" label="Status" />
            <th aria-label="Actions"></th>
          </tr>
        </thead>
        <tbody>
          {visible.map((c) => { const e = eff(c); return (
            <tr key={c.id} className={selected.has(c.slug) ? "row-selected" : undefined}>
              <td>
                <input
                  type="checkbox"
                  aria-label={`Select ${c.name}`}
                  style={{ width: "auto" }}
                  checked={selected.has(c.slug)}
                  onChange={() => toggleSelect(c.slug)}
                />
              </td>
              {/* Identity cell: name + flag badges, CORE id / region tucked beneath — the v2
                  merged-identity pattern (frees the CORE id column the v1 table spends). */}
              <td>
                <Link className="client-name" href={`/clients/${c.slug}`}>{c.name}</Link>
                {" "}
                <ClientFlagBadges
                  intakeSource={c.intakeSource}
                  restricted={c.restricted}
                  engineOptOut={c.engineOptOut}
                  name={c.name}
                  canRestrict={canRestrict}
                  onPatch={(action, payload) => saveCell(c.slug, action, payload)}
                />
                <div className="note mono" style={{ fontSize: 10.5, marginTop: 1 }}>
                  {c.coreId ?? "—"}{c.region ? ` · ${c.region}` : ""}
                </div>
              </td>
              <td
                className="muted mono editable"
                title="Double-click to edit the domain"
                onDoubleClick={() => setCell({ slug: c.slug, field: "domain" })}
              >
                {cell?.slug === c.slug && cell.field === "domain" ? (
                  <input
                    autoFocus
                    defaultValue={c.primaryDomain}
                    disabled={savingCell}
                    style={{ width: 150, padding: "2px 6px" }}
                    onKeyDown={(e) => {
                      // Same guard as blur: never submit an emptied value (it would wipe the domain).
                      const v = (e.target as HTMLInputElement).value;
                      if (e.key === "Enter") { if (v.trim() && v !== c.primaryDomain) saveCell(c.slug, "set-domain", { domain: v }); else setCell(null); }
                      else if (e.key === "Escape") setCell(null);
                    }}
                    onBlur={(e) => {
                      if (e.target.value.trim() && e.target.value !== c.primaryDomain) saveCell(c.slug, "set-domain", { domain: e.target.value });
                      else setCell(null);
                    }}
                  />
                ) : (
                  <>
                    {c.primaryDomain || "—"}
                    {c.editedFields.includes("primaryDomain") && (
                      <span className="edited-dot" title="Edited — routine sync won't overwrite. Hard refresh to reset.">●</span>
                    )}
                  </>
                )}
              </td>
              <td
                className="editable"
                style={{ position: "relative" }}
                title="Double-click to edit the email name format"
                onDoubleClick={() => setCell({ slug: c.slug, field: "username" })}
              >
                <EmailFormat pattern={c.usernamePattern} />
                {c.editedFields.includes("usernamePattern") && (
                  <span className="edited-dot" title="Edited — routine sync won't overwrite. Hard refresh to reset.">●</span>
                )}
                {cell?.slug === c.slug && cell.field === "username" && (
                  <EmailFormatEditor
                    currentPattern={c.usernamePattern}
                    domain={c.emailDomain ?? c.primaryDomain}
                    saving={savingCell}
                    onSave={(pattern) => saveCell(c.slug, "set-username-pattern", { pattern })}
                    onClose={() => setCell(null)}
                  />
                )}
              </td>
              <td className="editable" title="Double-click to edit the backbone" onDoubleClick={() => setCell({ slug: c.slug, field: "backbone" })}>
                {cell?.slug === c.slug && cell.field === "backbone" ? (
                  <select
                    autoFocus
                    defaultValue={c.backbone ?? ""}
                    disabled={savingCell}
                    onChange={(e) => saveCell(c.slug, "set-backbone", { backbone: e.target.value || null })}
                    onBlur={() => setCell(null)}
                  >
                    <option value="">not modeled</option>
                    <option value="entra">Entra</option>
                    <option value="google">Google</option>
                    <option value="ad_synced">AD synced</option>
                    <option value="ad_standalone">AD standalone</option>
                  </select>
                ) : (
                  <>
                    {c.backbone ? (
                      <span className="badge modeled">{BACKBONE_LABEL[c.backbone] ?? c.backbone}</span>
                    ) : c.coverage === "parent" ? (
                      <span className="badge" title={`inherits from ${c.parentName ?? "parent"}`}>↳ via parent</span>
                    ) : (
                      <span className="badge unmodeled">not modeled</span>
                    )}
                    {c.editedFields.includes("backbone") && (
                      <span className="edited-dot" title="Edited — routine sync won't overwrite. Hard refresh to reset.">●</span>
                    )}
                  </>
                )}
              </td>
              <td className="muted num tnum">{(c.onboardingRating ?? "—") + " / " + (c.offboardingRating ?? "—")}</td>
              <td className={`num tnum ${e.systemCount ? "" : "muted"}`}>
                {e.systemCount ? (
                  <span className="tip" tabIndex={0}>
                    {e.systemCount}{e.viaParent ? <sup style={{ fontSize: 9, color: "var(--muted)", marginLeft: 1 }}>P</sup> : null}
                    <span className="tip-pop">{e.systemKeys.join(", ")}{e.viaParent ? ` — inherited from ${e.viaParent}` : ""}</span>
                  </span>
                ) : (
                  "—"
                )}
              </td>
              <td>
                <ReadinessBadge readiness={e.readiness} viaParent={e.viaParent} />
              </td>
              <td>
                {c.status === "archived" ? (
                  <span className="badge archived">archived</span>
                ) : (
                  <span className="badge active">active</span>
                )}
              </td>
              <td className="row-actions">
                <span className="icon-stack" style={{ flexDirection: "row" }}>
                  <button className="icon-btn" title="Edit systems" aria-label="Edit systems" onClick={() => setEditSlug(c.slug)}>✎</button>
                  <button className="icon-btn" title="Re-pull this client from ServiceNow, discarding manual edits" aria-label="Hard refresh"
                    onClick={() => askHardRefresh({ slugs: [c.slug], label: c.name })}>↻</button>
                  {c.status === "archived" ? (
                    <button className="icon-btn" title="Restore (unarchive)" aria-label="Restore" disabled={busy === c.slug} onClick={() => patch(c, "restore")}>↩</button>
                  ) : (
                    <button className="icon-btn" title="Archive" aria-label="Archive" disabled={busy === c.slug} onClick={() => askArchive(c)}>🗄</button>
                  )}
                </span>
              </td>
            </tr>
          ); })}
          {visible.length === 0 && (
            <tr>
              <td colSpan={10}>
                <div className="empty-state">
                  {clients.length === 0 ? (
                    <>No clients yet. Click <strong>Refresh from ServiceNow</strong>.</>
                  ) : terms.length > 0 ? (
                    <>No clients match “{query.trim()}”. <button type="button" className="linklike" onClick={() => setQuery("")}>Clear search</button></>
                  ) : (
                    "No clients match the current filters."
                  )}
                </div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
      </div>

      {/* Mobile: a tappable card per client (same filtered `visible` list) — the dense table is hidden. */}
      <div className="mob-only m-list">
        {visible.map((c) => {
          const e = eff(c);
          const rd = e.readiness && e.readiness.tier !== "no_systems" ? READINESS[e.readiness.tier] : null;
          return (
            <Link key={c.slug} href={`/clients/${c.slug}`} className="m-card">
              <div className="m-card-top">
                <span className="m-card-title">{c.name}</span>
                <span className={`badge ${c.status === "archived" ? "archived" : "active"}`}>{c.status}</span>
              </div>
              <div className="m-card-sub">{c.coreId ?? "—"}{c.primaryDomain ? ` · ${c.primaryDomain}` : ""}</div>
              <div className="m-card-meta">
                {c.backbone && <span><span className="k">backbone</span> {BACKBONE_LABEL[c.backbone] ?? c.backbone}</span>}
                <span><span className="k">systems</span> {e.systemCount || "—"}{e.viaParent ? " (via parent)" : ""}</span>
                <span>
                  <span className="k">ready</span>{" "}
                  {rd ? <span className="badge" style={{ color: rd.color, background: rd.bg }}>{rd.mark} {rd.label}</span> : "—"}
                </span>
              </div>
            </Link>
          );
        })}
        {visible.length === 0 && <div className="note" style={{ padding: "1rem 0" }}>No clients match.</div>}
      </div>

      <dialog ref={confirmRef}>
        <h2>Archive client</h2>
        <p>
          Archive <strong>{pending?.name}</strong>? This offboards the client — it’s removed from
          the active list and marked archived. You can restore it afterwards.
        </p>
        <div className="dialog-actions">
          <button onClick={() => { confirmRef.current?.close(); setPending(null); }}>Cancel</button>
          <button className="btn-danger" onClick={confirmArchive}>Archive</button>
        </div>
      </dialog>

      <dialog ref={hrRef}>
        <h2>Hard refresh from ServiceNow</h2>
        <p>
          Overwrite <strong>{hrTarget?.label}</strong> with the latest ServiceNow data — including
          the website domain — and <strong>discard any manual edits</strong> (the ● fields). This
          can&apos;t be undone.
        </p>
        <div className="dialog-actions">
          <button onClick={() => { hrRef.current?.close(); setHrTarget(null); }} disabled={hrBusy}>Cancel</button>
          <button className="btn-danger" onClick={confirmHardRefresh} disabled={hrBusy}>
            {hrBusy ? "Refreshing…" : `Hard refresh${hrTarget && hrTarget.slugs.length > 1 ? ` ${hrTarget.slugs.length}` : ""}`}
          </button>
        </div>
      </dialog>

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
