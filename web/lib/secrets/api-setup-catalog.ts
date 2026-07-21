// Per-system config for the guided "Setup <system> API" flow. One entry = one menu item + its modal
// instructions. Input fields come from SECRET_FIELD_REQUIREMENTS[secretName].
export type ApiSetupEntry = {
  systemKey: string;      // gates the menu item on the client having this system
  secretName: string;     // the Delinea secret to create/verify/wire
  label: string;          // "Mimecast" -> "Setup Mimecast API"
  consoleUrl: string;     // "Open console ↗"
  steps: string[];        // vendor instructions
  regionOptions?: string[]; // Proofpoint: the region picker
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
    steps: [
      "In the Spanning admin console, open Settings → API Token.",
      "Generate / copy the API token and note the account/domain and your data region.",
      "Paste them below (or the Delinea id you saved them in), then Verify & save.",
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
