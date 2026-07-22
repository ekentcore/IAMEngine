// Per-system config for the guided "Setup <system> API" flow. One entry = one menu item + its modal
// instructions. Input fields come from SECRET_FIELD_REQUIREMENTS[secretName].
export type ApiSetupEntry = {
  systemKey: string;      // gates the menu item on the client having this system
  secretName: string;     // the Delinea secret to create/verify/wire
  label: string;          // "Mimecast" -> "Setup Mimecast API"
  consoleUrl: string;     // "Open console ↗"
  helpPath?: string;      // in-app setup guide ("Full guide ↗"), e.g. "/help/mimecast"
  steps: string[];        // vendor instructions
  regionOptions?: string[]; // Proofpoint: the region picker. Spanning: feeds the derived apiURL instead
  // Spanning: the modal replaces the "region or base url" text input with email-service + region
  // selects and derives apiURL + account id via deriveSpanningValues (guided-api-values.ts).
  derive?: "spanning";
  serviceOptions?: string[]; // Spanning: the email-service picker (o365 | google)
  // When set, the modal shows an "Automatic (browser)" tab that drives the vendor console via the
  // runner to CREATE + harvest + vault the API credential. `autoBrowser` is the ad-hoc browser
  // systemKey the flow runs under; `autoCreateEndpoint` is the route (under /api/clients/[slug]/) the
  // modal POSTs to start it and GETs to poll; `autoConsoleSecret` is the console LOGIN secret the flow
  // signs in with. All three together make the Automatic tab work for a vendor via one shared code path.
  autoBrowser?: string;
  autoCreateEndpoint?: string;
  autoConsoleSecret?: string;
  // The client-folder SUBFOLDER the vaulted credential should target in Delinea. Vendor API creds go
  // in the client's "Vendor" subfolder; identity creds (m365) default to "Identity Services" when this
  // is unset. The create route tries this subfolder first, then "Identity Services", then refuses (a
  // credential is never written to the client ROOT — it "reads as not viewable" there). See PRs #180/#182.
  delineaSubfolder?: string;
};

