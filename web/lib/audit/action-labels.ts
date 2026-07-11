// Human-readable labels for audit action keys: "auth.login.sso" -> "SSO Login". Known actions are
// mapped explicitly; anything else is prettified (split on . _ : -, title-cased, acronyms fixed) so a
// new action still reads cleanly without a code change.

const EXPLICIT: Record<string, string> = {
  "auth.login": "Login",
  "auth.login.sso": "SSO Login",
  "auth.login.breakglass": "Break-glass Login",
  "auth.login.failed": "Login Failed",
  "auth.logout": "Logout",
  "auth.change_password": "Password Changed",
  "auth.sso.denied": "SSO Denied",
  "auth.sso.error": "SSO Error",

  "agent.enroll": "Agent Enrolled",
  "agent.update_requested": "Agent Update Requested",
  "agent.trash": "Agent Trashed",
  "agent.restore": "Agent Restored",
  "agent.delete": "Agent Deleted",
  "agent.purge": "Agent Purged",

  "case.plan": "Case Planned",
  "case.replan": "Case Re-planned",
  "case.auto_verify": "Case Auto-verified",
  "case.trash": "Case Trashed",
  "case.restore": "Case Restored",
  "case.delete_forever": "Case Permanently Deleted",

  "client.add": "Client Added",
  "client.create": "Client Created",
  "client.reconcile": "Client Reconciled",
  "client.hard_refresh": "Client Hard-refreshed",
  "client.refresh_name": "Client Name Refreshed",
  "client.backbone.set": "Client Backbone Set",
  "client.domain.set": "Client Domain Set",
  "client.email_domain.set": "Client Email Domain Set",
  "client.username_pattern.set": "Client Username Format Set",
  "client.intake_source.set": "Client Intake Source Set",
  "client.restricted.set": "Client Restriction Set",
  "client.rules.edit": "Client Rules Edited",
  "client.runbook.set": "Client Runbook Set",
  "client.secrets.edit": "Client Secrets Edited",
  "client.secrets.test": "Client Secrets Tested",
  "client.systems.edit": "Client Systems Edited",
  "client.ad_discovery.request": "AD Discovery Requested",
  "client.ad_discovery.result": "AD Discovery Result",

  "job.claim": "Step Claimed",
  "job.credential": "Step Credential Brokered",
  "job.approve": "Step Approved",
  "job.rerun": "Step Re-run",
  "job.run_single": "Single Step Run",
  "job.stop": "Step Stopped",
  "job.lease.reclaim": "Step Lease Reclaimed",
  "job.progress.failed": "Step Marked Failed",
  "job.progress.reclaim": "Step Reclaimed",
  "job.autoretry.requeued": "Auto-retry Requeued",
  "job.autoretry.resolved": "Auto-retry Resolved",
  "job.autoretry.retry_now": "Retried Now",

  "cloudgroups.claim": "Cloud Groups Claimed",
  "cloudgroups.result": "Cloud Groups Result",
  "conntest.credential": "Connection Test Credential",
  "conntest.result": "Connection Test Result",
  "conntest.request": "Connection Test Requested",
  "client.delinea.selfcheck": "Delinea Self-Check",
  "system.setup.start": "System Setup Started",
  "system.setup.attest": "System Rights Attested",
  "system.setup.clear_attest": "System Rights Attestation Cleared",
  "system.setup.attest.cleared": "System Rights Attestation Auto-Cleared",

  "procurement.watch.set": "Procurement Watch Set",
  "procurement.watch.clear": "Procurement Watch Cleared",
  "procurement.cancelled": "Procurement Cancelled",

  "servicenow.sync": "ServiceNow Sync",
  "servicenow.worknote.posted": "ServiceNow Work Note Posted",
  "servicenow.worknote.pending": "ServiceNow Work Note Pending",
  "servicenow.worknote.failed": "ServiceNow Work Note Failed",
};

const ACRONYMS: Record<string, string> = {
  sso: "SSO", ad: "AD", m365: "M365", sn: "ServiceNow", ui: "UI", api: "API",
  dc: "DC", exo: "EXO", id: "ID", csv: "CSV", url: "URL", os: "OS", ip: "IP",
};

function prettify(key: string): string {
  return key
    .split(/[._:\-/]/)
    .filter(Boolean)
    .map((w) => ACRONYMS[w.toLowerCase()] ?? w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function actionLabel(action: string): string {
  return EXPLICIT[action] ?? prettify(action);
}

// A friendly GROUP for an action, so related keys collapse into one "All X" filter — e.g. every
// auth.login* (incl. SSO) groups under "Login". Used by the audit multi-select.
const GROUP_BY_SEGMENT: Record<string, string> = {
  client: "Client", job: "Step", case: "Case", agent: "Agent",
  servicenow: "ServiceNow", cloudgroups: "Cloud groups", conntest: "Connection test", procurement: "Procurement",
};
export function actionGroup(action: string): string {
  if (action.startsWith("auth.login") || action === "auth.logout") return "Login";
  if (action.startsWith("auth.")) return "Auth";
  const seg = action.split(/[._:]/)[0];
  return GROUP_BY_SEGMENT[seg] ?? (seg ? seg.charAt(0).toUpperCase() + seg.slice(1) : "Other");
}
