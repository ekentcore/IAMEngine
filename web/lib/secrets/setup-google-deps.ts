// The real dependency bundle setupGoogleForClient runs against in production. Pure wiring — the pieces
// (Tasks 2-6) are already unit-tested; this keeps the seams thin. The Google analog of
// setup-m365-deps.ts. `awaitJobResult` is the one piece with real behavior here: it polls the Job row
// (5 s interval) until a terminal status, extracting WARN lines the way the M365 flow's extractWarnings
// does, so it carries its own test.
import type { PrismaClient } from "@prisma/client";
import type { GoogleSetupDeps, JobAwaitResult } from "./setup-google-client";
import { extractWarnings } from "./setup-m365-client";
import { makePkcePair, buildAuthUrl, exchangeCodeForToken, OAUTH_REDIRECT_URI } from "./google-oauth";
import { provisionGoogleWorkspace, deleteServiceAccountKey } from "./provision-google-workspace";
import { probeWithDwdRetry } from "./google-verify";
import { writeGoogleWorkspaceCreds } from "./write-google-workspace";
import { dispatchGoogleOAuthJob, dispatchGoogleDwdJob } from "./dispatch-google-browser-job";
import { resolveSecretFields, delineaConfigFromEnv } from "./delinea";
import { secretIsSet } from "./wiring";

const GOOGLE_SYSTEM_KEY = "google-workspace";
const GOOGLE_ADMIN_WIRE_NAME = "google-admin";
const JOB_POLL_INTERVAL_MS = 5000;

// A Job is terminal once it can no longer transition on its own. `succeeded` is the only success.
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "skipped", "manual"]);

// Collect every string leaf out of an opaque job `result` (the runner posts arbitrary JSON), joined by
// newlines, so the caller's `OAUTH_CODE:<code>` line match works regardless of where in the shape the
// runner recorded it. Depth-bounded like extractWarnings.
function collectResultText(v: unknown, depth = 0): string {
  if (depth > 5) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((x) => collectResultText(x, depth + 1)).filter(Boolean).join("\n");
  if (v && typeof v === "object") {
    return Object.values(v as Record<string, unknown>)
      .map((x) => collectResultText(x, depth + 1))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

// Test seam: injectable clock + sleep + poll interval so awaitJobResult's timeout path is testable
// without real 5 s waits.
export type GoogleDepsOptions = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
};

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export function buildGoogleSetupDeps(db: PrismaClient, opts: GoogleDepsOptions = {}): GoogleSetupDeps {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const pollIntervalMs = opts.pollIntervalMs ?? JOB_POLL_INTERVAL_MS;

  return {
    hasGoogleSystem: async (clientId) =>
      (await db.clientSystem.count({ where: { clientId, systemKey: GOOGLE_SYSTEM_KEY } })) > 0,

    readSeedUsername: async (seedSecretRef) => {
      const res = await resolveSecretFields(delineaConfigFromEnv(), seedSecretRef);
      if (!res.ok || !res.fields) return null;
      const username = res.fields.Username;
      // Must be an email address — DWD impersonation needs a real super-admin login, not a bare name.
      if (typeof username !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(username)) return null;
      return username;
    },

    vaultedKeyPresent: async (clientId) => {
      const row = await db.secret.findUnique({
        where: { clientId_name: { clientId, name: GOOGLE_ADMIN_WIRE_NAME } },
        select: { externalId: true },
      });
      return secretIsSet(row?.externalId);
    },

    makePkce: () => makePkcePair(),
    buildAuthUrl: (challenge, loginHint) => buildAuthUrl(challenge, loginHint),

    dispatchOAuthJob: ({ client, seedSecretRef, authUrl }) =>
      dispatchGoogleOAuthJob({ db, client, seedSecretRef, authUrl, redirectUri: OAUTH_REDIRECT_URI }),

    awaitJobResult: async (jobId, timeoutMs): Promise<JobAwaitResult> => {
      const start = now();
      for (;;) {
        const job = await db.job.findUnique({ where: { id: jobId }, select: { status: true, result: true } });
        const status = job?.status ?? "unknown";
        if (TERMINAL_STATUSES.has(status)) {
          return {
            ok: status === "succeeded",
            resultText: collectResultText(job?.result) || undefined,
            warnings: extractWarnings(job?.result),
          };
        }
        if (now() - start >= timeoutMs) {
          return { ok: false, resultText: undefined, warnings: extractWarnings(job?.result) };
        }
        await sleep(pollIntervalMs);
      }
    },

    exchangeCode: (code, verifier) => exchangeCodeForToken(code, verifier),

    provision: ({ accessToken, clientSlug, needKey }) =>
      provisionGoogleWorkspace({ accessToken, clientSlug, needKey }),

    dispatchDwdJob: ({ client, seedSecretRef, saClientId, scopes }) =>
      dispatchGoogleDwdJob({ db, client, seedSecretRef, saClientId, scopes }),

    probeWithRetry: ({ keyBase64, impersonate }) => probeWithDwdRetry({ keyBase64, impersonate }),

    write: ({ client, provision, impersonate, customerId }) =>
      writeGoogleWorkspaceCreds({ db, client, provision, impersonate, customerId }),

    // Note the arg-order swap: the module takes (accessToken, keyName); the dep exposes (keyName, accessToken).
    deleteIssuedKey: (keyName, accessToken) => deleteServiceAccountKey(accessToken, keyName),
  };
}
