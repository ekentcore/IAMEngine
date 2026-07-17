// The board is server-rendered, but two read-only surfaces must move the instant the queue changes,
// without a reload: the nav badge (open-count pill on the "Feature requests" menu link) and the
// page's "N total · N open · N implemented" line. The admin owns the row state; when it re-triages a
// request it broadcasts the recomputed counts on a window event and both surfaces listen. Filing a
// new request (the 💡 button, on any page) broadcasts a +1 so the nav badge reacts even where the
// board isn't mounted. Everything reconciles to the server's real count on the next navigation.
import type { FeatureRequestCounts } from "./counts";

export const FR_COUNTS_EVENT = "fr:counts";
export const FR_FILED_EVENT = "fr:filed";

export function broadcastFrCounts(counts: FeatureRequestCounts): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<FeatureRequestCounts>(FR_COUNTS_EVENT, { detail: counts }));
}

export function broadcastFrFiled(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(FR_FILED_EVENT));
}

// A tiny client store holding the current open-request count. The nav badge lives INSIDE the "More"
// menu, so it unmounts every time that menu closes and would otherwise remount frozen at whatever the
// server sent when the menu last opened — missing any re-triage that happened in between. So the badge
// only reads this store; FeatureRequestCountSync (mounted once in the header, never unmounted) owns it:
// it seeds it from the server on every navigation and moves it on the events above. A remounting badge
// then reads the live value, and the store reconciles to the real server count on the next navigation.
let openCount = 0;
const openCountSubs = new Set<() => void>();

export const frOpenCountStore = {
  get: (): number => openCount,
  set: (n: number): void => {
    if (n === openCount) return;
    openCount = n;
    for (const f of openCountSubs) f();
  },
  subscribe: (f: () => void): (() => void) => {
    openCountSubs.add(f);
    return () => { openCountSubs.delete(f); };
  },
};
