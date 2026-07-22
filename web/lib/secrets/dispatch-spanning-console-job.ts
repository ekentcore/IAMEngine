import type { PrismaClient, Prisma } from "@prisma/client";
import { SPANNING_CONSOLE_SETUP_KEY } from "@/lib/jobs/adhoc";
import { MODULE_AUTOSETUP_MARKER } from "@/lib/cases/exclude-m365-autosetup";

// The vaulted Spanning admin-console login the runner's browser flow signs in WITH. The Spanning
// console is Microsoft-365 SSO, so this is an M365 admin login (email + password) — DISTINCT from the
// `spanning` API credential (login email + API token) we HARVEST. Must match field-requirements.ts
// "spanning-portal" and optional-secrets.ts (spanning → ["spanning-portal"]).
export const SPANNING_CONSOLE_SECRET_NAME = "spanning-portal";

// The Spanning admin-console host the flow signs into (Microsoft-365 tenants). Overridable per dispatch
// (the Google-Workspace variant uses a different host).
export const SPANNING_CONSOLE_URL = "https://o365.spanningbackup.com/";

type ClientRef = { id: string };
type DispatchResult = { ok: true; jobId: string } | { ok: false; error: string };

// Derive { service, region } from the Spanning apiURL so the runner flow can build the REGIONAL console
// host it harvests the token from (https://<service>-<region>.spanningbackup.com). The apiURL shape is
// https://<service>-api-<region>.spanningbackup.com (deriveSpanningValues), e.g. o365-api-us -> the
// console host o365-us. Returns {} when the URL doesn't match (the flow then falls back to the apiURL
// itself, then consoleUrl, then its o365/us default — all resolved flow-side).
export function deriveSpanningConsoleTarget(apiUrl: string | undefined | null): { service?: string; region?: string } {
  if (!apiUrl) return {};
  try {
    const host = new URL(/^https?:\/\//i.test(apiUrl) ? apiUrl : `https://${apiUrl}`).hostname;
    const m = host.match(/^([a-z0-9]+)-api-([a-z0-9]+)\.spanningbackup\.com$/i);
    if (!m) return {};
    return { service: m[1].toLowerCase(), region: m[2].toLowerCase() };
  } catch {
    return {};
  }
}

// Dispatch the Spanning console browser job. The runner signs into the admin console, opens
// Settings → API Token, generates the key if absent, and HARVESTS it (returned note-only in the job
// result; the web result handler vaults it as the `spanning` secret and scrubs it). `signInOnly:true`
// only proves the console login works (a future "Test sign-in").
//
// Mirrors dispatch-mimecast-console-job.ts: a Job needs a caseRequestId FK, so we mint a synthetic
// onboard case flagged MODULE_AUTOSETUP_MARKER (hidden from /cases + bulk-replan). singleRun, claimable
// only by browser-capable agents (BROWSER_SYSTEMS includes this key). consoleSecretRef is a per-run
// Delinea id typed into the modal — brokerCredential prefers it over any stored secret, so the runner
// can sign in without anything vaulted on the client; used transiently, never stored.
export async function dispatchSpanningConsoleJob(input: {
  db: PrismaClient;
  client: ClientRef;
  signInOnly?: boolean;
  consoleUrl?: string;
  consoleSecretRef?: string;
  // Operator-picked derived values the modal supplies (deriveSpanningValues): the API login email, the
  // derived apiURL, and the account id — combined with the harvested token to vault the `spanning` secret.
  loginEmail?: string;
  apiUrl?: string;
  accountId?: string;
}): Promise<DispatchResult> {
  const { db, client } = input;
  const signInOnly = input.signInOnly === true;
  const consoleUrl = input.consoleUrl?.trim() || SPANNING_CONSOLE_URL;
  const consoleSecretRef = input.consoleSecretRef?.trim() || undefined;
  try {
    const caseRequest = await db.caseRequest.create({
      data: {
        clientId: client.id,
        action: "onboard",
        createdSource: "api",
        subject: signInOnly ? "Spanning console sign-in test" : "Spanning API automated setup (console)",
        payload: { [MODULE_AUTOSETUP_MARKER]: true } as Prisma.InputJsonValue,
        ...(consoleSecretRef
          ? { secretOverrides: { [SPANNING_CONSOLE_SECRET_NAME]: consoleSecretRef } as Prisma.InputJsonValue }
          : {}),
      },
      select: { id: true },
    });
    const request = {
      // Claim-gate invariant: every secretNames entry is REQUIRED to claim — satisfied by the wired
      // spanning-portal secret OR the per-run override above.
      secretNames: [SPANNING_CONSOLE_SECRET_NAME],
      // The derived API values ride the config so the runner can echo them back for vaulting alongside
      // the harvested token (the values themselves are non-secret — email/URL/account id). service +
      // region are derived from the apiURL so the flow builds the regional console host it harvests from.
      config: { consoleUrl, signInOnly, loginEmail: input.loginEmail ?? "", apiUrl: input.apiUrl ?? "", accountId: input.accountId ?? "", ...deriveSpanningConsoleTarget(input.apiUrl) },
      dependsOn: [],
      requiresApproval: false,
      captureEvidence: false,
    } as Prisma.InputJsonValue;
    const job = await db.job.create({
      data: {
        caseRequestId: caseRequest.id,
        systemKey: SPANNING_CONSOLE_SETUP_KEY,
        mode: "api",
        sequence: 1,
        status: "pending",
        singleRun: true,
        request,
      },
      select: { id: true },
    });
    return { ok: true, jobId: job.id };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