export const API_SETUP_CATALOG: ApiSetupEntry[] = [
  {
    systemKey: "mimecast", secretName: "mimecast", label: "Mimecast",
    consoleUrl: "https://login.mimecast.com/",
    helpPath: "/help/mimecast",
    autoBrowser: "mimecast-console-setup",
    autoCreateEndpoint: "mimecast-console/create-api-app",
    autoConsoleSecret: "mimecast-console",
    delineaSubfolder: "Vendor",
    steps: [
      "In the Mimecast Administration Console, go to Integrations → API and Platform Integrations → Add API Application.",
      "Name it \"iam-engine — <client>\", category SIEM/Integration, point of contact Coretelligent (<coreid>@help.support.tech), and enable it (new applications can take a few minutes to activate).",
      "Set its role to Basic Administrator (or Help Desk Administrator) and enable three products: Account Management, Domain Management, and User & Group Management — without the last one every user call fails with app_forbidden.",
      "Open the application → Manage API 2.0 credentials → Generate; copy the Client ID and Client Secret (the secret is shown once — regenerate if lost).",
      "Paste them below (or the Delinea id you saved them in), then Verify & save.",
    ],
  },
  {
    systemKey: "spanning", secretName: "spanning", label: "Spanning",
    consoleUrl: "https://o365.spanningbackup.com/",
    helpPath: "/help/spanning",
    autoBrowser: "spanning-console-setup",
    autoCreateEndpoint: "spanning-setup/create-api",
    autoConsoleSecret: "spanning-portal",
    delineaSubfolder: "Vendor",
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
    helpPath: "/help/proofpoint",
    delineaSubfolder: "Vendor",
    steps: [
      "Use a Proofpoint Essentials admin login that has API access enabled for the org.",
      "Note the org's primary domain and your data region (from the console URL: us1..us5, eu1, au1).",
      "Enter the admin email/password + region below (or the Delinea id), then Verify & save.",
    ],
    regionOptions: ["us1", "us2", "us3", "us4", "us5", "eu1", "au1"],
  },
  {
    systemKey: "adobe", secretName: "adobe", label: "Adobe",
    consoleUrl: "https://developer.adobe.com/console",
    autoBrowser: "adobe-console-setup",
    autoCreateEndpoint: "adobe-setup/create-api",
    autoConsoleSecret: "adobe-console",
    delineaSubfolder: "Vendor",
    steps: [
      "In the Adobe Developer Console (developer.adobe.com/console), open (or create) a project for this client's Adobe org, then Add API → User Management API.",
      "Choose OAuth Server-to-Server as the authentication type and save — this generates the credential.",
      "From the credential's Overview, copy the Client ID and Client Secret (Retrieve client secret), and the Organization ID (the ...@AdobeOrg value under Credential details / Project overview).",
      "Paste Client ID, Client Secret, and Org ID below (or the Delinea id), then Verify & save.",
    ],
  },
  {
    systemKey: "zoom", secretName: "zoom", label: "Zoom",
    consoleUrl: "https://marketplace.zoom.us/",
    autoBrowser: "zoom-console-setup",
    autoCreateEndpoint: "zoom-setup/create-api",
    autoConsoleSecret: "zoom-console",
    delineaSubfolder: "Vendor",
    steps: [
      "In the Zoom App Marketplace (marketplace.zoom.us) → Develop → Build App, create a Server-to-Server OAuth app for this client's Zoom account.",
      "On the app's App Credentials page, copy the Account ID, Client ID, and Client Secret.",
      "Under Scopes, add user read/write scopes (user:read:admin, user:write:admin) so the runner can create/deactivate users, then Activate the app.",
      "Paste Account ID, Client ID, and Client Secret below (or the Delinea id), then Verify & save.",
    ],
  },
  {
    systemKey: "egnyte", secretName: "egnyte", label: "Egnyte",
    consoleUrl: "https://developers.egnyte.com/",
    autoBrowser: "egnyte-console-setup",
    autoCreateEndpoint: "egnyte-setup/create-api",
    autoConsoleSecret: "egnyte-console",
    delineaSubfolder: "Vendor",
    steps: [
      "Note the client's Egnyte domain (the <domain> in https://<domain>.egnyte.com).",
      "Get an API key/token with admin scope: register/enable an API application for the domain at developers.egnyte.com (or use the domain admin's existing API key), and generate an access token authorized by a domain administrator.",
      "Enter the Egnyte domain and the API token below (or the Delinea id), then Verify & save.",
    ],
  },
  {
    systemKey: "knowbe4", secretName: "knowbe4", label: "KnowBe4",
    consoleUrl: "https://training.knowbe4.com/",
    autoBrowser: "knowbe4-console-setup",
    autoCreateEndpoint: "knowbe4-setup/create-api",
    autoConsoleSecret: "knowbe4-console",
    delineaSubfolder: "Vendor",
    steps: [
      "In the KnowBe4 console, go to your account settings → API and enable the Reporting / User Management API, then generate an API token.",
      "Note your KnowBe4 region — it sets the API base URL (US = https://us.api.knowbe4.com, EU = https://eu.api.knowbe4.com).",
      "Enter the API token and region/base URL below (or the Delinea id), then Verify & save.",
    ],
  },
  {
    systemKey: "slack", secretName: "slack", label: "Slack",
    consoleUrl: "https://api.slack.com/apps",
    autoBrowser: "slack-console-setup",
    autoCreateEndpoint: "slack-setup/create-api",
    autoConsoleSecret: "slack-console",
    delineaSubfolder: "Vendor",
    steps: [
      "SCIM provisioning requires a Slack Business+ or Enterprise Grid plan and a Workspace/Org Owner.",
      "Create (or reuse) a Slack app for the workspace at api.slack.com/apps and grant it the admin scope needed for SCIM (the app must be installed by an Owner).",
      "Generate the SCIM API token (a bearer token with admin scope for https://api.slack.com/scim/v2).",
      "Paste the SCIM token below (or the Delinea id), then Verify & save.",
    ],
  },
];

export function apiSetupFor(systemKey: string): ApiSetupEntry | undefined {
  return API_SETUP_CATALOG.find((e) => e.systemKey === systemKey);
}

// The set of secrets that are a browser CONSOLE LOGIN (admin email + password) rather than an API
// credential — every vendor's `autoConsoleSecret` (spanning-portal, mimecast-console, …) plus the
// M365 device-code Global Admin login. These can't be API-tested (a login box doesn't return a
// verdict), so the guided-setup wizard treats them as Delinea-id-ONLY: paste/pick a reference, no
// typed username/password create form and no field-shape "Test" button.
export const CONSOLE_LOGIN_SECRETS = new Set<string>([
  ...(API_SETUP_CATALOG.map((e) => e.autoConsoleSecret).filter(Boolean) as string[]),
  "m365-global-admin",
]);

export function isBrowserLoginSecret(name: string): boolean {
  return CONSOLE_LOGIN_SECRETS.has(name);
}

// The catalog entry whose credential this secret NAME vaults — the create route uses it to pick the
// module's Delinea subfolder and record setup provenance. (secretName is the durable key; systemKey
// and secretName coincide for these vendors, but look up by the name the vault path actually uses.)
export function apiSetupBySecretName(secretName: string): ApiSetupEntry | undefined {
  return API_SETUP_CATALOG.find((e) => e.secretName === secretName);
}
