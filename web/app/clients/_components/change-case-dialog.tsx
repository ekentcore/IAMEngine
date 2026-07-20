"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { GroupMultiselect } from "./group-multiselect";
import { OuTreePicker } from "./ad-pickers";

// Create a "change" case for an EXISTING user: either a mover (persona/location swap — the diff and
// scoped/full/add-only removal choice come later, on the preview) or an ad-hoc access change (hand-pick
// groups/DL/OU deltas, applied as given — no diff engine involved). Mirrors add-client-dialog.tsx's
// native-<dialog> + useRouter + submit-handler shape.
type Props = {
  slug: string;
  personas: string[];
  locations: string[];
  knownGroups: { name: string; type?: string }[];
  ous: string[];
  // Optional controlled open (e.g. from the client Actions menu). When provided the component renders
  // no trigger button of its own; left undefined it keeps its own "Change / move user" button.
  open?: boolean;
  onClose?: () => void;
};

type Delta = { op: "add" | "remove"; target: "group" | "dl" | "ou"; value: string };

// Comma/newline separated free text (DL names aren't discovered the way groups are) -> a clean list.
function parseList(raw: string): string[] {
  return [...new Set(raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean))];
}

export function ChangeCaseDialog({ slug, personas, locations, knownGroups, ous, open, onClose }: Props) {
  const controlled = open !== undefined;
  const ref = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const [kind, setKind] = useState<"mover" | "adhoc">("mover");
  const [user, setUser] = useState("");
  const [fromPersona, setFromPersona] = useState("");
  const [toPersona, setToPersona] = useState("");
  const [toLocation, setToLocation] = useState("");
  const [addGroups, setAddGroups] = useState<string[]>([]);
  const [removeGroups, setRemoveGroups] = useState<string[]>([]);
  const [moveToOu, setMoveToOu] = useState("");
  const [addDlRaw, setAddDlRaw] = useState("");
  const [removeDlRaw, setRemoveDlRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sections = [{ label: "Known groups", options: knownGroups.map((g) => g.name) }];

  function reset() {
    setKind("mover");
    setUser("");
    setFromPersona("");
    setToPersona("");
    setToLocation("");
    setAddGroups([]);
    setRemoveGroups([]);
    setMoveToOu("");
    setAddDlRaw("");
    setRemoveDlRaw("");
    setError(null);
    setBusy(false);
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const deltas: Delta[] = [
      ...addGroups.map((g): Delta => ({ op: "add", target: "group", value: g })),
      ...removeGroups.map((g): Delta => ({ op: "remove", target: "group", value: g })),
      ...(moveToOu ? [{ op: "add", target: "ou", value: moveToOu } as Delta] : []),
      ...parseList(addDlRaw).map((v): Delta => ({ op: "add", target: "dl", value: v })),
      ...parseList(removeDlRaw).map((v): Delta => ({ op: "remove", target: "dl", value: v })),
    ];

    const payload =
      kind === "mover"
        ? {
            userToChange: user,
            changeKind: "mover" as const,
            fromPersona: fromPersona || undefined,
            toPersona: toPersona || undefined,
            toLocation: toLocation || undefined,
          }
        : { userToChange: user, changeKind: "adhoc" as const, deltas };

    try {
      const res = await fetch("/api/cases/change", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientSlug: slug, payload }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.caseId) {
        ref.current?.close();
        router.push(`/cases/${data.caseId}`);
      } else {
        setError(data.error ?? res.statusText);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Controlled mode: mirror the parent's `open` onto the native dialog (guarded against re-showing an
  // already-open dialog or double-closing).
  useEffect(() => {
    if (!controlled) return;
    const dlg = ref.current;
    if (!dlg) return;
    if (open && !dlg.open) dlg.showModal();
    else if (!open && dlg.open) dlg.close();
  }, [controlled, open]);

  return (
    <>
      {!controlled && <button onClick={() => ref.current?.showModal()}>Change / move user</button>}
      <dialog ref={ref} onClose={() => { reset(); if (controlled) onClose?.(); }} style={{ width: "min(560px, 94vw)" }}>
        <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
          <h2>Change / move a user</h2>
          <label htmlFor="change-user">User (name or UPN)</label>
          <input id="change-user" value={user} onChange={(e) => setUser(e.target.value)} required disabled={busy} />

          <div className="toolbar" role="tablist" style={{ gap: 4 }}>
            <button type="button" role="tab" aria-selected={kind === "mover"} className={kind === "mover" ? "primary" : undefined} onClick={() => setKind("mover")} disabled={busy}>
              Mover (persona / location)
            </button>
            <button type="button" role="tab" aria-selected={kind === "adhoc"} className={kind === "adhoc" ? "primary" : undefined} onClick={() => setKind("adhoc")} disabled={busy}>
              Ad-hoc access
            </button>
          </div>

          {kind === "mover" ? (
            <>
              <label htmlFor="from-persona">From persona</label>
              <select id="from-persona" value={fromPersona} onChange={(e) => setFromPersona(e.target.value)} disabled={busy}>
                <option value="">(unknown)</option>
                {personas.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>

              <label htmlFor="to-persona">To persona</label>
              <select id="to-persona" value={toPersona} onChange={(e) => setToPersona(e.target.value)} disabled={busy}>
                <option value="">(none)</option>
                {personas.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>

              <label htmlFor="to-location">To location</label>
              <select id="to-location" value={toLocation} onChange={(e) => setToLocation(e.target.value)} disabled={busy}>
                <option value="">(none)</option>
                {locations.map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </select>
              <p className="note">You&apos;ll choose scoped vs full removal on the next screen (the preview).</p>
            </>
          ) : (
            <>
              <div>
                Add to groups
                <GroupMultiselect sections={sections} value={addGroups} onChange={setAddGroups} />
              </div>
              <div>
                Remove from groups
                <GroupMultiselect sections={sections} value={removeGroups} onChange={setRemoveGroups} />
              </div>

              <label htmlFor="add-dl">Add to distribution lists (comma-separated)</label>
              <input id="add-dl" value={addDlRaw} onChange={(e) => setAddDlRaw(e.target.value)} disabled={busy} placeholder="dl-sales, dl-allstaff" />

              <label htmlFor="remove-dl">Remove from distribution lists (comma-separated)</label>
              <input id="remove-dl" value={removeDlRaw} onChange={(e) => setRemoveDlRaw(e.target.value)} disabled={busy} placeholder="dl-oldteam" />

              <div>
                Move to OU {moveToOu && <span className="note">— selected: {moveToOu}</span>}
                <OuTreePicker ous={ous} onPick={setMoveToOu} />
                {moveToOu && (
                  <button type="button" onClick={() => setMoveToOu("")} disabled={busy}>
                    Clear OU
                  </button>
                )}
              </div>
            </>
          )}

          {error && <p className="note danger">{error}</p>}
          <div className="toolbar" style={{ justifyContent: "flex-end" }}>
            <button type="button" onClick={() => ref.current?.close()} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={busy || !user}>
              {busy ? "Creating…" : "Create change case"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
