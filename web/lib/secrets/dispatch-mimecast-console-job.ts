import type { PrismaClient, Prisma } from "@prisma/client";
import { MIMECAST_CONSOLE_SETUP_KEY } from "@/lib/jobs/adhoc";
import { MIMECAST_AUTOSETUP_MARKER } from "@/lib/cases/exclude-m365-autosetup";

// The vaulted Mimecast Administration Console login the runner's browser flow signs in WITH — a
// Mimecast admin email + password (OTP enabled on the Delinea secret). DISTINCT from the "mimecast"
// API 2.0 credential (clientId/secret): a login box can't authenticate an API key. Must match
// field-requirements.ts "mimecast-console".
export const MIMECAST_CONSOLE_SECRET_NAME = "mimecast-console";

// The Mimecast Administration Console sign-in URL the flow navigates to. Overridable per dispatch
// (rarely needed — Mimecast's console login is a single global host).
export const MIMECAST_CONSOLE_URL = "https://login.mimecast.com/";

type ClientRef = { id: string };

type DispatchResult = { ok: true; jobId: string } | { ok: false; error: string };

// Dispatch the Mimecast console browser job. Phase 1 uses signInOnly:true — the flow signs into the
// console and reports success only, changing nothing; the "Test sign-in" button in the guided-setup
// modal's Automatic tab drives it. (Phase 2 will pass signInOnly:false to create the API app + harvest
// + vault.)
//
// Mirrors dispatch-device-code-job.ts: a Job needs a non-null caseRequestId FK and there is no
// lightweight "system case" factory, so we mint a synthetic onboard/api case flagged
// mimecastAutoSetup (so notM365AutoSetupCase hides it from /cases + bulk-replan). The job is singleRun
// (claimable in isolation, no cascade). The console login is a PERSISTENT per-client secret resolved
// by the normal broker — no secretOverrides. Only browser-capable agents can claim it
// (BROWSER_SYSTEMS includes this key).
export async function dispatchMimecastConsoleJob(input: {
  db: PrismaClient;
  client: ClientRef;
  signInOnly: boolean;
  consoleUrl?: string;
}): Promise<DispatchResult> {
  const { db, client, signInOnly } = input;
  const consoleUrl = input.consoleUrl?.trim() || MIMECAST_CONSOLE_URL;
  try {
    const caseRequest = await db.caseRequest.create({
      data: {
        clientId: client.id,
        action: "onboard",
        createdSource: "api",
        subject: signInOnly ? "Mimecast console sign-in test" : "Mimecast API automated setup (console)",
        payload: { [MIMECAST_AUTOSETUP_MARKER]: true } as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    const request = {
      // Claim-gate invariant: every secretNames entry is REQUIRED for claiming. The console login is a
      // persistent client secret, so the job is claimable only once it's wired — which is exactly the
      // precondition the flow needs (an unwired name would make the job hang unclaimable; the route
      // refuses up front with an actionable message instead).
      secretNames: [MIMECAST_CONSOLE_SECRET_NAME],
      config: { consoleUrl, signInOnly },
      dependsOn: [],
      requiresApproval: false,
      captureEvidence: false,
    } as Prisma.InputJsonValue;
    const job = await db.job.create({
      data: {
        caseRequestId: caseRequest.id,
        systemKey: MIMECAST_CONSOLE_SETUP_KEY,
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
