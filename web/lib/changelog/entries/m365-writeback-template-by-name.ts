import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "m365-writeback-template-by-name",
  date: "2026-07-24",
  time: "14:45",
  title: "M365 auto-setup vaults its credential without a template-id env",
  items: [
    'The M365 auto-setup\'s Delinea write-back was the last flow still requiring a per-instance template id in env — with none configured it refused with "Delinea write not configured - a template id for m365-admin" after the app registration and its one-time secret were already minted',
    'It now resolves the stock "Entra Azure AD Account" template live from Secret Server by name, exactly like the manual create route and the guided vendor setups; an explicit DELINEA_TEMPLATE_MAP / DELINEA_TEMPLATE_M365_ADMIN id still wins as an override',
    "The kept-valid completeness check (detecting a half-vaulted credential with no certificate material) also no longer needs the template env — it reads the default certificate slug directly",
  ],
};
