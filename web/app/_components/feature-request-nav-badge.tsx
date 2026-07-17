"use client";

// The little count pill on the "Feature requests" menu link — how many requests are still open. It
// reads the shared store (see FeatureRequestCountSync), which the header seeds from the server on every
// navigation and updates live on re-triage / new filing, so this stays right even though the badge
// itself unmounts every time the "More" menu closes. Renders nothing at zero — the ask was "if none
// exist it doesn't have to show anything".
import { useSyncExternalStore } from "react";
import { frOpenCountStore } from "@/lib/feature-requests/live";

export function FeatureRequestNavBadge() {
  const count = useSyncExternalStore(frOpenCountStore.subscribe, frOpenCountStore.get, () => 0);
  if (count <= 0) return null;
  return (
    <span className="nav-count" aria-label={`${count} open feature request${count === 1 ? "" : "s"}`}>
      {count}
    </span>
  );
}
