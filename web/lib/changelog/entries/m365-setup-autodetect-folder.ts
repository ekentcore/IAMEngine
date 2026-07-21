import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "m365-setup-autodetect-folder",
  date: "2026-07-21",
  time: "14:00",
  title: "M365 auto-setup now auto-detects a client's Delinea folder instead of failing to vault",
  items: [
    "A client with no Delinea folder id (set on the client or in DELINEA_FOLDER_MAP) used to fail M365 auto-setup at the vault-write step with 'Delinea write not configured — this client's Delinea folder id' — the app registration got created but its credential could never be vaulted (Digital Currency Group / core1269 hit this; 42 of 181 clients have no folder id).",
    "The write now auto-detects the folder in Secret Server before giving up: first from the Global Admin login's own folder (the secret you point the setup at lives IN that client's folder, so its folderId IS the answer), then from a folder whose name carries the client's core id (its slug, e.g. 'core1269'), then a folder named for the client.",
    "The name-based lookups are conservative — they only resolve when there's a single unambiguous match (preferring the client root over a subfolder), so a credential never lands in the wrong folder; when nothing resolves confidently the run still fails, now telling you to set the folder id and re-run.",
    "A detected folder is self-learned onto the client (so later runs skip detection) and the run log names where it came from (e.g. 'auto-detected this client's Delinea folder (5318) from the Global Admin login's Delinea folder').",
    "Web-only change (the Delinea write is app-side) — no runner update needed.",
  ],
};
