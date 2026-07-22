import type { PrismaClient, Prisma } from "@prisma/client";
import { ADOBE_CONSOLE_SETUP_KEY } from "@/lib/jobs/adhoc";
import { MIMECAST_AUTOSETUP_MARKER } from "@/lib/cases/exclude-m365-autosetup";

// The vaulted Adobe Developer Console login the runner's browser flow signs in WITH — an Adobe admin
// (Adobe ID / federated email + password, OTP enabled on the Delinea secret). DISTINCT from the
// `adobe` API secret (client id/secret/org id) it PRODUCES: a sign-in box can't authenticate an API
// key. Must match field-requirements.ts "adobe-console".
export const ADOBE_CONSOLE_SECRET_NAME = "adobe-console";

// The Adobe Developer Console URL the flow navigates to. Overridable per dispatch (rarely needed).
export const ADOBE_CONSOLE_URL = "https://developer.adobe.com/console";

type ClientRef = { id: string };

type DispatchResult = { ok: true; jobId: string } | { ok: false; error: string };

// Dispatch the Adobe Developer Console browser job: sign in, create/open the "iam-engine" project, add
// the User Management API as an OAuth Server-to-Server credential, generate + HARVEST its Client ID /
// Client Secret / Organization ID, and return them in the job result (the authenticated GET poll on
// the create-api route vaults them + scrubs the raw values). Mirrors dispatch-mimecast-console-job.ts:
// a Job needs a non-null caseRequestId FK, so we mint a synthetic onboard/api case flagged
// mimecastAutoSetup (the generic auto-setup marker — hides it from /cases + bulk-replan). singleRun +
// browser-capable agents only (ADOBE_CONSOLE_SETUP_KEY is in BROWSER_SYSTEMS).
//
// The console login is resolved by the broker from the client's persistent secret UNLESS
// consoleSecretRef is supplied (a per-run Delinea id typed into the modal): brokerCredential prefers
// that case override, so the runner can sign in WITHOUT anything vaulted on the client. Used
// transiently, never stored.
export async function dispatchAdobeConsoleJob(input: {
  db: PrismaClient;
  client: ClientRef;
  signInOnly?: boolean;
  consoleUrl?: string;
  consoleSecretRef?: string;
}): Promise<DispatchResult> {
  const { db, client } = input;
  const signInOnly = input.signInOnly === true;
  const consoleUrl = input.consoleUrl?.trim() || ADOBE_CONSOLE_URL;
  const consoleSecretRef = input.consoleSecretRef?.trim() || undefined;
  try {
    const caseRequest = await db.caseRequest.create({
      data: {
        clientId: client.id,
        action: "onboard",
        createdSource: "api",
        subject: signInOnly ? "Adobe console sign-in test" : "Adobe API automated setup (console)",
        payload: { [MIMECAST_AUTOSETUP_MARKER]: true } as Prisma.InputJsonValue,
        ...(consoleSecretRef
          ? { secretOverrides: { [ADOBE_CONSOLE_SECRET_NAME]: consoleSecretRef } as Prisma.InputJsonValue }
          : {}),
      },
      select: { id: true },
    });
    const request = {
      // Claim-gate invariant: every secretNames entry is REQUIRED to claim. Satisfied by the wired
      // persistent adobe-console secret OR the per-run override above — with neither, the job would hang
      // unclaimable, so the route refuses up front with an actionable message.
      secretNames: [ADOBE_CONSOLE_SECRET_NAME],
      config: { consoleUrl, signInOnly },
      dependsOn: [],
      requiresApproval: false,
      captureEvidence: false,
    } as Prisma.InputJsonValue;
    const job = await db.job.create({
      data: {
        caseRequestId: caseRequest.id,
        systemKey: ADOBE_CONSOLE_SETUP_KEY,
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
