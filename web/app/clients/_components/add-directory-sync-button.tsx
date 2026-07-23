"use client";

// Shown under the Systems heading when a hybrid client (on-prem active-directory + a cloud
// identity system) has no `directory-sync` row. Renders the existing warning box plus a button
// that opens a prefilled confirm dialog; confirming POSTs to /directory-sync, which atomically
// adds the ClientSystem row, optionally sets backbone=ad_synced, AND inserts the directory-sync
// runbook section into onboard + offboard. See
// docs/superpowers/specs/2026-07-22-add-directory-sync-button-design.md.
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { DirectorySyncOpts } from "@/lib/clients/directory-sync-row";

export function AddDirectorySyncButton({
  slug,
  hasExchange,
  backbone,
}: {
  slug: string;
  hasExchange: boolean;
  backbone: string | null;
}) {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const [orderAfter, setOrderAfter] = useState<DirectorySyncOpts["orderAfter"]>(
    hasExchange ? "exchange" : "active-directory",
  );
  const alreadySynced = backbone === "ad_synced";
  // Checked by default in both cases; when the client is already ad-synced the checkbox is also
  // disabled (shown checked, nothing to change) — see the design's backbone constraint.
  const [setAdSynced, setSetAdSynced] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openDialog() {
    setError(null);
    ref.current?.showModal();
  }
  function closeDialog() {
    if (!saving) ref.current?.close();
  }

  async function confirm() {
    setSaving(true);
    setError(null);
    try {
      // One atomic call: the server ensures the ClientSystem row, optionally sets the backbone, and
      // inserts the runbook section into both lanes. Idempotent — safe to re-run.
      const res = await fetch(`/api/clients/${slug}/directory-sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderAfter, setAdSynced }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? `Save failed (${res.status})`);
        return;
      }
      ref.current?.close();
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <p
        className="note"
        style={{
          color: "var(--warn-fg)",
          border: "1px solid var(--warn-fg)",
          background: "var(--warn-bg)",
          borderRadius: 8,
          padding: "0.5rem 0.7rem",
          margin: "0 0 0.75rem",
        }}
      >
        ⚠ Hybrid client with on-prem Active Directory <b>and</b> cloud systems, but{" "}
        <b>no directory-sync step</b>. New AD accounts won&rsquo;t be pushed to Entra before the
        cloud steps run — they can race or fail. Add <b>directory-sync</b> (depends on{" "}
        <code>active-directory</code>) below, or in <b>Edit systems</b>.
        <br />
        <button type="button" onClick={openDialog} style={{ marginTop: 8 }}>
          Add directory-sync
        </button>
      </p>

      <dialog ref={ref} style={{ maxWidth: 520, borderRadius: 8, border: "1px solid var(--line)" }}>
        <h3 style={{ marginTop: 0 }}>Add directory-sync</h3>
        <p className="note">
          Adds a <code>directory-sync</code> system <b>and</b> a matching runbook step (onboard and
          offboard) so AD accounts sync to Entra before the cloud steps run. Mode <code>api</code>.
          Uses the <code>ad-dc</code> secret, which is optional — the DC agent authenticates as
          SYSTEM, so no credential wiring is required for it to run.
        </p>

        <label style={{ display: "block", margin: "0.75rem 0" }}>
          Order after
          <br />
          <select
            value={orderAfter}
            onChange={(e) => setOrderAfter(e.target.value as DirectorySyncOpts["orderAfter"])}
            disabled={saving}
          >
            <option value="active-directory">active-directory</option>
            {/* Only offer exchange when the client actually has it — otherwise the row would
                depend on a system that isn't there. */}
            {hasExchange && <option value="exchange">exchange (wait for mailbox)</option>}
          </select>
        </label>

        <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "0.75rem 0" }}>
          <input
            type="checkbox"
            checked={setAdSynced}
            disabled={saving || alreadySynced}
            onChange={(e) => setSetAdSynced(e.target.checked)}
          />
          {alreadySynced
            ? "Backbone is already ad-synced"
            : "Also set backbone to ad-synced"}
        </label>

        {error && (
          <p className="note" style={{ color: "#b91c1c" }}>
            {error}
          </p>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
          <button type="button" onClick={closeDialog} disabled={saving}>
            Cancel
          </button>
          <button type="button" onClick={confirm} disabled={saving}>
            {saving ? "Adding…" : "Add directory-sync"}
          </button>
        </div>
      </dialog>
    </>
  );
}
