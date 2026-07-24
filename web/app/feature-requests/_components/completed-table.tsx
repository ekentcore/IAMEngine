"use client";

// The tables under the board. A request lands here the moment it is RESOLVED — marked Implemented or
// Rejected — so the board above it is only ever what is still remaining. Nothing is deleted: a
// request stays here, numbered, for as long as the app lives, and reopening it sends it back up.
//
// Two tiers, because "finished last week" and "finished last spring" want different amounts of room:
//   Implemented and closed  the recent ones, open by default — the answer to "what just shipped?"
//   Archived                the ones whose 7-day timer has run out (or that an admin archived early),
//                           collapsed, so a year of finished work doesn't grow into an endless table.
//
// Admins keep every control here, on both tiers:
//   - the status select, so a resolved request can be reopened (set it back to Planned / Being
//     scripted and it drops its timer and returns to the board);
//   - "Archive now" on a recent row, to fold it away without waiting out the week;
//   - "Restore for 7 days" on an archived row, which lifts it back into the visible table for another
//     full window. It can be clicked again each time that window runs out.
// Read-only viewers get neither tier's controls — the tables render, the controls do not.
import { useState } from "react";
import { CollapsibleSection } from "@/app/_components/collapsible-section";
import type { FeatureRequestRow } from "@/lib/feature-requests/serialize";
import { FR_HIDE_WINDOW_DAYS, frNumber } from "@/lib/feature-requests/visibility";
import { StatusSelect, type SendFn } from "./status-select";
import { FeatureStatusBadge } from "./status-badge";
import { FrSendToChatPanel } from "./fr-send-to-chat";

function Controls({ row, canHide, send, onChange }: {
  row: FeatureRequestRow;
  canHide: boolean;
  send: SendFn;
  onChange: (r: FeatureRequestRow) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const onBusy = (b: boolean, e: string | null) => { setBusy(b); setErr(e); };

  // One button, whichever way this row can move: an archived row comes back, a visible one folds away.
  const action = row.hidden ? "unhide" : "hide";
  const label = row.hidden ? `Restore for ${FR_HIDE_WINDOW_DAYS} days` : "Archive now";

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, whiteSpace: "nowrap" }}>
      <StatusSelect req={row} send={send} onChange={onChange} onBusy={onBusy} />
      {canHide && (
        <button
          type="button"
          onClick={() => {
            onBusy(true, null);
            send(`/api/feature-requests/${row.id}/visibility`, "POST", { action })
              .then((d) => { onChange(d); onBusy(false, null); })
              .catch((e: Error) => onBusy(false, e.message));
          }}
        >
          {label}
        </button>
      )}
      {/* The timer the status flip armed: "Archives in 5 days". Nothing to say once it has run out. */}
      {!row.hidden && row.hideNote && <span className="note">{row.hideNote}</span>}
      {busy && <span className="note">saving…</span>}
      {err && <span className="note" style={{ color: "#b3261e" }}>{err}</span>}
    </span>
  );
}

// One resolved request. Owns the send-to-chat toggle so the panel can render in a full-width row
// beneath the request rather than crammed into the narrow actions cell. columns: Number, Request,
// Status, Filed by, Actions (Actions only present when editable — which is also the only time the
// chat toggle shows), so the panel row spans 5.
function ResolvedRow({ row, canHide, send, onChange }: {
  row: FeatureRequestRow;
  canHide: boolean;
  send: SendFn;
  onChange: (r: FeatureRequestRow) => void;
}) {
  const [chatOpen, setChatOpen] = useState(false);
  return (
    <>
      <tr>
        <td className="mono tnum" style={{ whiteSpace: "nowrap" }}>{frNumber(row.number)}</td>
        <td>
          {row.title}
          {row.resolutionNote && (
            <div className="note" style={{ marginTop: "0.15rem" }}>↳ {row.resolutionNote}</div>
          )}
        </td>
        <td><FeatureStatusBadge status={row.status} /></td>
        <td className="note" style={{ whiteSpace: "nowrap" }}>{row.authorEmail ?? "unknown"}</td>
        <td>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, whiteSpace: "nowrap" }}>
            <Controls row={row} canHide={canHide} send={send} onChange={onChange} />
            <button type="button" onClick={() => setChatOpen((v) => !v)}>
              {chatOpen ? "Cancel" : "Send to chat"}
            </button>
          </span>
        </td>
      </tr>
      {chatOpen && (
        <tr>
          <td colSpan={5} style={{ paddingTop: 0 }}>
            <FrSendToChatPanel id={row.id} number={row.number} onClose={() => setChatOpen(false)} />
          </td>
        </tr>
      )}
    </>
  );
}

function ResolvedTable({ rows, canHide, send, onChange }: {
  rows: FeatureRequestRow[];
  canHide: boolean;
  send?: SendFn;
  onChange?: (r: FeatureRequestRow) => void;
}) {
  const editable = send !== undefined && onChange !== undefined;
  return (
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
        {rows.map((r) =>
          editable ? (
            <ResolvedRow key={r.id} row={r} canHide={canHide} send={send!} onChange={onChange!} />
          ) : (
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
            </tr>
          )
        )}
      </tbody>
    </table>
  );
}

// `rows` is every resolved request, both tiers — the caller splits board from resolved by status and
// hands the resolved over whole, so this component owns where the archive line falls.
export function CompletedTable({ rows, canHide = false, send, onChange }: {
  rows: FeatureRequestRow[];
  canHide?: boolean;
  send?: SendFn;
  onChange?: (r: FeatureRequestRow) => void;
}) {
  if (rows.length === 0) return null;
  const recent = rows.filter((r) => !r.hidden);
  const archived = rows.filter((r) => r.hidden);

  return (
    <>
      <CollapsibleSection title="Implemented and closed" count={recent.length}>
        {recent.length === 0 ? (
          <p className="note">Nothing resolved in the last {FR_HIDE_WINDOW_DAYS} days — the archive below has the rest.</p>
        ) : (
          <ResolvedTable rows={recent} canHide={canHide} send={send} onChange={onChange} />
        )}
      </CollapsibleSection>
      {archived.length > 0 && (
        <CollapsibleSection
          title="Archived"
          count={archived.length}
          subtitle={`resolved more than ${FR_HIDE_WINDOW_DAYS} days ago`}
          defaultOpen={false}
        >
          <ResolvedTable rows={archived} canHide={canHide} send={send} onChange={onChange} />
        </CollapsibleSection>
      )}
    </>
  );
}
