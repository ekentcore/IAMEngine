import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "exchange-rights-manageasapp",
  date: "2026-07-20",
  time: "20:45",
  title: "Connection test: an Exchange Online client with Exchange.ManageAsApp now reads 1/1 rights",
  items: [
    "The Exchange connection test connected fine (org read) but reported NO rights row, so the rights panel showed nothing for Exchange even when the app clearly had Exchange.ManageAsApp granted.",
    "It now reports the one Exchange right as satisfied on a successful connect: app-only Connect-ExchangeOnline can't mint a token without Exchange.ManageAsApp + the Exchange Administrator role, so a passing exchange test PROVES both — the panel now shows 1/1 for Exchange instead of a blank row.",
    "Runner 1.79.0 — needs the usual runner self-update after deploy; re-run the exchange connection test to see it.",
  ],
};
