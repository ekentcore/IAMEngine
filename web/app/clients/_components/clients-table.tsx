"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import type { Backbone, ClientStatus } from "@prisma/client";
import { SyncButton } from "./sync-button";
import { AddClientDialog } from "./add-client-dialog";
import { SystemsEditor } from "./systems-editor";

export type ClientVM = {
  id: string;
  slug: string;
  name: string;
  primaryDomain: string;
  backbone: Backbone | null;
  status: ClientStatus;
  coreId: string | null;
  region: string | null;
  supportStatus: string | null;
  onboardingRating: number | null;
  offboardingRating: number | null;
  snLastSyncedAt: string | null;
  editedFields: string[];
  systemKeys: string[];
  systemCount: number;
  modeled: boolean;
};

const BACKBONE_LABEL: Record<string, string> = {
  entra: "Entra",
  google: "Google",
  ad_synced: "AD synced",
  ad_standalone: "AD standalone",
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
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
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

export function ClientsTable({ clients }: { clients: ClientVM[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "archived">("active");
  const [modeledFilter, setModeledFilter] = useState<"all" | "modeled" | "unmodeled">("all");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [busy, setBusy] = useState<string | null>(null);
  const [editSlug, setEditSlug] = useState<string | null>(null);

  // inline cell editing (double-click)
  const [cell, setCell] = useState<{ slug: string; field: "domain" | "backbone" } | null>(null);
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
      return matchesSearch(c);
    });
    const sorted = [...filtered].sort((a, b) => compare(a, b, sortKey));
    if (sortDir === "desc") sorted.reverse();
    return sorted;
    // matchesSearch closes over `terms`, which is the real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clients, terms, statusFilter, modeledFilter, sortKey, sortDir]);

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
    return { total: inStatus.length, modeled, unmodeled: inStatus.length - modeled };
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
        <span className="grow" />
        <span className="note result-count">
          {visible.length === clients.length ? `${clients.length} clients` : `${visible.length} of ${clients.length}`}
        </span>
      </div>
      <p className="note" style={{ margin: "0.35rem 0 0" }}>Double-click a domain or backbone cell to edit it.</p>

      {hiddenByStatus > 0 && (
        <p className="note filter-hint">
          {hiddenByStatus} more match{hiddenByStatus === 1 ? "es" : ""} outside the {statusFilter} filter ·{" "}
          <button type="button" className="linklike" onClick={() => setStatusFilter("all")}>show all statuses</button>
        </p>
      )}

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
            <SortHead k="onboardingRating" label="On / Off" num />
            <SortHead k="systemCount" label="Systems" num />
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
              <td><Link className="client-name" href={`/clients/${c.slug}`}>{c.name}</Link></td>
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
                {c.status === "archived" ? (
                  <span className="badge archived">archived</span>
                ) : (
                  <span className="badge active">active</span>
                )}
              </td>
              <td className="row-actions">
                <button onClick={() => setEditSlug(c.slug)}>Edit</button>
                <button
                  title="Re-pull this client from ServiceNow, discarding manual edits"
                  onClick={() => askHardRefresh({ slugs: [c.slug], label: c.name })}
                >
                  ↻
                </button>
                {c.status === "archived" ? (
                  <button onClick={() => patch(c, "restore")} disabled={busy === c.slug}>Restore</button>
                ) : (
                  <button onClick={() => askArchive(c)} disabled={busy === c.slug}>Archive</button>
                )}
              </td>
            </tr>
          ))}
          {visible.length === 0 && (
            <tr>
              <td colSpan={9}>
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
