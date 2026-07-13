"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Child-client control for the SN account-hierarchy inheritance: by default a child with no
// modeled systems plans from its PARENT. Sometimes a child doesn't match its parent — this
// breaks the link. Breaking it asks what to do with the modeling: keep an editable COPY of the
// parent's systems on the child (then tweak the step or two that differ), or start EMPTY
// (when many/all steps are different). Rendered on the client detail page when the client has a
// parent. Re-enabling only takes effect while the child has no systems of its own.
export function ParentInheritanceControl({
  slug,
  parentName,
  inherit,
  ownSystemCount,
}: {
  slug: string;
  parentName: string;
  inherit: boolean;
  ownSystemCount: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false); // breaking the link → pick copy vs empty
  const [error, setError] = useState<string | null>(null);

  async function save(nextInherit: boolean, copy?: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/clients/${slug}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "set-parent-inheritance", inherit: nextInherit, copy: copy ?? false }),
      });
      if (!res.ok) { setError((await res.json().catch(() => ({}))).error ?? "could not update"); return; }
      setChoosing(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  // The child has its own systems: inheritance is dormant either way — surface the state plainly.
  const dormant = ownSystemCount > 0;

  if (choosing) {
    return (
      <span className="note" style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        Stop inheriting from {parentName} —
        <button
          type="button"
          disabled={busy}
          onClick={() => save(false, true)}
          title={`Copy ${parentName}'s systems and modeling onto this client first, so you can edit just the steps that differ.`}
        >
          Keep a copy to edit
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => save(false, false)}
          title="Leave this client unmodeled — model it from scratch (when many or all steps differ)."
        >
          Start empty
        </button>
        <button type="button" disabled={busy} onClick={() => { setChoosing(false); setError(null); }}>Cancel</button>
        {error && <span className="note danger">{error}</span>}
      </span>
    );
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <button
        type="button"
        className="badge"
        disabled={busy}
        onClick={() => (inherit ? setChoosing(true) : save(true))}
        title={inherit
          ? (dormant
              ? `Inheritance is on but dormant — this client has its own systems, so it plans from those. Click to break the link to ${parentName} explicitly.`
              : `This client has no systems of its own, so cases plan from ${parentName}'s modeling. Click to break the link (you'll choose: keep an editable copy, or start empty).`)
          : `Inheritance from ${parentName} is off — this client plans only from its own systems${ownSystemCount ? "" : " (currently none: it reads unmodeled)"}. Click to inherit again${ownSystemCount ? " (takes effect only while it has no systems of its own)" : ""}.`}
        style={{ cursor: "pointer", ...(inherit
          ? { color: "var(--info-fg)", borderColor: "var(--info-bg)", background: "var(--info-bg)" }
          : { color: "var(--muted)", opacity: 0.7 }) }}
      >
        {busy ? "…" : inherit ? `⤴ inherits ${parentName}` : `✂️ not inheriting ${parentName}`}
      </button>
      {error && <span className="note danger">{error}</span>}
    </span>
  );
}
