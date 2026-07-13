"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Child-client control for the SN account-hierarchy inheritance: by default a child with no
// modeled systems plans from its PARENT. Sometimes a child doesn't match its parent — this breaks
// the link.
//
// The copy/empty choice only makes sense for a child that is ACTUALLY inheriting (no systems of
// its own, parent modeled): keep an editable copy of the parent's systems and tweak the steps that
// differ, or start empty when many/all of them differ. A child that already has its own systems
// never inherited anything, so breaking the link there is a plain flag flip — offering to "copy"
// would merge the parent's extra systems into a client that never had them.
export function ParentInheritanceControl({
  slug,
  parentName,
  inherit,
  ownSystemCount,
  parentSystemCount,
}: {
  slug: string;
  parentName: string;
  inherit: boolean;
  ownSystemCount: number;
  parentSystemCount: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false); // breaking a live link → pick copy vs empty
  const [error, setError] = useState<string | null>(null);

  // Inheritance is only LIVE when the child has no systems of its own and the parent has some.
  // Otherwise the flag is dormant: it changes nothing today, so breaking it needs no choice.
  const live = ownSystemCount === 0 && parentSystemCount > 0;

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

  function breakLink() {
    if (live) { setChoosing(true); return; }
    // Dormant: nothing to copy or discard — just record the break.
    save(false, false);
  }

  if (choosing) {
    return (
      <span className="note" style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        Stop inheriting from {parentName} —
        <button
          type="button"
          disabled={busy}
          onClick={() => save(false, true)}
          title={`Copy ${parentName}'s ${parentSystemCount} systems and modeling onto this client first, so you can edit just the steps that differ.`}
        >
          Keep a copy to edit
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (!confirm(`Start ${slug} empty?\n\nIt will have NO modeled systems, so any case imported for it plans zero steps until you model it. Use "Keep a copy to edit" if only some steps differ from ${parentName}.`)) return;
            save(false, false);
          }}
          title="Leave this client unmodeled — model it from scratch (when many or all steps differ). Cases plan zero steps until you do."
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
        onClick={() => (inherit ? breakLink() : save(true))}
        title={inherit
          ? (live
              ? `This client has no systems of its own, so cases plan from ${parentName}'s modeling. Click to break the link (you'll choose: keep an editable copy, or start empty).`
              : ownSystemCount > 0
                ? `Inheritance is on but dormant — this client has its own ${ownSystemCount} systems, so it plans from those. Click to break the link to ${parentName} explicitly.`
                : `Inheritance is on but ${parentName} has no modeled systems, so there's nothing to inherit. Click to break the link.`)
          : `Inheritance from ${parentName} is off — this client plans only from its own systems${ownSystemCount ? "" : " (currently none: cases plan zero steps)"}. Click to inherit again${ownSystemCount ? " (takes effect only while it has no systems of its own)" : ""}.`}
        style={{ cursor: "pointer", ...(inherit
          ? { color: "var(--info-fg)", borderColor: "var(--info-bg)", background: "var(--info-bg)" }
          : { color: "var(--muted)", opacity: 0.7 }) }}
      >
        {busy ? "…" : inherit ? `⤴ inherits ${parentName}` : `✂️ not inheriting ${parentName}`}
      </button>
      {!inherit && ownSystemCount === 0 && (
        <span className="note" style={{ color: "#8a6d00" }}>unmodeled — cases plan zero steps until systems are added</span>
      )}
      {error && <span className="note danger">{error}</span>}
    </span>
  );
}
