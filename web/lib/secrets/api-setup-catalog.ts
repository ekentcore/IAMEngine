// Per-system config for the guided "Setup <system> API" flow. One entry = one menu item + its modal
// instructions. Input fields come from SECRET_FIELD_REQUIREMENTS[secretName].
export type ApiSetupEntry = {
  systemKey: string;      // gates the menu item on the client having this system
  secretName: string;     // the Delinea secret to create/verify/wire
  label: string;          // "Mimecast" -> "Setup Mimecast API"
  consoleUrl: string;     // "Open console ↗"
  steps: string[];        // vendor instructions
  regionOptions?: string[]; // Proofpoint: the region picker. Spanning: feeds the derived apiURL instead
  // Spanning: the modal replaces the "region or base url" text input with email-service + region
  // selects and derives apiURL + account id via deriveSpanningValues (guided-api-values.ts).
  derive?: "spanning";
  serviceOptions?: string[]; // Spanning: the email-service picker (o365 | google)
};

export const API_SETUP_CATALOG: ApiSetupEntry[] = [
  {
    systemKey: "mimecast", secretName: "mimecast", label: "Mimecast",
    consoleUrl: "https://login.mimecast.com/",
    steps: [
      "In the Mimecast Administration Console, go to Services → API and Platform Integrations.",
      "Create a new 2.0 application; copy its Client ID and Client Secret (the secret is shown once).",
      "Paste them below (or the Delinea id you saved them in), then Verify & save.",
    ],
  },
  {
    systemKey: "spanning", secretName: "spanning", label: "Spanning",
    consoleUrl: "https://o365.spanningbackup.com/",
    derive: "spanning",
    serviceOptions: ["o365", "google"],
    regionOptions: ["us", "eu", "ap", "uk", "ca"],
    steps: [
      "Sign in to the Spanning Backup admin console for this client's tenant, and note the email you sign in with — that's the API username.",
      "Open Settings and scroll to API Token at the bottom of the page; copy the API Key (generate one if there isn't one — avoid Regenerate, it invalidates the current key everywhere immediately).",
      "Enter the login email + API Key below and pick the email service (o365, or google for a Google Workspace tenant) and region (United States = us). The account id and API URL (https://<service>-api-<region>.spanningbackup.com) are filled in automatically.",
    ],
  },
  {
    systemKey: "proofpoint", secretName: "proofpoint", label: "Proofpoint",
    consoleUrl: "https://us1.proofpointessentials.com/",
    steps: [
      "Use a Proofpoint Essentials admin login that has API access enabled for the org.",
      "Note the org's primary domain and your data region (from the console URL: us1..us5, eu1, au1).",
      "Enter the admin email/password + region below (or the Delinea id), then Verify & save.",
    ],
    regionOptions: ["us1", "us2", "us3", "us4", "us5", "eu1", "au1"],
  },
];

export function apiSetupFor(systemKey: string): ApiSetupEntry | undefined {
  return API_SETUP_CATALOG.find((e) => e.systemKey === systemKey);
}
