"use client";

// The collapsed Completed table under the board: every request whose hide timer has run out (7 days
// after it was marked Implemented) plus anything an admin hid early. Collapsed by default — the
// point of hiding is that the board stays short — but never deleted, so a request can always be
// looked up by its number.
//
// Admins keep BOTH controls here, not just the unhide:
//   - the status select, so a retired request can be reopened (set it back to Planned / Being
//     scripted and it drops its timer and returns to the board) without first having to grant it
//     another week just to reach the control;
//   - "Show 7 more days", which puts it back on the board for another full window. It can be clicked
//     again each time that window runs out.
// Read-only viewers get neither — the table renders, the controls do not.
import { useState } from "react";
import type { FeatureRequestRow } from "@/lib/feature-requests/serialize";
import { FR_HIDE_WINDOW_DAYS, frNumber } from "@/lib/feature-requests/visibility";
import { StatusSelect, type SendFn } from "./status-select";
import { FeatureStatusBadge } from "./status-badge";

function Controls({ row, canHide, send, onChange }: {
  row: FeatureRequestRow;
  canHide: boolean;
  send: SendFn;
  onChange: (r: FeatureRequestRow) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const onBusy = (b: boolean, e: string | null) => { setBusy(b); setErr(e); };

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, whiteSpace: "nowrap" }}>
      <StatusSelect req={row} send={send} onChange={onChange} onBusy={onBusy} />
      {canHide && (
        <button
          type="button"
          onClick={() => {
            onBusy(true, null);
            send(`/api/feature-requests/${row.id}/visibility`, "POST", { action: "unhide" })
              .then((d) => { onChange(d); onBusy(false, null); })
              .catch((e: Error) => onBusy(false, e.message));
          }}
        >
          Show {FR_HIDE_WINDOW_DAYS} more days
        </button>
      )}
      {busy && <span className="note">saving…</span>}
      {err && <span className="note" style={{ color: "#b3261e" }}>{err}</span>}
    </span>
  );
}

export function CompletedTable({ rows, canHide = false, send, onChange }: {
  rows: FeatureRequestRow[];
  canHide?: boolean;
  send?: SendFn;
  onChange?: (r: FeatureRequestRow) => void;
}) {
  if (rows.length === 0) return null;
  const editable = send !== undefined && onChange !== undefined;

  return (
    <details style={{ marginTop: "1.6rem" }}>
      <summary style={{ cursor: "pointer", color: "var(--faint)", fontSize: 13 }}>
        Completed ({rows.length})
      </summary>
      <table>
        <thead>
          <tr>
            <th style={{ width: "1%", whiteSpace: "nowrap" }}>Number</th>
            <th>Request</th>
            <th style={{ width: "1%", whiteSpace: "nowrap" }}>Status</th>
            <th style={{ width: "1%", whiteSpace: "nowrap" }}>Filed by</th>
            {editable && <th style={{ width: "1%" }} />}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="mono tnum" style={{ whiteSpace: "nowrap" }}>{frNumber(r.number)}</td>
              <td>
                {r.title}
                {r.resolutionNote && (
                  <div className="note" style={{ marginTop: "0.15rem" }}>↳ {r.resolutionNote}</div>
                )}
              </td>
              <td><FeatureStatusBadge status={r.status} /></td>
              <td className="note" style={{ whiteSpace: "nowrap" }}>{r.authorEmail ?? "unknown"}</td>
              {editable && (
                <td>
                  <Controls row={r} canHide={canHide} send={send} onChange={onChange} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
