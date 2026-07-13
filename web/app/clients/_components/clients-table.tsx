"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { SyncButton } from "./sync-button";
import { AddClientDialog } from "./add-client-dialog";
import { SystemsEditor } from "./systems-editor";
import { type ClientVM, BACKBONE_LABEL, READINESS, effective, haystack, compareClients, tallyCounts } from "./client-vm";
import { patchClient, hardRefreshClients } from "./client-actions";
import { ReadinessBadge } from "./readiness-badge";
import { ClientFlagBadges } from "./client-flag-badges";
import { EmailFormatEditor, UsernamePatternDatalist } from "./email-format-editor";

export type { ClientVM } from "./client-vm";

type SortKey = "name" | "coreId" | "region" | "primaryDomain" | "onboardingRating" | "systemCount" | "status";
type SortDir = "asc" | "desc";

export function ClientsTable({ clients, canRestrict = false }: { clients: ClientVM[]; canRestrict?: boolean }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "archived">("active");
  const [modeledFilter, setModeledFilter] = useState<"all" | "modeled" | "unmodeled">("all");
  const [readyFilter, setReadyFilter] = useState<"all" | "ready" | "partial" | "not_set_up" | "no_systems">("all");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [busy, setBusy] = useState<string | null>(null);
  const [editSlug, setEditSlug] = useState<string | null>(null);

  // inline cell editing (double-click)
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

  // Via-parent resolution (shared with the v2 explorer — see client-vm.ts), computed once per
  // roster: the filter pass, counts, desktop rows, and mobile cards all read the same cached view.
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

  const visible = useMemo(() => {
    const filtered = clients.filter((c) => {
      if (statusFilter !== "all" && c.status !== statusFilter) return false;
      if (modeledFilter === "modeled" && !c.modeled) return false;
      if (modeledFilter === "unmodeled" && c.modeled) return false;
      if (readyFilter !== "all" && (eff(c).readiness?.tier ?? "no_systems") !== readyFilter) return false;
      return matchesSearch(c);
    });
    const sorted = [...filtered].sort((a, b) => compareClients(a, b, sortKey));
    if (sortDir === "desc") sorted.reverse();
    return sorted;
    // matchesSearch closes over `terms`, which is the real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clients, terms, statusFilter, modeledFilter, readyFilter, sortKey, sortDir]);

  // When a search has results that the STATUS filter is hiding, offer a one-click widen — this is
  // the usual "search looks broken" cause (you searched an archived client while viewing active).
  const hiddenByStatus = useMemo(() => {
    if (terms.length === 0 || statusFilter === "all") return 0;
    return clients.filter(
      (c) =>
        c.status !== statusFilter &&
        !(modeledFilter === "modeled" && !c.modeled) &&
        !(modeledFilter === "unmodeled" && c.modeled) &&
        matchesSearch(c)
    ).length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clients, terms, statusFilter, modeledFilter]);

  // modeled = has a profile/runbook we can act on ("who we can do"); counted within the
  // current status filter so the numbers match what's on screen.
  const counts = useMemo(
    () => tallyCounts(clients.filter((c) => statusFilter === "all" || c.status === statusFilter), eff),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clients, statusFilter, effById]
  );

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
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
        <select className="inline" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as never)}>
          <option value="active">Active</option>
          <option value="archived">Archived</option>
          <option value="all">All statuses</option>
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
        <span className="grow" />
        <span className="note result-count">
          {visible.length === clients.length ? `${clients.length} clients` : `${visible.length} of ${clients.length}`}
        </span>
      </div>
      <p className="note" style={{ margin: "0.35rem 0 0" }}>Double-click a domain, backbone, or email-format cell to edit it.</p>

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
            <SortHead k="name" label="Name" />
            <SortHead k="coreId" label="CORE id" />
            <SortHead k="primaryDomain" label="Domain" />
            <th>Backbone</th>
            <th className="help" title="Email/UPN name format. Add a conflict fallback after a | — e.g. {first}.{last} | {first}.{mi} (used when the primary username is already taken).">Email format</th>
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
              </td>
              <td className="muted mono">{c.coreId ?? "—"}</td>
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
                    ) : (
                      <span className="badge unmodeled">not modeled</span>
                    )}
                    {c.editedFields.includes("backbone") && (
                      <span className="edited-dot" title="Edited — routine sync won't overwrite. Hard refresh to reset.">●</span>
                    )}
                  </>
                )}
              </td>
              <td
                className="mono editable"
                style={{ position: "relative" }}
                title="Double-click to edit the email name format"
                onDoubleClick={() => setCell({ slug: c.slug, field: "username" })}
              >
                {/* Value stays in the cell so the row never resizes; the editor floats over it. */}
                {c.usernamePattern}
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
              <td colSpan={11}>
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
