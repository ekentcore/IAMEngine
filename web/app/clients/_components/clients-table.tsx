"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import type { Backbone, ClientStatus } from "@prisma/client";
import { SyncButton } from "./sync-button";
import { AddClientDialog } from "./add-client-dialog";
import { SystemsEditor } from "./systems-editor";
import type { ClientReadiness } from "@/lib/clients/readiness";

export type ClientVM = {
  id: string;
  slug: string;
  name: string;
  primaryDomain: string;
  backbone: Backbone | null;
  status: ClientStatus;
  intakeSource: string;
  restricted: boolean;
  coreId: string | null;
  region: string | null;
  supportStatus: string | null;
  onboardingRating: number | null;
  offboardingRating: number | null;
  snLastSyncedAt: string | null;
  editedFields: string[];
  emailDomain: string | null;
  usernamePattern: string;
  systemKeys: string[];
  systemCount: number;
  modeled: boolean;
  readiness: ClientReadiness;
};

const BACKBONE_LABEL: Record<string, string> = {
  entra: "Entra",
  google: "Google",
  ad_synced: "AD synced",
  ad_standalone: "AD standalone",
};

// Run-readiness badge styling per tier (computed from wired secrets + connection-test results).
const READINESS: Record<string, { label: string; mark: string; color: string; bg: string }> = {
  ready: { label: "ready", mark: "✓", color: "#2e7d32", bg: "#eaf5ec" },
  partial: { label: "partial", mark: "◑", color: "#8a6d00", bg: "#fbf4e0" },
  not_set_up: { label: "not set up", mark: "✗", color: "#b3261e", bg: "#fdeceb" },
  no_systems: { label: "—", mark: "", color: "var(--muted)", bg: "transparent" },
};

type SortKey = "name" | "coreId" | "region" | "primaryDomain" | "onboardingRating" | "systemCount" | "status";
type SortDir = "asc" | "desc";

