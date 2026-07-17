"use client";

// Renders nothing. Mounted once in the header (so it survives the "More" menu opening and closing), it
// keeps the shared open-count store in sync: seeded from the server on every navigation, then moved
// live by the board's re-triage broadcast and the 💡 file button. The nav badge only reads that store,
// so it shows the right number whenever the menu is opened — not the value frozen at its last mount.
import { useEffect } from "react";
import { FR_COUNTS_EVENT, FR_FILED_EVENT, frOpenCountStore } from "@/lib/feature-requests/live";
import type { FeatureRequestCounts } from "@/lib/feature-requests/counts";

export function FeatureRequestCountSync({ serverCount }: { serverCount: number }) {
  // The server's count is authoritative on every layout render that carries a new one (each
  // navigation recomputes it against the real DB), so it also reconciles any live drift.
  useEffect(() => { frOpenCountStore.set(serverCount); }, [serverCount]);

  useEffect(() => {
    const onCounts = (e: Event) => frOpenCountStore.set((e as CustomEvent<FeatureRequestCounts>).detail.open);
    const onFiled = () => frOpenCountStore.set(frOpenCountStore.get() + 1); // a new request is always open
    window.addEventListener(FR_COUNTS_EVENT, onCounts);
    window.addEventListener(FR_FILED_EVENT, onFiled);
    return () => {
      window.removeEventListener(FR_COUNTS_EVENT, onCounts);
      window.removeEventListener(FR_FILED_EVENT, onFiled);
    };
  }, []);

  return null;
}
