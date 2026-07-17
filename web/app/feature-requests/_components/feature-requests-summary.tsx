"use client";

// The "N total · N open · N implemented" line under the page heading. Server-rendered from the same
// rows the board shows, then kept live: while an admin re-triages a request the board broadcasts the
// recomputed counts and this line moves with them — no reload. Non-admins can't change anything, so
// their line simply stays at its server value.
import { useEffect, useState } from "react";
import { FR_COUNTS_EVENT } from "@/lib/feature-requests/live";
import type { FeatureRequestCounts } from "@/lib/feature-requests/counts";

export function FeatureRequestsSummary({ initial, canManage }: { initial: FeatureRequestCounts; canManage: boolean }) {
  const [counts, setCounts] = useState(initial);

  // Re-adopt the server's counts on navigation (a new object each server render); internal event
  // updates keep the same `initial` reference, so this only fires on a genuine re-render.
  const [seen, setSeen] = useState(initial);
  if (seen !== initial) { setSeen(initial); setCounts(initial); }

  useEffect(() => {
    const onCounts = (e: Event) => setCounts((e as CustomEvent<FeatureRequestCounts>).detail);
    window.addEventListener(FR_COUNTS_EVENT, onCounts);
    return () => window.removeEventListener(FR_COUNTS_EVENT, onCounts);
  }, []);

  return (
    <p className="note">
      {counts.total} total · {counts.open} open · {counts.implemented} implemented — filed from the 💡 button in the header.
      {canManage ? " Set a status to keep the queue honest." : " An admin sets the status."}
    </p>
  );
}
