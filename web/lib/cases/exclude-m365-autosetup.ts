import { Prisma } from "@prisma/client"; // value import — Prisma.DbNull is used at runtime

// The synthetic onboard case that hosts a lone entra-devicecode browser job carries this marker in
// its payload (see lib/secrets/dispatch-device-code-job.ts). It isn't a real intake case, so list
// and bulk-replan queries exclude it.
export const M365_AUTOSETUP_MARKER = "m365AutoSetup" as const;

// A Prisma where-fragment that matches every case EXCEPT the synthetic m365AutoSetup one.
//
// The obvious `NOT: { payload: { path: [MARKER], equals: true } }` is WRONG on its own: for the
// overwhelming majority of cases the payload has no `m365AutoSetup` key at all, so the JSON path
// resolves to SQL NULL, `NULL = true` is NULL, and `NOT NULL` is NULL — which Postgres treats as
// "not matched". That silently drops EVERY normal case (this emptied the whole /cases queue after
// PR #131). We must also explicitly keep the rows whose path is NULL (key absent → Prisma.DbNull).
export const notM365AutoSetupCase: Prisma.CaseRequestWhereInput = {
  OR: [
    { NOT: { payload: { path: [M365_AUTOSETUP_MARKER], equals: true } } },
    { payload: { path: [M365_AUTOSETUP_MARKER], equals: Prisma.DbNull } },
  ],
};
