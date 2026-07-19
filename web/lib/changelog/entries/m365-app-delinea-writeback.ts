import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "m365-app-delinea-writeback",
  date: "2026-07-19",
  time: "17:15",
  title: "Automated M365 setup: write the provisioned app registration credential back to Delinea (Phase 3)",
  items: [
    "New internal `writeProvisionedM365App` — after `provisionM365App` issues a client secret and/or Exchange Online certificate, it's proven against Entra (the same client-credentials grant the runner performs) before ever being vaulted, so a broken credential can't get written.",
    "The `m365-admin` Delinea secret shape now carries three optional cert fields (base64 PFX, its password, and thumbprint) alongside the existing app id / client secret / tenant — additive and optional, so every existing password-only m365-admin secret in the fleet still passes unchanged.",
    "New `updateSecretFields` in the Delinea broker (per-field PUT) — `createSecret` is find-or-create only and won't touch an existing secret's fields, so the writeback always follows a create with an update to push the current values either way.",
    "Persists only the vault REFERENCE (the Delinea secret id) onto the client — never a credential value — and self-learns the client's Delinea folder id the first time it writes there.",
    "Not wired to a UI flow yet and the dev environment has no DELINEA_WRITE_* configured, so this is unit-tested only here; live-validated by an operator once a write account + folder + template are set up.",
  ],
};
