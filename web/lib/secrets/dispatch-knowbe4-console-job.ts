import type { PrismaClient, Prisma } from "@prisma/client";
import { KNOWBE4_CONSOLE_SETUP_KEY } from "@/lib/jobs/adhoc";
import { MIMECAST_AUTOSETUP_MARKER } from "@/lib/cases/exclude-m365-autosetup";

// The vaulted KnowBe4 admin console login the runner's browser flow signs in WITH (email + password,
// optional TOTP seed / OTP on the Delinea secret). DISTINCT from the "knowbe4" API credential (the SCIM
// provisioning token) it CREATES. Must match field-requirements.ts "knowbe4-console".
export const KNOWBE4_CONSOLE_SECRET_NAME = "knowbe4-console";

// KnowBe4's sign-in URL the flow navigates to (overridable per dispatch — rarely needed).
export const KNOWBE4_SIGNIN_URL = "https://training.knowbe4.com/";

type ClientRef = { id: string };
type DispatchResult = { ok: true; jobId: string } | { ok: false; error: string };

// Dispatch the KnowBe4 console browser job. signInOnly:true proves the login (Test sign-in); signInOnly:
// false enables + harvests the SCIM token + returns it for the app to vault. Mirrors
// dispatch-mimecast-console-job.ts / dispatch-zoom-console-job.ts: a synthetic case marked with the
// (reused) MIMECAST_AUTOSETUP_MARKER so it's hidden from /cases + bulk-replan, carrying an optional
// per-run console-login ref, and a singleRun job only a browser-capable agent can claim
// (KNOWBE4_CONSOLE_SETUP_KEY ∈ BROWSER_SYSTEMS).
export async function dispatchKnowBe4ConsoleJob(input: {
  db: PrismaClient;
  client: ClientRef;
  signInOnly: boolean;
  consoleUrl?: string;
  consoleSecretRef?: string;
}): Promise<DispatchResult> {
  const { db, client, signInOnly } = input;
  const consoleUrl = input.consoleUrl?.trim() || KNOWBE4_SIGNIN_URL;
  const consoleSecretRef = input.consoleSecretRef?.trim() || undefined;
  try {
    const caseRequest = await db.caseRequest.create({
      data: {
        clientId: client.id,
        action: "onboard",
        createdSource: "api",
        subject: signInOnly ? "KnowBe4 console sign-in test" : "KnowBe4 API automated setup (console)",
        payload: { [MIMECAST_AUTOSETUP_MARKER]: true } as Prisma.InputJsonValue,
        ...(consoleSecretRef
          ? { secretOverrides: { [KNOWBE4_CONSOLE_SECRET_NAME]: consoleSecretRef } as Prisma.InputJsonValue }
          : {}),
      },
      select: { id: true },
    });
    const request = {
      // Claim-gate invariant: every secretNames entry is REQUIRED to claim — satisfied by the wired
      // client secret OR the per-run case override above.
      secretNames: [KNOWBE4_CONSOLE_SECRET_NAME],
      config: { consoleUrl, signInOnly },
      dependsOn: [],
      requiresApproval: false,
      captureEvidence: false,
    } as Prisma.InputJsonValue;
    const job = await db.job.create({
      data: { caseRequestId: caseRequest.id, systemKey: KNOWBE4_CONSOLE_SETUP_KEY, mode: "api", sequence: 1, status: "pending", singleRun: true, request },
      select: { id: true },
    });
    return { ok: true, jobId: job.id };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
