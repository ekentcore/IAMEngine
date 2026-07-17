import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "coreid-slug-redirect",
  date: "2026-07-17",
  time: "13:45",
  title: "A client's CORE id now works as a URL - /clients/core1955 forwards to /clients/yuma",
  items: [
    "Most clients' page URL already IS their lowercased CORE id (e.g. /clients/core1269), but a few were set up under a name (yuma, regal, six-one) before ServiceNow stamped their CORE id - so pasting their CORE id into the URL used to 404",
    "Now /clients/<core-id> resolves for every client: if the id belongs to a client living under a name slug, it forwards (307) to that client's real page - so a CORE id copied out of a ticket always gets you there",
    "It only runs when the direct URL misses, so normal page loads are unaffected; CORE1955, core-1955 and 1955 all forward the same way",
    "Access scoping is honored - a client you are not allowed to see still reads as not-found via its CORE id, so the alias can't be used to probe which ids exist",
  ],
};
