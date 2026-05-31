"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import type { Backbone, ClientStatus } from "@prisma/client";
import { SyncButton } from "./sync-button";
import { AddClientDialog } from "./add-client-dialog";

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

  // archive confirmation
  const confirmRef = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState<ClientVM | null>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = clients.filter((c) => {
      if (statusFilter !== "all" && c.status !== statusFilter) return false;
      if (modeledFilter === "modeled" && !c.modeled) return false;
      if (modeledFilter === "unmodeled" && c.modeled) return false;
      if (!q) return true;
      return [c.name, c.coreId, c.region, c.primaryDomain, c.supportStatus]
        .some((v) => v?.toLowerCase().includes(q));
    });
    const sorted = [...filtered].sort((a, b) => compare(a, b, sortKey));
    if (sortDir === "desc") sorted.reverse();
    return sorted;
  }, [clients, query, statusFilter, modeledFilter, sortKey, sortDir]);

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

  function SortHead({ k, label }: { k: SortKey; label: string }) {
    return (
      <th className="sortable" onClick={() => toggleSort(k)}>
        {label}
        {sortKey === k && <span className="arrow">{sortDir === "asc" ? "▲" : "▼"}</span>}
      </th>
    );
  }

  return (
    <>
      <div className="toolbar" style={{ marginTop: "1rem" }}>
        <SyncButton />
        <AddClientDialog />
      </div>

      <div className="filters">
        <input
          className="search"
          placeholder="Search name, CORE id, domain, region…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select className="inline" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as never)}>
          <option value="active">Active</option>
          <option value="archived">Archived</option>
          <option value="all">All statuses</option>
        </select>
        <select className="inline" value={modeledFilter} onChange={(e) => setModeledFilter(e.target.value as never)}>
          <option value="all">All</option>
          <option value="modeled">Modeled</option>
          <option value="unmodeled">Not modeled</option>
        </select>
        <span className="grow" />
        <span className="note">
          {visible.length} of {clients.length}
        </span>
      </div>

      <table>
        <thead>
          <tr>
            <SortHead k="name" label="Name" />
            <SortHead k="coreId" label="CORE id" />
            <SortHead k="region" label="Region" />
            <SortHead k="primaryDomain" label="Domain" />
            <th>Backbone</th>
            <SortHead k="onboardingRating" label="On / Off" />
            <SortHead k="systemCount" label="Systems" />
            <SortHead k="status" label="Status" />
            <th></th>
          </tr>
        </thead>
        <tbody>
          {visible.map((c) => (
            <tr key={c.id}>
              <td><Link href={`/clients/${c.slug}`}>{c.name}</Link></td>
              <td className="muted">{c.coreId ?? "—"}</td>
              <td className="muted">{c.region ?? "—"}</td>
              <td className="muted">{c.primaryDomain || "—"}</td>
              <td>
                {c.backbone ? (
                  <span className="badge modeled">{BACKBONE_LABEL[c.backbone] ?? c.backbone}</span>
                ) : (
                  <span className="badge unmodeled">not modeled</span>
                )}
              </td>
              <td className="muted">{(c.onboardingRating ?? "—") + " / " + (c.offboardingRating ?? "—")}</td>
              <td
                className="muted"
                style={{ cursor: c.systemCount ? "help" : "default" }}
                title={c.systemKeys.length ? c.systemKeys.join(", ") : "no systems (not modeled)"}
              >
                {c.systemCount}
              </td>
              <td>
                {c.status === "archived" ? (
                  <span className="badge archived">archived</span>
                ) : (
                  <span className="badge">active</span>
                )}
              </td>
              <td>
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
              <td colSpan={9} className="muted" style={{ textAlign: "center", padding: "2rem" }}>
                {clients.length === 0 ? "No clients yet. Click “Refresh from ServiceNow”." : "No matches."}
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
    </>
  );
}
