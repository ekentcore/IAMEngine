"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Super-admin-only control to mark a client internal-only (restricted): hidden from every operator
// not granted it. Rendered on the client detail page (mirrors the badge on the /clients table).
export function RestrictedToggle({ slug, name, restricted }: { slug: string; name: string; restricted: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (!restricted && !confirm(`Restrict ${name}? It will be hidden from every operator except super admins and those you grant it to on the Users page.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/clients/${slug}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "set-restricted", restricted: !restricted }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? "could not update");
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <button
        type="button"
        className="badge"
        disabled={busy}
        onClick={toggle}
        title={restricted
          ? "Restricted (internal-only): hidden from operators not granted it. Click to unrestrict."
          : "Click to restrict: hide this client from operators who haven't been granted it (grant per-user on the Users page)."}
        style={{ cursor: "pointer", ...(restricted
          ? { color: "#a23f3f", borderColor: "#f0cece", background: "#fcf3f3" }
          : { color: "var(--muted)", opacity: 0.7 }) }}
      >
        {busy ? "…" : restricted ? "🔒 restricted" : "🔓 restrict"}
      </button>
      {error && <span className="note danger">{error}</span>}
    </span>
  );
}
