"use client";

// The status dropdown, shared by the board rows and the Completed table (a retired request must stay
// reopenable). It lives in its own module so those two components don't have to import each other.
//
// Every write goes through a `send` supplied by the board, which serializes them: the resolution
// note saves on blur, and a blur fires on the mousedown that precedes a click, so a note-save and
// the click that triggered it are always in flight together. Serializing them keeps the order and
// means the last response to land is the last one the server actually wrote.
import { FR_STATUSES, FR_STATUS_META } from "@/lib/feature-requests/status";
import type { FeatureRequestRow } from "@/lib/feature-requests/serialize";

export type SendFn = (url: string, method: "PATCH" | "POST", body: unknown) => Promise<FeatureRequestRow>;

export function StatusSelect({ req, send, onChange, onBusy }: {
  req: FeatureRequestRow;
  send: SendFn;
  onChange: (r: FeatureRequestRow) => void;
  onBusy: (busy: boolean, err: string | null) => void;
}) {
  return (
    <select
      value={req.status}
      onChange={(e) => {
        onBusy(true, null);
        send(`/api/feature-requests/${req.id}`, "PATCH", { status: e.target.value })
          .then((d) => { onChange(d); onBusy(false, null); })
          .catch((err: Error) => onBusy(false, err.message));
      }}
    >
      {FR_STATUSES.map((s) => <option key={s} value={s}>{FR_STATUS_META[s].label}</option>)}
    </select>
  );
}
