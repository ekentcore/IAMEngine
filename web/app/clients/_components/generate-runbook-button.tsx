"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { SectionsEditor, type Section } from "./sections-editor";

// Build the runbook FROM the client's modeled systems — for internal/KB-less clients (e.g.
// Coretelligent). Instead of saving straight away, it PREVIEWS the generated onboard + offboard
// sections in a dialog (two tabs) so the operator can reorder / edit / add / remove before saving —
// then Save writes both, or Cancel discards without touching the stored runbook.
const ACTIONS = ["onboard", "offboard"] as const;
type Act = (typeof ACTIONS)[number];

// null = generated (a real section array, possibly edited to empty); undefined = no systems
// participate in that action, so there's nothing to preview or save for it.
type Built = Record<Act, Section[] | undefined>;

export function GenerateRunbookButton({ slug }: { slug: string }) {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [built, setBuilt] = useState<Built>({ onboard: undefined, offboard: undefined });
  const [active, setActive] = useState<Act>("onboard");

  async function post(action: Act, body: object) {
    return fetch(`/api/clients/${slug}/runbook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...body }),
    });
  }

  // Generate BOTH actions' sections (preview, no save) and open the dialog.
  async function build() {
    setBusy(true);
    setError(null);
    try {
      const next: Built = { onboard: undefined, offboard: undefined };
      for (const action of ACTIONS) {
        const res = await post(action, { fromSystems: true, preview: true });
        if (res.status === 422) continue; // no systems participate in this action — leave undefined
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          setError(j.error ?? `failed (${res.status})`);
          return;
        }
        const j = await res.json();
        next[action] = (j.sections ?? []) as Section[];
      }
      if (!next.onboard && !next.offboard) {
        setError("No systems participate in onboard or offboard yet — set Onboard/Offboard on Edit systems first.");
        return;
      }
      setBuilt(next);
      setActive(next.onboard ? "onboard" : "offboard");
      ref.current?.showModal();
    } finally {
      setBusy(false);
    }
  }

  // Save every action that has at least one section (an emptied tab is left untouched, not wiped).
  async function save() {
    setBusy(true);
    setError(null);
    try {
      for (const action of ACTIONS) {
        const sections = built[action];
        if (!sections || sections.length === 0) continue;
        const res = await post(action, { sections });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          setError(j.error ?? `failed to save ${action} (${res.status})`);
          return;
        }
      }
      ref.current?.close();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  function editActive(fn: (prev: Section[]) => Section[]) {
    setBuilt((b) => (b[active] ? { ...b, [active]: fn(b[active]!) } : b));
  }

  const sections = built[active];
  const savable = ACTIONS.some((a) => (built[a]?.length ?? 0) > 0);

  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
      <button onClick={build} disabled={busy} title="Generate the runbook sections from the modeled systems (for clients with no ServiceNow KB) — preview before saving">
        {busy && !ref.current?.open ? "Building…" : "⚙ Build from systems"}
      </button>
      {error && !ref.current?.open && <span className="note danger">{error}</span>}

      <dialog ref={ref} onClose={() => setError(null)} style={{ width: "min(820px, 94vw)" }}>
        <h2>Build runbook from systems</h2>
        <p className="note">
          Generated from the modeled systems — one section per system that participates in the action. Review and edit
          below (reorder ▲▼, fix a line, ✕ remove, + add), then Save. Nothing is written until you Save; Cancel discards.
          <b> Saving replaces the current onboard / offboard runbook.</b>
        </p>

        <div className="toolbar" role="tablist" style={{ marginBottom: "0.5rem", gap: 4 }}>
          {ACTIONS.map((a) => (
            <button
              key={a}
              role="tab"
              aria-selected={active === a}
              onClick={() => setActive(a)}
              className={active === a ? "primary" : undefined}
              disabled={busy}
              title={built[a] === undefined ? `No systems participate in ${a}` : `Review the ${a} runbook`}
            >
              {a}{" "}
              <span className="note" style={{ fontSize: 10 }}>
                ({built[a] === undefined ? "none" : `${built[a]!.length} section${built[a]!.length === 1 ? "" : "s"}`})
              </span>
            </button>
          ))}
        </div>

        {sections === undefined ? (
          <p className="note">No systems participate in <b>{active}</b>. Set the {active} lane on <b>Edit systems</b> to include a system here.</p>
        ) : sections.length === 0 ? (
          <p className="note danger">All sections removed — the <b>{active}</b> runbook will be left unchanged (not wiped) on Save.</p>
        ) : (
          <div style={{ maxHeight: "52vh", overflowY: "auto" }}>
            <SectionsEditor sections={sections} onChange={editActive} />
          </div>
        )}

        {error && <p className="note danger">{error}</p>}

        <div className="toolbar" style={{ marginTop: "0.75rem", justifyContent: "flex-end" }}>
          <button type="button" onClick={() => ref.current?.close()} disabled={busy}>Cancel</button>
          <button type="button" className="primary" onClick={save} disabled={busy || !savable}>
            {busy ? "Saving…" : "Save runbook"}
          </button>
        </div>
      </dialog>
    </span>
  );
}
