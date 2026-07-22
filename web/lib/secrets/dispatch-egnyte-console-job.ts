import type { PrismaClient, Prisma } from "@prisma/client";
import { EGNYTE_CONSOLE_SETUP_KEY } from "@/lib/jobs/adhoc";
import { MIMECAST_AUTOSETUP_MARKER } from "@/lib/cases/exclude-m365-autosetup";

// The vaulted Egnyte admin console login the runner's browser flow signs in WITH (email + password,
// optional TOTP seed on the Delinea secret). DISTINCT from the "egnyte" API credential (domain + API
// token) it HARVESTS. Must match field-requirements.ts "egnyte-console".
export const EGNYTE_CONSOLE_SECRET_NAME = "egnyte-console";

type ClientRef = { id: string };
type DispatchResult = { ok: true; jobId: string } | { ok: false; error: string };

// Dispatch the Egnyte console browser job. signInOnly:true proves the login (Test sign-in); signInOnly:
// false additionally harvests the domain API token and returns it for the app to vault. Mirrors
// dispatch-zoom-console-job.ts: a synthetic mimecastAutoSetup-marked case (hidden from /cases +
// bulk-replan) carrying an optional per-run console-login ref, and a singleRun job only a browser-
// capable agent can claim (EGNYTE_CONSOLE_SETUP_KEY ∈ BROWSER_SYSTEMS). The client's Egnyte domain
// travels in config so the flow can build the https://<domain>.egnyte.com sign-in URL.
export async function dispatchEgnyteConsoleJob(input: {
  db: PrismaClient;
  client: ClientRef;
  signInOnly: boolean;
  egnyteDomain: string;
  consoleUrl?: string;
  consoleSecretRef?: string;
}): Promise<DispatchResult> {
  const { db, client, signInOnly, egnyteDomain } = input;
  const consoleUrl = input.consoleUrl?.trim() || undefined;
  const consoleSecretRef = input.consoleSecretRef?.trim() || undefined;
  try {
    const caseRequest = await db.caseRequest.create({
      data: {
        clientId: client.id,
        action: "onboard",
        createdSource: "api",
        subject: signInOnly ? "Egnyte console sign-in test" : "Egnyte API automated setup (console)",
        payload: { [MIMECAST_AUTOSETUP_MARKER]: true } as Prisma.InputJsonValue,
        ...(consoleSecretRef
          ? { secretOverrides: { [EGNYTE_CONSOLE_SECRET_NAME]: consoleSecretRef } as Prisma.InputJsonValue }
          : {}),
      },
      select: { id: true },
    });
    const request = {
      // Claim-gate invariant: every secretNames entry is REQUIRED to claim — satisfied by the wired
      // client secret OR the per-run case override above.
      secretNames: [EGNYTE_CONSOLE_SECRET_NAME],
      config: { consoleUrl, signInOnly, egnyteDomain },
      dependsOn: [],
      requiresApproval: false,
      captureEvidence: false,
    } as Prisma.InputJsonValue;
    const job = await db.job.create({
      data: { caseRequestId: caseRequest.id, systemKey: EGNYTE_CONSOLE_SETUP_KEY, mode: "api", sequence: 1, status: "pending", singleRun: true, request },
      select: { id: true },
    });
    return { ok: true, jobId: job.id };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
