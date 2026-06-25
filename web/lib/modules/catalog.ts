// The module registry behind the Modules tab: every system the platform knows about, whether a
// runner EXECUTOR is built for it, and where its operator INSTRUCTIONS live (an in-app /help page).
//
// This is the one place to keep in sync when work ships:
//  - wire a new executor in the runner DISPATCH table  -> set executor: "built"
//  - ship an app/help/<slug>/page.tsx setup guide        -> set helpSlug
// The Modules page flags the gaps (built but no instructions; planned/no executor) automatically.

export type Executor = "built" | "manual" | "planned";
//  built   = a Coretelligent.* module wired into the runner DISPATCH table (or covered by m365/libs)
//  manual  = a human/checklist step by design — no API executor is expected
//  planned = in the catalog/profiles but no executor yet (the real backlog)

export type ModuleEntry = {
  key: string; // systemKey (or secret-scoped capability, e.g. exchange-onprem)
  name: string;
  group: "Core / identity" | "Email security" | "Apps & access" | "Security / endpoint" | "Notifications" | "Manual / hardware" | "Backlog (no executor)";
  executor: Executor;
  secret?: string; // logical secret name the runner brokers
  helpSlug?: string; // app/help/<slug> — the operator setup guide, if one exists
  note?: string;
};

export const MODULES: ModuleEntry[] = [
  // --- Core / identity ---
  { key: "servicenow", name: "ServiceNow", group: "Core / identity", executor: "built", secret: "servicenow", note: "case contact + work notes (runner lib)" },
  { key: "m365", name: "Microsoft 365", group: "Core / identity", executor: "built", secret: "m365-admin", helpSlug: "cloud-auth" },
  { key: "entra", name: "Entra", group: "Core / identity", executor: "built", secret: "m365-admin", helpSlug: "cloud-auth", note: "runs through the M365 module" },
  { key: "exchange", name: "Exchange Online", group: "Core / identity", executor: "built", secret: "m365-admin", helpSlug: "cloud-auth" },
  { key: "exchange-onprem", name: "Exchange (on-prem / hybrid)", group: "Core / identity", executor: "built", secret: "exchange-onprem", note: "hybrid mailbox session — needs a setup guide" },
  { key: "active-directory", name: "Active Directory", group: "Core / identity", executor: "built", secret: "ad-dc", note: "on-prem only — see docs/runner-dc-setup.md (needs an in-app guide)" },
  { key: "directory-sync", name: "Entra Connect sync", group: "Core / identity", executor: "built", secret: "ad-dc", note: "on-prem only (ADSync on the AAD Connect host)" },
  { key: "case-resolution", name: "Case resolution", group: "Core / identity", executor: "built" },

  // --- Email security ---
  { key: "mimecast", name: "Mimecast", group: "Email security", executor: "built", secret: "mimecast", helpSlug: "mimecast" },
  { key: "proofpoint", name: "Proofpoint", group: "Email security", executor: "planned", secret: "proofpoint" },
  { key: "spanning", name: "Spanning Backup", group: "Email security", executor: "built", secret: "spanning", helpSlug: "spanning" },

  // --- Apps & access ---
  { key: "google-workspace", name: "Google Workspace", group: "Apps & access", executor: "built", secret: "google-admin", helpSlug: "google" },
  { key: "adobe", name: "Adobe", group: "Apps & access", executor: "built", secret: "adobe", note: "spec at docs/modules/adobe.md — needs an in-app guide" },
  { key: "zoom", name: "Zoom", group: "Apps & access", executor: "built", secret: "zoom", helpSlug: "zoom" },
  { key: "knowbe4", name: "KnowBe4", group: "Apps & access", executor: "built", secret: "knowbe4", helpSlug: "knowbe4" },
  { key: "egnyte", name: "Egnyte", group: "Apps & access", executor: "built", secret: "egnyte", helpSlug: "egnyte" },
  { key: "perimeter81", name: "Perimeter 81", group: "Apps & access", executor: "built", secret: "perimeter81" },
  { key: "salesforce", name: "Salesforce", group: "Apps & access", executor: "built", secret: "salesforce", helpSlug: "salesforce" },
  { key: "hubspot", name: "HubSpot", group: "Apps & access", executor: "built", secret: "hubspot", helpSlug: "hubspot" },
  { key: "jira", name: "Jira", group: "Apps & access", executor: "built", secret: "jira", helpSlug: "jira" },
  { key: "sharepoint", name: "SharePoint", group: "Apps & access", executor: "planned", secret: "m365-admin" },
  { key: "slack", name: "Slack", group: "Apps & access", executor: "planned", secret: "slack" },
  { key: "teams", name: "Teams Phone", group: "Apps & access", executor: "planned", secret: "teams-admin" },
  { key: "dropbox", name: "Dropbox", group: "Apps & access", executor: "planned", secret: "dropbox" },
  { key: "1password", name: "1Password", group: "Apps & access", executor: "planned", secret: "1password" },
  { key: "notion", name: "Notion", group: "Apps & access", executor: "planned", secret: "notion" },
  { key: "printix", name: "Printix", group: "Apps & access", executor: "planned", secret: "printix" },
  { key: "avd", name: "Azure Virtual Desktop", group: "Apps & access", executor: "planned", secret: "m365-admin" },

  // --- Security / endpoint ---
  { key: "sentinelone", name: "SentinelOne", group: "Security / endpoint", executor: "built", secret: "sentinelone", helpSlug: "sentinelone" },
  { key: "duo", name: "Duo", group: "Security / endpoint", executor: "built", secret: "duo", helpSlug: "duo" },
  { key: "logicmonitor", name: "LogicMonitor", group: "Security / endpoint", executor: "built", secret: "logicmonitor", helpSlug: "logicmonitor" },
  { key: "mdm", name: "MDM (Addigy/Jamf/Intune)", group: "Security / endpoint", executor: "planned", secret: "mdm" },

  // --- Notifications ---
  { key: "notify", name: "Notify", group: "Notifications", executor: "built", note: "internal notifications" },
  { key: "xmatters", name: "xMatters", group: "Notifications", executor: "built", secret: "xmatters", helpSlug: "xmatters" },

  // --- Manual / hardware (no API executor by design) ---
  { key: "hardware", name: "Hardware", group: "Manual / hardware", executor: "manual" },
  { key: "workstation", name: "Workstation", group: "Manual / hardware", executor: "manual" },
  { key: "welcome-letter", name: "Welcome letter", group: "Manual / hardware", executor: "manual" },
  { key: "first-day-call", name: "First-day call", group: "Manual / hardware", executor: "manual" },
  { key: "equipment-return", name: "Equipment return", group: "Manual / hardware", executor: "manual" },
  { key: "address-book", name: "Printer address book", group: "Manual / hardware", executor: "manual", note: "browser fallback" },
  { key: "egnyte-sync-server", name: "Egnyte Sync Server", group: "Manual / hardware", executor: "manual", note: "browser fallback" },

  // --- Backlog: offboard helpers with no executor yet ---
  { key: "data-transfer", name: "Data transfer", group: "Backlog (no executor)", executor: "planned" },
  { key: "archive", name: "Archive (deferred)", group: "Backlog (no executor)", executor: "planned" },
];

export const helpHref = (m: ModuleEntry): string | null => (m.helpSlug ? `/help/${m.helpSlug}` : null);

// A "built" module with no operator guide is the actionable gap the Modules page highlights.
export const needsInstructions = (m: ModuleEntry): boolean => m.executor === "built" && !m.helpSlug;
