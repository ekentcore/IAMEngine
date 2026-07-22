import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "ad-conntest-optional-dc-secret",
  date: "2026-07-22",
  time: "10:45",
  title: "Active Directory & directory-sync connection tests now pass on a domain controller with an agent installed",
  items: [
    "FR #0000024: a client with an on-prem agent installed (e.g. QPI Electrical) showed Active Directory and directory-sync FAILING their connection test — and therefore not-ready on Readiness — even though the agent was healthy and could reach AD",
    "Cause: the connection-test path treated the OPTIONAL ad-dc secret as REQUIRED. On a domain controller the agent authenticates as its own ambient SYSTEM identity and needs no credential, so ad-dc is normally left unwired. The runner brokered it up front anyway, that broker returned 'no usable secret', and the real AD probe never ran — a red test on a working setup",
    "Fix: the conn-test now splits secrets the same way a real job does — ad-dc is stripped from the required list and, only when a client has actually wired it (a member-server agent that genuinely needs it), re-attached as a best-effort optional secret. With nothing required, the runner skips the broker, runs the existing ambient-auth AD probe, and does a live Get-ADDomain call as proof the agent can talk to the directory",
    "So a correctly-set-up AD/directory-sync system now goes green off a real directory read, and Readiness reflects it. Re-run 'Test connections' (or retest the AD system) on an affected client to refresh the result — no agent update needed",
  ],
};
