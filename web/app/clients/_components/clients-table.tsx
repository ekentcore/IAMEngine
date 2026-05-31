"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
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
  systemCount: number;
  modeled: boolean;
};

const BACKBONE_LABEL: Record<string, string> = {
  entra: "Entra",
  google: "Google",
  ad_synced: "AD synced",
  ad_standalone: "AD standalone",
};

export function ClientsTable({ clients }: { clients: ClientVM[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function toggleArchive(c: ClientVM) {
    const action = c.status === "archived" ? "restore" : "archive";
    if (action === "archive" && !confirm(`Archive ${c.name}? (offboard a client)`)) return;
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

  return (
    <>
      <div className="toolbar" style={{ marginTop: "1rem" }}>
        <SyncButton />
        <AddClientDialog />
      </div>

      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>CORE id</th>
            <th>Region</th>
            <th>Domain</th>
            <th>Backbone</th>
            <th>On / Off</th>
            <th>Systems</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {clients.map((c) => (
            <tr key={c.id}>
              <td>
                <Link href={`/clients/${c.slug}`}>{c.name}</Link>
              </td>
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
              <td className="muted">
                {(c.onboardingRating ?? "—") + " / " + (c.offboardingRating ?? "—")}
              </td>
              <td className="muted">{c.systemCount}</td>
              <td>
                {c.status === "archived" ? (
                  <span className="badge archived">archived</span>
                ) : (
                  <span className="badge">active</span>
                )}
              </td>
              <td>
                <button onClick={() => toggleArchive(c)} disabled={busy === c.slug}>
                  {c.status === "archived" ? "Restore" : "Archive"}
                </button>
              </td>
            </tr>
          ))}
          {clients.length === 0 && (
            <tr>
              <td colSpan={9} className="muted" style={{ textAlign: "center", padding: "2rem" }}>
                No clients yet. Click “Refresh from ServiceNow”.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
