import type { PrismaClient, Prisma } from "@prisma/client";
import { SLACK_CONSOLE_SETUP_KEY } from "@/lib/jobs/adhoc";
import { MIMECAST_AUTOSETUP_MARKER } from "@/lib/cases/exclude-m365-autosetup";

// The vaulted Slack admin console login the runner's browser flow signs in WITH (email + password,
// optional TOTP). DISTINCT from the "slack" SCIM API token it attempts to harvest. Must match
// field-requirements.ts "slack-console".
export const SLACK_CONSOLE_SECRET_NAME = "slack-console";

// Slack's sign-in entry point (overridable per dispatch — an Enterprise Grid org may use its own).
export const SLACK_SIGNIN_URL = "https://slack.com/signin";

type ClientRef = { id: string };
type DispatchResult = { ok: true; jobId: string } | { ok: false; error: string };

// Dispatch the Slack console browser job. signInOnly:true proves the login (Test sign-in); signInOnly:
// false additionally ATTEMPTS to locate + harvest a SCIM token and returns it for the app to vault.
// Mirrors dispatch-zoom-console-job.ts: a synthetic autosetup-marked case (hidden from /cases +
// bulk-replan) carrying an optional per-run console-login ref, and a singleRun job only a
// browser-capable agent can claim (SLACK_CONSOLE_SETUP_KEY ∈ BROWSER_SYSTEMS).
//
// CAVEAT: a Slack SCIM token usually is NOT exposed as a readable console field (it comes from an app
// with the admin scope), so the harvest often returns nothing and the operator pastes the token via
// the guided form instead. The browser flow is a best-effort convenience, not the primary path.
export async function dispatchSlackConsoleJob(input: {
  db: PrismaClient;
  client: ClientRef;
  signInOnly: boolean;
  consoleUrl?: string;
  consoleSecretRef?: string;
}): Promise<DispatchResult> {
  const { db, client, signInOnly } = input;
  const consoleUrl = input.consoleUrl?.trim() || SLACK_SIGNIN_URL;
  const consoleSecretRef = input.consoleSecretRef?.trim() || undefined;
  try {
    const caseRequest = await db.caseRequest.create({
      data: {
        clientId: client.id,
        action: "onboard",
        createdSource: "api",
        subject: signInOnly ? "Slack console sign-in test" : "Slack API automated setup (console)",
        payload: { [MIMECAST_AUTOSETUP_MARKER]: true } as Prisma.InputJsonValue,
        ...(consoleSecretRef
          ? { secretOverrides: { [SLACK_CONSOLE_SECRET_NAME]: consoleSecretRef } as Prisma.InputJsonValue }
          : {}),
      },
      select: { id: true },
    });
    const request = {
      // Claim-gate invariant: every secretNames entry is REQUIRED to claim — satisfied by the wired
      // client secret OR the per-run case override above.
      secretNames: [SLACK_CONSOLE_SECRET_NAME],
      config: { consoleUrl, signInOnly },
      dependsOn: [],
      requiresApproval: false,
      captureEvidence: false,
    } as Prisma.InputJsonValue;
    const job = await db.job.create({
      data: { caseRequestId: caseRequest.id, systemKey: SLACK_CONSOLE_SETUP_KEY, mode: "api", sequence: 1, status: "pending", singleRun: true, request },
      select: { id: true },
    });
    return { ok: true, jobId: job.id };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
