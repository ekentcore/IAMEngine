// Starting, tracking and reading a detached Google Workspace auto-setup run — the OAuth+DWD-provision
// analog of m365-setup-run.ts. Client-scope only (no fleet mode): each run has exactly one
// GoogleSetupRunClient row, and the aggregate GoogleSetupRun mirrors that row's own terminal status
// ("done" | "needs_action" | "failed"), not just done/failed, since there's only ever one client to
// roll up.
import { Prisma, type PrismaClient } from "@prisma/client";
import type { GoogleSetupResult, GoogleSetupStage } from "./setup-google-client";
import { recordAudit } from "@/lib/auth/audit";
import { isSetupStale } from "./m365-setup-run";
import { secretIsSet } from "./wiring";

const GOOGLE_SYSTEM_KEY = "google-workspace";
const GOOGLE_ADMIN_WIRE_NAME = "google-admin";

// Matches setupGoogleForClient's own onStage param type exactly (Promise<void>, not void |
// Promise<void>) — our implementation is always an async function, so this costs nothing.
export type GoogleStageReporter = (stage: GoogleSetupStage, extra?: Partial<GoogleSetupResult>) => Promise<void>;

export type StartGoogleClient = { id: string; slug: string; name: string; delineaFolderId: string | null };

export type StartGoogleArgs = {
  client: StartGoogleClient;
  startedBy: string | null;
  seedSecretRef: string;
  forceRotate: boolean;
  runSetup: (onStage: GoogleStageReporter) => Promise<GoogleSetupResult>;
};

export type GoogleRunDeps = {
  now?: () => Date;
  detach?: (fn: () => Promise<void>) => void;
};

export type StartGoogleResult = { started: true; id: string } | { started: false; reason: string; id?: string };

export function googleSetupScope(clientId: string): string {
  return `client:${clientId}`;
}

export async function latestGoogleSetupRun(db: PrismaClient, clientId: string) {
  return db.googleSetupRun.findFirst({ where: { scope: googleSetupScope(clientId) }, orderBy: { startedAt: "desc" }, include: { clients: true } });
}

export async function startGoogleSetupRun(db: PrismaClient, args: StartGoogleArgs, deps: GoogleRunDeps = {}): Promise<StartGoogleResult> {
  const now = deps.now ?? (() => new Date());
  const detach = deps.detach ?? ((fn: () => Promise<void>) => { void fn(); });
  const scope = googleSetupScope(args.client.id);

  // One live run per client; a duplicate mutating run is not harmless (concurrent OAuth/DWD/provision
  // against the same client), so this is a real guard — a stale run (the app restarted mid-flight) is
  // finished off so a crash can't wedge the button forever. Same reap rule as m365 (isSetupStale,
  // reused rather than duplicated). The findFirst below is a deterministic pre-check that handles the
  // common already-running case cheaply; it is inherently TOCTOU-racy against a concurrent caller, so
  // the DB carries a partial unique index ("GoogleSetupRun_one_running_per_scope") as the atomic
  // backstop — see the create's catch below.
  const live = await db.googleSetupRun.findFirst({ where: { scope, status: "running" }, orderBy: { startedAt: "desc" } });
  if (live && !isSetupStale(live.startedAt, now())) return { started: false, reason: "a setup run is already in progress", id: live.id };
  if (live) await db.googleSetupRun.update({ where: { id: live.id }, data: { status: "failed", finishedAt: now(), error: "the app restarted while this run was in progress" } });

  let run;
  try {
    run = await db.googleSetupRun.create({ data: { scope, status: "running", startedBy: args.startedBy, total: 1 } });
  } catch (e) {
    // Lost the create race against a concurrent caller for the same scope — the unique index rejected
    // us. Point at the winner instead of failing opaquely.
    const winner = await db.googleSetupRun.findFirst({ where: { scope, status: "running" }, orderBy: { startedAt: "desc" } });
    if (winner) return { started: false, reason: "a setup run is already in progress", id: winner.id };
    throw e;
  }

  detach(async () => {
    let row: { id: string } | undefined;
    try {
      row = await db.googleSetupRunClient.create({
        data: { runId: run.id, clientId: args.client.id, slug: args.client.slug, name: args.client.name, status: "running" },
      });
      const stepRow = row;
      // Live step tracker: persist stage + whatever the core has learned so far (saEmail/saClientId as
      // provisioning resolves them, userAction the moment a manual-DWD fallback is decided). Best-effort
      // — swallow any write error so a progress blip can't derail the run.
      const onStage: GoogleStageReporter = async (stage, extra) => {
        await db.googleSetupRunClient.update({
          where: { id: stepRow.id },
          data: {
            stage,
            ...(extra?.saEmail ? { saEmail: extra.saEmail } : {}),
            ...(extra?.saClientId ? { saClientId: extra.saClientId } : {}),
            ...(extra?.userAction ? { userAction: extra.userAction } : {}),
          },
        }).catch(() => {});
      };

      let res: GoogleSetupResult;
      try {
        res = await args.runSetup(onStage);
      } catch (e) {
        res = { ok: false, stage: "error", error: (e as Error).message, browserWarnings: [], actions: [] };
      }

      // Terminal mapping (binding): ok && no fallback card -> done; ok && a manual-DWD fallback card ->
      // needs_action (the operator still has to paste the grant by hand); anything else -> failed.
      const status = res.ok && !res.userAction ? "done" : res.ok && res.userAction ? "needs_action" : "failed";

      await db.googleSetupRunClient.update({
        where: { id: row.id },
        data: {
          status,
          stage: res.stage,
          saEmail: res.saEmail ?? null,
          saClientId: res.saClientId ?? null,
          verified: res.verified ?? null,
          error: res.ok ? null : (res.error ?? null),
          warnings: res.browserWarnings ?? [],
          userAction: (res.userAction ?? Prisma.DbNull) as Prisma.InputJsonValue,
          log: res.actions ?? [],
        },
      });

      // Best-effort audit trail entry — fire-and-forget so a slow/unreachable audit write can never
      // delay (let alone derail) this client's run; recordAudit itself never throws, the extra .catch
      // is defense-in-depth against a rejected promise.
      void recordAudit("google.setup.client", {
        clientId: args.client.id,
        detail: { status, stage: res.stage, saEmail: res.saEmail, externalId: res.externalId, warnings: res.browserWarnings },
      }).catch(() => {});

      await db.googleSetupRun.update({
        where: { id: run.id },
        data: { status, finishedAt: now(), completed: 1, succeeded: res.ok ? 1 : 0, failed: res.ok ? 0 : 1 },
      }).catch(() => {});
    } catch (e) {
      if (row) {
        await db.googleSetupRunClient.update({ where: { id: row.id }, data: { status: "failed", error: (e as Error).message } }).catch(() => {});
      }
      await db.googleSetupRun.update({ where: { id: run.id }, data: { status: "failed", finishedAt: now(), error: (e as Error).message, completed: 1, failed: 1 } }).catch(() => {});
    }
  });

  return { started: true, id: run.id };
}

