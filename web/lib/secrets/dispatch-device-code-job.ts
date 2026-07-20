import type { PrismaClient, Prisma } from "@prisma/client";
import { ENTRA_DEVICECODE_KEY } from "@/lib/jobs/adhoc";

// The GA login the runner's device-code browser flow signs in WITH (interactive UPN+password, OTP on
// the secret). Must match field-requirements.ts "m365-global-admin".
const GA_SECRET_NAME = "m365-global-admin";

type ClientRef = { id: string };

// Create a MINIMAL synthetic case to host ONE entra-devicecode browser job. A Job needs a non-null
// caseRequestId FK and there is no lightweight "system case" factory, so we mint an onboard/api case
// with an empty-ish payload flagged m365AutoSetup. The job is singleRun (claimable in isolation, no
// cascade). Browser-capability claim gating is already wired (BROWSER_SYSTEMS includes this key).
export async function dispatchDeviceCodeJob(
  db: PrismaClient,
  client: ClientRef,
  userCode: string
): Promise<{ jobId: string }> {
  const caseRequest = await db.caseRequest.create({
    data: {
      clientId: client.id,
      action: "onboard",
      createdSource: "api",
      subject: "M365 automated setup (device-code sign-in)",
      payload: { m365AutoSetup: true } as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  const request = {
    secretNames: [GA_SECRET_NAME],
    config: { userCode },
    dependsOn: [],
    requiresApproval: false,
    captureEvidence: false,
  } as Prisma.InputJsonValue;
  const job = await db.job.create({
    data: {
      caseRequestId: caseRequest.id,
      systemKey: ENTRA_DEVICECODE_KEY,
      mode: "api",
      sequence: 1,
      status: "pending",
      singleRun: true,
      request,
    },
    select: { id: true },
  });
  return { jobId: job.id };
}
