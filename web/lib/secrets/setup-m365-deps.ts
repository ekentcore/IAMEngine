import type { PrismaClient } from "@prisma/client";
import type { SetupDeps } from "./setup-m365-client";
import { startDeviceCode, pollDeviceCodeToken } from "./device-code-auth";
import { provisionM365App } from "./provision-m365-app";
import { writeProvisionedM365App } from "./write-m365-app";
import { dispatchDeviceCodeJob } from "./dispatch-device-code-job";

const GA_SECRET_NAME = "m365-global-admin";

// The real dependency bundle setupM365ForClient runs against in production. Pure wiring — the pieces
// are already unit-tested; keep this thin so it needs no tests beyond "every key is present + the two
// db-touching deps query correctly".
export function buildSetupDeps(db: PrismaClient): SetupDeps {
  return {
    startDeviceCode: (tenant) => startDeviceCode(tenant),
    pollDeviceCodeToken: (tenant, deviceCode, opts) => pollDeviceCodeToken(tenant, deviceCode, opts),
    provisionM365App: (input) => provisionM365App(input),
    writeProvisionedM365App: (input) => writeProvisionedM365App(input, { db }),
    hasGlobalAdminSecret: async (clientId) => {
      const row = await db.secret.findUnique({ where: { clientId_name: { clientId, name: GA_SECRET_NAME } }, select: { id: true } });
      return row != null;
    },
    dispatchDeviceCodeJob: (client, userCode, gaSecretRef) => dispatchDeviceCodeJob(db, client, userCode, gaSecretRef),
    getJob: async (jobId) => {
      const j = await db.job.findUnique({ where: { id: jobId }, select: { status: true, result: true, error: true } });
      return { status: j?.status ?? "unknown", result: j?.result ?? null, error: j?.error ?? null };
    },
  };
}
