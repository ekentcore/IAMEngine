import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "connector-builder",
  date: "2026-07-16",
  time: "23:45",
  title: "Add a new system without writing code: the low-code connector builder",
  items: [
    "New /connectors page (global admins): describe a system's API as a declarative connector, test it, and publish. A published connector becomes a system clients can attach in the systems editor — the runner interprets the definition, so there's no new module to build or deploy.",
    "REST connectors: define auth (bearer/basic/header/OAuth2), named operations (method, path, body, expected status, values to extract), and per-lane steps that gate mutations on a prior read — so onboard/offboard are idempotent (find first, only create/disable if needed).",
    "Browser connectors: for portals with no API, a declarative step list (goto/fill/click/waitFor/expect/totp) drives Playwright — no hand-written flow. One generic flow serves every browser connector.",
    "Import instead of hand-write: upload a HAR capture of the task done by hand and pick the requests to turn into operations (cookies and auth headers are stripped), or paste a `playwright codegen` script to turn recorded clicks into browser steps.",
    "Safe by construction: every connector key is namespaced custom-* (can never shadow a built-in), https-only with a mandatory host allowlist enforced on the runner before any request leaves, secrets referenced by name and brokered per-job (never stored in the definition) and scrubbed from every log line, and the definition is validated on save AND again on the runner.",
    "Runner 1.70.0 ships the generic executor (Coretelligent.Connector) + the connector-steps browser flow.",
    "Security review (no high-severity vulnerabilities): hardened the browser interpreter — every navigation re-checks its FINAL URL after redirects, every page interaction re-checks the page is still on an allowlisted host (so a redirect can't send a portal password off-allowlist even if the fill wasn't flagged secret), navigations must be https, and the browser lane now registers its own secrets for redaction. Definition validation also covers defaults.headers and step-message templates.",
  ],
};
