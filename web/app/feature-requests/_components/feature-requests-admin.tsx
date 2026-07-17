"use client";

// Feature-request triage on /settings and on the board (settings.manage): each request shows its
// number, title, body, who filed it, from which page, and when. The status select saves immediately;
// the resolution note saves on blur (only when changed).
//
// Rows live in one state array here rather than inside each Row, because hiding a request MOVES it —
// off the board and into the collapsed Completed table below (and unhiding moves it back). Both
// lists are derived from that array, so a request can never render in both at once. The array
// re-adopts `initial` whenever the server sends a fresh one (router.refresh(), navigation),
// otherwise the board would keep rendering a snapshot frozen at mount.
import { useRef, useState } from "react";
import { frIsHideable, frNumber } from "@/lib/feature-requests/visibility";
import type { FeatureRequestRow } from "@/lib/feature-requests/serialize";
import { FeatureStatusBadge } from "./status-badge";
import { CompletedTable } from "../../feature-requests/_components/completed-table";
import { StatusSelect, type SendFn } from "../../feature-requests/_components/status-select";

function Row({ req, canHide, send, onChange }: {
  req: FeatureRequestRow;
  canHide: boolean;
  send: SendFn;
  onChange: (r: FeatureRequestRow) => void;
}) {
  const [note, setNote] = useState(req.resolutionNote ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onBusy = (b: boolean, e: string | null) => { setBusy(b); setErr(e); };

  // Nothing here is `disabled` while busy on purpose. The note saves on blur, and a blur fires on the
  // mousedown that precedes a click — disabling the buttons in that window would swallow the click
  // that caused it. The queue in FeatureRequestsAdmin serializes the two writes instead.
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "0.7rem 0.9rem", marginBottom: "0.6rem" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <span className="mono tnum note">{frNumber(req.number)}</span>
        <FeatureStatusBadge status={req.status} />
        <strong>{req.title}</strong>
        <span className="note">
          {req.authorEmail ?? "unknown"} · {req.page || "/"} · {new Date(req.createdAt).toLocaleString()}
        </span>
      </div>
      {req.body && <p style={{ margin: "0.35rem 0 0", whiteSpace: "pre-wrap" }}>{req.body}</p>}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: "0.55rem", flexWrap: "wrap" }}>
        <StatusSelect req={req} send={send} onChange={onChange} onBusy={onBusy} />
        <input
          value={note}
          placeholder="Resolution note (optional)"
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => {
            const next = note.trim();
            if (next === (req.resolutionNote ?? "")) return;
            onBusy(true, null);
            send(`/api/feature-requests/${req.id}`, "PATCH", { resolutionNote: next === "" ? null : next })
              .then((d) => { onChange(d); setNote(d.resolutionNote ?? ""); onBusy(false, null); })
              .catch((e2: Error) => onBusy(false, e2.message));
          }}
          style={{ flex: "1 1 220px", minWidth: 180 }}
        />
        {canHide && frIsHideable(req.status) && (
          <button
            type="button"
            onClick={() => {
              onBusy(true, null);
              send(`/api/feature-requests/${req.id}/visibility`, "POST", { action: "hide" })
                .then((d) => { onChange(d); onBusy(false, null); })
                .catch((e2: Error) => onBusy(false, e2.message));
            }}
          >
            Hide now
          </button>
        )}
        {/* The timer the status flip armed: "Hides in 5 days". */}
        {req.hideNote && <span className="note">{req.hideNote}</span>}
        {busy && <span className="note">saving…</span>}
        {err && <span className="note" style={{ color: "#b3261e" }}>{err}</span>}
      </div>
    </div>
  );
}

export function FeatureRequestsAdmin({ initial, canHide = false }: { initial: FeatureRequestRow[]; canHide?: boolean }) {
  const [rows, setRows] = useState(initial);

  // Re-adopt fresh server rows when the page re-renders. Without this the board is a snapshot taken
  // at mount, and a router.refresh() (or a colleague's change) never shows up until a full reload.
  const [seen, setSeen] = useState(initial);
  if (seen !== initial) { setSeen(initial); setRows(initial); }

  // Every write goes through one chain, so a note-save started by a blur always lands before the
  // hide the same click asked for, and the last response to arrive is the last one the server wrote.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const send: SendFn = (url, method, body) => {
    const run = async () => {
      const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const d = (await r.json().catch(() => ({}))) as FeatureRequestRow & { error?: string };
      if (!r.ok) throw new Error(d.error ?? `failed (${r.status})`);
      return d;
    };
    const p = queue.current.then(run, run); // a failed write must not stall the ones behind it
    queue.current = p.catch(() => {}); // ...nor poison the chain with an unhandled rejection
    return p;
  };

  const replace = (r: FeatureRequestRow) => setRows((prev) => prev.map((x) => (x.id === r.id ? r : x)));

  if (rows.length === 0) return <p className="note">No feature requests yet — the 💡 button in the header files one.</p>;

  const board = rows.filter((r) => !r.hidden);
  const completed = rows.filter((r) => r.hidden);

  return (
    <div>
      {board.length === 0 ? (
        <p className="note">Nothing open — every request has been completed and hidden.</p>
      ) : (
        board.map((r) => <Row key={r.id} req={r} canHide={canHide} send={send} onChange={replace} />)
      )}
      <CompletedTable rows={completed} canHide={canHide} send={send} onChange={replace} />
    </div>
  );
}