// Everything a row exposes, flattened for search — so the box matches what you can SEE
// (incl. the Backbone + Systems columns) and the slug. Lowercased once per client.
function haystack(c: ClientVM): string {
  return [
    c.name, c.slug, c.coreId, c.region, c.primaryDomain, c.supportStatus,
    c.backbone ? BACKBONE_LABEL[c.backbone] ?? c.backbone : "",
    c.systemKeys.join(" "),
    c.readiness ? READINESS[c.readiness.tier]?.label : "",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

// Live preview of an email/UPN name format using a fixed sample person, "John Jason Doe"
// (first John, middle Jason, last Doe). Mirrors the runner's applyUsernamePattern tokens.
function formatPreview(localPattern: string, domain: string | null): string {
  const v: Record<string, string> = {
    first: "john", last: "doe", mi: "j", f: "j", l: "d", firstinitial: "j", lastinitial: "d",
  };
  const local = localPattern.replace(/\{[a-zA-Z]+\}/g, (tok) => {
    const k = tok.slice(1, -1).toLowerCase();
    return k in v ? v[k] : tok;
  });
  return `${local}@${domain || "domain.com"}`;
}

// null/empty sorts last regardless of direction.
function compare(a: ClientVM, b: ClientVM, key: SortKey): number {
  const av = a[key];
  const bv = b[key];
  const aEmpty = av === null || av === "";
  const bEmpty = bv === null || bv === "";
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  if (typeof av === "number" && typeof bv === "number") return av - bv;
  return String(av).localeCompare(String(bv));
}

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
  const [draft, setDraft] = useState(""); // live PRIMARY value while editing the email-format cell
  const [draftBackup, setDraftBackup] = useState(""); // live BACKUP (conflict fallback) value

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
      if (t.slugs.length === 1) {
        await fetch(`/api/clients/${t.slugs[0]}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "hard-refresh" }),
        });
      } else {
        await fetch(`/api/clients/hard-refresh`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slugs: t.slugs }),
        });
      }
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
      const res = await fetch(`/api/clients/${slug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...payload }),
      });
      if (!res.ok) alert(`Failed: ${(await res.json()).error ?? res.statusText}`);
      else {
        setCell(null);
        router.refresh();
      }
    } finally {
      setSavingCell(false);
    }
  }

  // Commit the email-format edit: combine Primary + optional Backup into "primary | backup" (the
  // route splits on "|"; the backup is used when the primary UPN is already taken by someone else).
  function commitUsername(slug: string, currentPattern: string) {
    const combined = draft.trim() + (draftBackup.trim() ? ` | ${draftBackup.trim()}` : "");
    if (draft.trim() && combined !== currentPattern) saveCell(slug, "set-username-pattern", { pattern: combined });
    else setCell(null);
  }

  // Multi-term AND search ("entra finance" narrows to both); matches the visible columns.
  const terms = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query]);
  const matchesSearch = (c: ClientVM) => {
    if (terms.length === 0) return true;
    const hay = haystack(c);
    return terms.every((t) => hay.includes(t));
  };

  const visible = useMemo(() => {
    const filtered = clients.filter((c) => {
      if (statusFilter !== "all" && c.status !== statusFilter) return false;
      if (modeledFilter === "modeled" && !c.modeled) return false;
      if (modeledFilter === "unmodeled" && c.modeled) return false;
      if (readyFilter !== "all" && (c.readiness?.tier ?? "no_systems") !== readyFilter) return false;
      return matchesSearch(c);
    });
    const sorted = [...filtered].sort((a, b) => compare(a, b, sortKey));
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
  const counts = useMemo(() => {
    const inStatus = clients.filter((c) => statusFilter === "all" || c.status === statusFilter);
    const modeled = inStatus.filter((c) => c.modeled).length;
    const byTier = (t: string) => inStatus.filter((c) => (c.readiness?.tier ?? "no_systems") === t).length;
    return {
      total: inStatus.length, modeled, unmodeled: inStatus.length - modeled,
      ready: byTier("ready"), partial: byTier("partial"), not_set_up: byTier("not_set_up"), no_systems: byTier("no_systems"),
    };
  }, [clients, statusFilter]);

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
      const res = await fetch(`/api/clients/${c.slug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) alert(`Failed: ${(await res.json()).error ?? res.statusText}`);
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

      <datalist id="username-patterns">
        <option value="{first}.{last}">first.last</option>
        <option value="{f}{last}">flast</option>
        <option value="{first}{l}">firstl</option>
        <option value="{first}_{last}">first_last</option>
        <option value="{first}-{last}">first-last</option>
        <option value="{last}.{first}">last.first</option>
        <option value="{first}">first</option>
      </datalist>

      <div className="table-scroll">
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
          {visible.map((c) => (
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
                <span
                  className="badge"
                  role="button"
                  tabIndex={0}
                  title="Intake source — internal scans onboarding incidents, external scans UM cases. Click to toggle."
                  onClick={() => saveCell(c.slug, "set-intake-source", { intakeSource: c.intakeSource === "incident" ? "um" : "incident" })}
                  style={{ cursor: "pointer", ...(c.intakeSource === "incident"
                    ? { color: "#7b3fa0", borderColor: "#e0cef0", background: "#f8f3fc" }
                    : { color: "var(--muted)", opacity: 0.65 }) }}
                >
                  {c.intakeSource === "incident" ? "internal" : "external"}
                </span>
                {/* Restricted (internal-only) flag — SUPER ADMIN ONLY (the option is hidden from
                    everyone else). Restricting hides the client from every operator not granted it. */}
                {canRestrict && (
                  <>
                    {" "}
                    <span
                      className="badge"
                      role="button"
                      tabIndex={0}
                      title={
                        c.restricted
                          ? "Restricted (internal-only): hidden from operators not granted it. Click to unrestrict."
                          : "Click to restrict: hide this client from operators who haven't been granted it (grant per-user on the Users page)."
                      }
                      onClick={() => {
                        if (!c.restricted && !confirm(`Restrict ${c.name}? It will be hidden from every operator (except super admins and those you grant it to on the Users page).`)) return;
                        saveCell(c.slug, "set-restricted", { restricted: !c.restricted });
                      }}
                      style={{
                        cursor: "pointer",
                        ...(c.restricted
                          ? { color: "#a23f3f", borderColor: "#f0cece", background: "#fcf3f3" }
                          : { color: "var(--muted)", opacity: 0.5 }),
                      }}
                    >
                      {c.restricted ? "🔒 restricted" : "🔓 restrict"}
                    </span>
                  </>
                )}
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
                      if (e.key === "Enter") saveCell(c.slug, "set-domain", { domain: (e.target as HTMLInputElement).value });
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
                onDoubleClick={() => {
                  const parts = c.usernamePattern.split("|").map((s) => s.trim());
                  setCell({ slug: c.slug, field: "username" });
                  setDraft(parts[0] ?? "");
                  setDraftBackup(parts.slice(1).join(" | "));
                }}
              >
                {/* Value stays in the cell so the row never resizes; the editor floats over it. */}
                {c.usernamePattern}
                {c.editedFields.includes("usernamePattern") && (
                  <span className="edited-dot" title="Edited — routine sync won't overwrite. Hard refresh to reset.">●</span>
                )}
                {cell?.slug === c.slug && cell.field === "username" && (
                  <div
                    // Save when focus leaves the whole editor — NOT when moving between Primary/Backup.
                    onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) commitUsername(c.slug, c.usernamePattern); }}
                    style={{
                      position: "absolute", top: "100%", left: 0, zIndex: 40, marginTop: 2,
                      background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 6,
                      padding: "8px 10px", boxShadow: "0 6px 18px rgba(0,0,0,0.18)", width: 200, textAlign: "left",
                    }}
                  >
                    <label className="muted" style={{ display: "block", fontSize: 10 }}>Primary</label>
                    <input
                      autoFocus
                      list="username-patterns"
                      value={draft}
                      disabled={savingCell}
                      placeholder="{first}.{last}"
                      style={{ width: "100%", padding: "2px 6px", boxSizing: "border-box" }}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitUsername(c.slug, c.usernamePattern);
                        else if (e.key === "Escape") setCell(null);
                      }}
                    />
                    <label className="muted" style={{ display: "block", fontSize: 10, marginTop: 6 }}>Backup (if primary is taken)</label>
                    <input
                      list="username-patterns"
                      value={draftBackup}
                      disabled={savingCell}
                      placeholder="{first}.{mi} (optional)"
                      style={{ width: "100%", padding: "2px 6px", boxSizing: "border-box" }}
                      onChange={(e) => setDraftBackup(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitUsername(c.slug, c.usernamePattern);
                        else if (e.key === "Escape") setCell(null);
                      }}
                    />
                    <div className="note" style={{ marginTop: 4 }}>
                      John Jason Doe → {formatPreview(draft, c.emailDomain ?? c.primaryDomain)}
                      {draftBackup.trim() && <><br />backup → {formatPreview(draftBackup, c.emailDomain ?? c.primaryDomain)}</>}
                    </div>
                  </div>
                )}
              </td>
              <td className="muted num tnum">{(c.onboardingRating ?? "—") + " / " + (c.offboardingRating ?? "—")}</td>
              <td className={`num tnum ${c.systemCount ? "" : "muted"}`}>
                {c.systemCount ? (
                  <span className="tip" tabIndex={0}>
                    {c.systemCount}
                    <span className="tip-pop">{c.systemKeys.join(", ")}</span>
                  </span>
                ) : (
                  "—"
                )}
              </td>
              <td>
                {c.readiness && c.readiness.tier !== "no_systems" ? (
                  <span className="badge" title={c.readiness.summary}
                    style={{ color: READINESS[c.readiness.tier].color, background: READINESS[c.readiness.tier].bg, borderColor: "transparent", cursor: "help" }}>
                    {READINESS[c.readiness.tier].mark} {READINESS[c.readiness.tier].label}
                  </span>
                ) : (
                  <span className="muted">—</span>
                )}
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
          ))}
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
