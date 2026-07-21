import type { PrismaClient, Prisma } from "@prisma/client";
import { GOOGLE_OAUTH_SIGNIN_KEY, GOOGLE_DWD_GRANT_KEY } from "@/lib/jobs/adhoc";
import { GOOGLE_AUTOSETUP_MARKER } from "@/lib/cases/exclude-m365-autosetup";

// The vaulted interactive Google super-admin login the runner's browser flows sign in WITH (OAuth
// consent sign-in, and — with that session already established — the domain-wide-delegation grant
// in the Admin console). Distinct from the "google-admin" secret (the service-account API key used
// by the non-browser Google Workspace lane) — this one is a human login, not a service account.
const GOOGLE_SUPER_ADMIN_SECRET_NAME = "google-super-admin";

type ClientRef = { id: string; slug: string; name: string };

type DispatchResult = { ok: true; jobId: string } | { ok: false; error: string };

// Mint a synthetic onboard/api case to host ONE browser job, mirroring
// lib/secrets/dispatch-device-code-job.ts: a Job needs a non-null caseRequestId FK and there is no
// lightweight "system case" factory, so each dispatch creates its own single-job case, flagged
// googleAutoSetup so notM365AutoSetupCase hides it from the /cases queue and bulk-replan. The job is
// singleRun (claimable in isolation, no cascade). Browser-capability claim gating and the runner
// flows themselves land in a later task; this only creates the claimable Job row.
async function createBrowserJobCase(
  db: PrismaClient,
  client: ClientRef,
  subject: string,
  seedSecretRef: string
): Promise<{ id: string }> {
  return db.caseRequest.create({
    data: {
      clientId: client.id,
      action: "onboard",
      createdSource: "api",
      subject,
      payload: { [GOOGLE_AUTOSETUP_MARKER]: true } as Prisma.InputJsonValue,
      // A per-run seed reference (Task 5's guided seed flow, or a stored client secret resolved by
      // the caller): the credential broker prefers this case override over any stored client
      // secret, so the runner's browser job signs in without anything else vaulted on the client.
      secretOverrides: { [GOOGLE_SUPER_ADMIN_SECRET_NAME]: seedSecretRef } as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
}

// Dispatch the interactive Google super-admin OAuth sign-in browser job: the runner navigates to
// authUrl (the PKCE challenge is already embedded), signs in interactively, and captures the
// authorization code redirected to redirectUri.
export async function dispatchGoogleOAuthJob(input: {
  db: PrismaClient;
  client: ClientRef;
  seedSecretRef: string;
  authUrl: string;
  redirectUri: string;
}): Promise<DispatchResult> {
  const { db, client, seedSecretRef, authUrl, redirectUri } = input;
  try {
    const caseRequest = await createBrowserJobCase(
      db,
      client,
      "Google Workspace automated setup (OAuth sign-in)",
      seedSecretRef
    );
    const request = {
      // Claim-gate invariant: every secretNames entry is REQUIRED for claiming. This is the same
      // name secretOverrides supplies above, so the job stays claimable purely off the case
      // override — no client-level "google-super-admin" secret has to exist.
      secretNames: [GOOGLE_SUPER_ADMIN_SECRET_NAME],
      config: { authUrl, redirectUri },
      dependsOn: [],
      requiresApproval: false,
      captureEvidence: false,
    } as Prisma.InputJsonValue;
    const job = await db.job.create({
      data: {
        caseRequestId: caseRequest.id,
        systemKey: GOOGLE_OAUTH_SIGNIN_KEY,
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

// Dispatch the domain-wide-delegation grant browser job: with the super-admin session already
// established (by dispatchGoogleOAuthJob), the runner adds saClientId + scopes as an API client in
// the Admin console's DWD panel.
export async function dispatchGoogleDwdJob(input: {
  db: PrismaClient;
  client: ClientRef;
  seedSecretRef: string;
  saClientId: string;
  scopes: readonly string[];
}): Promise<DispatchResult> {
  const { db, client, seedSecretRef, saClientId, scopes } = input;
  try {
    const caseRequest = await createBrowserJobCase(
      db,
      client,
      "Google Workspace automated setup (domain-wide delegation grant)",
      seedSecretRef
    );
    const request = {
      secretNames: [GOOGLE_SUPER_ADMIN_SECRET_NAME],
      config: { saClientId, scopes },
      dependsOn: [],
      requiresApproval: false,
      captureEvidence: false,
    } as Prisma.InputJsonValue;
    const job = await db.job.create({
      data: {
        caseRequestId: caseRequest.id,
        systemKey: GOOGLE_DWD_GRANT_KEY,
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
