import type { PrismaClient, Prisma } from "@prisma/client";
import { ZOOM_CONSOLE_SETUP_KEY } from "@/lib/jobs/adhoc";
import { MIMECAST_AUTOSETUP_MARKER } from "@/lib/cases/exclude-m365-autosetup";

// The vaulted Zoom admin console login the runner's browser flow signs in WITH (email + password, TOTP
// seed / OTP on the Delinea secret). DISTINCT from the "zoom" API credential (accountId/clientId/
// clientSecret) it CREATES. Must match field-requirements.ts "zoom-console".
export const ZOOM_CONSOLE_SECRET_NAME = "zoom-console";

// Zoom's sign-in URL the flow navigates to (overridable per dispatch — rarely needed).
export const ZOOM_SIGNIN_URL = "https://zoom.us/signin";

type ClientRef = { id: string };
type DispatchResult = { ok: true; jobId: string } | { ok: false; error: string };

// Dispatch the Zoom console browser job. signInOnly:true proves the login (Test sign-in); signInOnly:
// false creates the Server-to-Server OAuth app + harvests its credential + returns it for the app to
// vault. Mirrors dispatch-mimecast-console-job.ts exactly: a synthetic mimecastAutoSetup-marked case
// (hidden from /cases + bulk-replan) carrying an optional per-run console-login ref, and a singleRun
// job only a browser-capable agent can claim (ZOOM_CONSOLE_SETUP_KEY ∈ BROWSER_SYSTEMS).
export async function dispatchZoomConsoleJob(input: {
  db: PrismaClient;
  client: ClientRef;
  signInOnly: boolean;
  consoleUrl?: string;
  consoleSecretRef?: string;
}): Promise<DispatchResult> {
  const { db, client, signInOnly } = input;
  const consoleUrl = input.consoleUrl?.trim() || ZOOM_SIGNIN_URL;
  const consoleSecretRef = input.consoleSecretRef?.trim() || undefined;
  try {
    const caseRequest = await db.caseRequest.create({
      data: {
        clientId: client.id,
        action: "onboard",
        createdSource: "api",
        subject: signInOnly ? "Zoom console sign-in test" : "Zoom API automated setup (console)",
        payload: { [MIMECAST_AUTOSETUP_MARKER]: true } as Prisma.InputJsonValue,
        ...(consoleSecretRef
          ? { secretOverrides: { [ZOOM_CONSOLE_SECRET_NAME]: consoleSecretRef } as Prisma.InputJsonValue }
          : {}),
      },
      select: { id: true },
    });
    const request = {
      // Claim-gate invariant: every secretNames entry is REQUIRED to claim — satisfied by the wired
      // client secret OR the per-run case override above.
      secretNames: [ZOOM_CONSOLE_SECRET_NAME],
      config: { consoleUrl, signInOnly },
      dependsOn: [],
      requiresApproval: false,
      captureEvidence: false,
    } as Prisma.InputJsonValue;
    const job = await db.job.create({
      data: { caseRequestId: caseRequest.id, systemKey: ZOOM_CONSOLE_SETUP_KEY, mode: "api", sequence: 1, status: "pending", singleRun: true, request },
      select: { id: true },
    });
    return { ok: true, jobId: job.id };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