// --- Auto-triggered connection test (GET-poll side effect) -------------------------------------------
// Adjudicated design point: a kept-valid re-run (the operator pasted the DWD grant by hand and clicked
// "Verify again") returns from the core with `verified` UNSET — the auto-triggered google-workspace
// conn test is THE verification signal on that path. So this fires whenever the run has landed on a
// terminal client-facing state that could plausibly have a working credential (done OR needs_action),
// not only a pristine ok+verified run.
export type GoogleConnTestVerdict = {
  status: string;
  detail: string | null;
  accessOk: boolean | null;
  accessDetail: string | null;
  fieldsOk: boolean | null;
  fieldsDetail: string | null;
  finishedAt: Date | null;
} | null;

// Structurally-typed subset of RunnerService — kept minimal so this stays unit-testable with a fake,
// no real runner-service.ts wiring required.
// Method-shorthand (not an arrow-property) so a concrete RunnerService whose `source` param is a
// narrower string-literal union than `string` still satisfies this — TS checks method parameters
// bivariantly, arrow-typed properties contravariantly (see this file's route caller).
export type ConnTestRunnerLike = {
  requestConnectionTests(clientSlug: string, systemKey?: string, source?: string): Promise<unknown>;
};

export async function ensureGoogleConnTestTriggered(
  db: PrismaClient,
  runnerService: ConnTestRunnerLike,
  client: { id: string; slug: string },
  run: { status: string; finishedAt: Date | null },
): Promise<GoogleConnTestVerdict> {
  const terminal = run.status === "done" || run.status === "needs_action";
  if (terminal && run.finishedAt) {
    const sec = await db.secret.findUnique({
      where: { clientId_name: { clientId: client.id, name: GOOGLE_ADMIN_WIRE_NAME } },
      select: { externalId: true },
    });
    if (secretIsSet(sec?.externalId)) {
      // Trigger-once: use requestedAt (stamped the instant a test is QUEUED), never finishedAt — a
      // just-triggered test is still pending (finishedAt null) when the UI's next poll lands, and a
      // finishedAt-based check would re-fire on every poll until the runner reports back.
      const latest = await db.connectionTest.findFirst({
        where: { clientId: client.id, systemKey: GOOGLE_SYSTEM_KEY },
        orderBy: { requestedAt: "desc" },
        select: { requestedAt: true },
      });
      const alreadyTriggeredSinceThisRun = Boolean(latest && latest.requestedAt >= run.finishedAt);
      if (!alreadyTriggeredSinceThisRun) {
        await runnerService.requestConnectionTests(client.slug, GOOGLE_SYSTEM_KEY, "google-setup").catch(() => {});
      }
    }
  }
  // Always include the newest verdict, whether or not this call triggered anything.
  const verdict = await db.connectionTest.findFirst({
    where: { clientId: client.id, systemKey: GOOGLE_SYSTEM_KEY },
    orderBy: { requestedAt: "desc" },
    select: { status: true, detail: true, accessOk: true, accessDetail: true, fieldsOk: true, fieldsDetail: true, finishedAt: true },
  });
  return verdict ?? null;
}
