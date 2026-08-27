"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Child-client control for the ROLES/PERSONAS link to the parent — separate from the systems link
// next to it (ParentInheritanceControl). A child may legitimately run its own systems while still
// following the parent's people rules, and until FR #0000041 one gate answered both questions, so a
// child that owned a single system inherited no personas at all.
//
// Switching this ON never overwrites anything: the child's own roles always win, and the parent only
// fills in what the child leaves unset. Switching it OFF is the "option to remove them" the request
// asked for.
export function ParentModelingToggle({ slug, parentName, on }: { slug: string; parentName: string; on: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/clients/${slug}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "set-parent-modeling", inherit: !on }),
      });
      if (!res.ok) { setError((await res.json().catch(() => ({}))).error ?? "could not update"); return; }
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
        title={on
          ? `Roles, personas and every-user rules this client hasn't set of its own follow ${parentName}. Anything set here wins. Click to stop following them.`
          : `This client does not follow ${parentName}'s roles and personas. Click to follow them again — nothing set here is overwritten.`}
        style={{ cursor: "pointer", ...(on
          ? { color: "var(--muted)", opacity: 0.85 }
          : { color: "#b45309", borderColor: "#fde68a", background: "#fffbeb" }) }}
      >
        {busy ? "…" : on ? `follows ${parentName}'s roles` : "own roles only"}
      </button>
      {error && <span className="note danger">{error}</span>}
    </span>
  );
}
