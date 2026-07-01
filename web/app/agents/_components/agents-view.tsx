"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { AgentScope } from "@prisma/client";
import { enrollAgent, setAgentEnabled, createEnrollToken, requestAgentUpdate, requestAgentRestart, requestAgentUpdates, trashAgent, restoreAgent, deleteAgentForever } from "../actions";

export type AgentVM = {
  id: string;
  name: string;
  scope: AgentScope;
  clientSlug: string | null;
  clientName: string | null;
  version: string | null; // content-hash build id
  semver: string | null; // human release version (runner/VERSION), display only
  enabled: boolean;
  lastSeenAt: string | null;
  jobCount: number;
  pendingJobs: { systemKey: string; caseNumber: string | null; subject: string | null; action: string; status: string }[];
  // The agent's most-recent in-flight job phase + when its progress last moved. When the agent goes
  // offline while these are stale, it's wedged mid-job → a "stuck on <phase>" badge (vs merely idle).
  activePhase: string | null;
  activeSinceIso: string | null;
  updateRequested: boolean;
  updateRequestedAt: string | null;
  updateRequestedBy: string | null;
  restartRequested: boolean;
  updateDeliveredAt: string | null;
};

// Live self-update status from the lifecycle timestamps: queued (set, not yet polled) -> updating
// (agent received it, pulling+restarting) -> updated (agent's heartbeat came back after delivery).
// Returns null once nothing is in flight (or the delivery is >5 min stale).
// A single copy-paste install for an EXISTING agent: download the runner from the app + run it with
// this agent's id. Cross-platform (pwsh 7 on Windows/macOS/Linux). Central runners also install the
// cloud modules. No re-enroll, no manual file fiddling.
function installCommand(a: AgentVM, origin: string): string {
  const lines = [
    `$App="${origin}"; $Dir="$HOME/iam-runner"; $H=@{'ngrok-skip-browser-warning'='true'}`,
    // TRUE fresh install. Get-CtgBuildId hashes EVERY file in the folder, so a leftover from a prior
    // install makes the build id differ from the app's forever ("update available" that never
    // converges). 1) stop EVERY running runner instance, 2) wait for file handles to release,
    // 3) wipe the folder (retry once — a just-killed process can briefly hold a lock).
    `if ($IsWindows) { Get-CimInstance Win32_Process -EA SilentlyContinue | Where-Object { $_.Name -eq 'pwsh.exe' -and $_.CommandLine -like '*Start-IamRunner*' } | ForEach-Object { Write-Host "stopping old runner pid $($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue } }`,
    `Start-Sleep -Seconds 2`,
    `if (Test-Path $Dir) { try { Remove-Item $Dir -Recurse -Force -ErrorAction Stop } catch { Start-Sleep -Seconds 2; Remove-Item $Dir -Recurse -Force -ErrorAction SilentlyContinue } }`,
    `if (Test-Path $Dir) { Write-Warning "could not fully remove $Dir — close any process using it and re-run" } else { Write-Host "wiped $Dir — clean install" -ForegroundColor Green }`,
  ];
  if (a.scope === "central") {
    // Just the Graph submodules the M365 executor needs — far faster than the Microsoft.Graph meta-module.
    lines.push(`Install-Module Microsoft.Graph.Authentication,Microsoft.Graph.Users,Microsoft.Graph.Users.Actions,Microsoft.Graph.Groups,Microsoft.Graph.Identity.DirectoryManagement -Scope CurrentUser -Force -ErrorAction SilentlyContinue   # Graph submodules`);
    // EXO must be PINNED to 3.9.2 — 3.10.0's REST cmdlets break on PowerShell 7.6, and the runner
    // imports -RequiredVersion 3.9.2, so an unpinned install (-> 3.10.0) leaves the Exchange module unloaded.
    lines.push(`Install-Module ExchangeOnlineManagement -RequiredVersion 3.9.2 -Scope CurrentUser -Force -AllowClobber -ErrorAction SilentlyContinue   # EXO pinned (3.10.0 breaks on PS 7.6) — for distribution-list adds`);
  }
  lines.push(
    `New-Item -ItemType Directory -Force $Dir | Out-Null`,
    `(Invoke-RestMethod "$App/api/runner/manifest" -Headers $H).files | ForEach-Object { $d=Join-Path $Dir $_; New-Item -ItemType Directory -Force (Split-Path $d) | Out-Null; [IO.File]::WriteAllText($d,(Invoke-WebRequest "$App/api/runner/file?path=$([uri]::EscapeDataString($_))" -UseBasicParsing -Headers $H).Content) }`,
    `& "$Dir/Start-IamRunner.ps1" -AppUrl "$App" -AgentId "${a.id}"`,
  );
  return lines.join("\n");
}

function updateStatus(a: AgentVM): { label: string; color: string } | null {
  const by = a.updateRequestedBy ? ` (by ${a.updateRequestedBy})` : "";
  if (a.updateRequested) return { label: `↻ update queued${by} — waiting for the runner to poll…`, color: "#8a6d00" };
  if (a.updateDeliveredAt) {
    const del = new Date(a.updateDeliveredAt).getTime();
    if (Date.now() - del > 5 * 60_000) return null;
    const seen = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
    if (seen > del + 3000) return { label: `✓ updated${by} — runner back online on new code`, color: "#2e7d32" };
    return { label: `↻ updating${by} — pulling files + restarting…`, color: "#1565c0" };
  }
  return null;
}

export type TrashedAgentVM = {
  id: string;
  name: string;
  scope: AgentScope;
  clientName: string | null;
  deletedAt: string;
  daysLeft: number;
};

// `now` is passed in (NOT read from Date.now() during render) so the SSR markup and the first client
// render agree — otherwise the seconds tick between server render and hydration and React throws a
// "text content does not match" hydration error. After mount the component ticks `now` itself.
// "Stuck" = offline (no heartbeat/progress) while a job is still in flight, and the last progress
// moved more than STUCK_MS ago → the runner is wedged mid-job (vs merely idle/down). The A1 watchdog
// restarts it at the stall timeout; this surfaces the window before that, and flags on-prem agents
// that aren't watchdog-supervised. Returns the badge text, or null when not stuck.
const STUCK_MS = 3 * 60_000;
function stuckLabel(a: AgentVM, online: boolean, now: number): string | null {
  if (online || !a.activeSinceIso) return null;
  const ageMs = now - new Date(a.activeSinceIso).getTime();
  if (ageMs < STUCK_MS) return null;
  const where = a.activePhase ? ` on “${a.activePhase}”` : "";
  return `⚠ stuck${where} (${Math.round(ageMs / 60_000)}m)`;
}

function lastSeen(iso: string | null, now: number): { text: string; online: boolean } {
  if (!iso) return { text: "never", online: false };
  const secs = Math.round((now - new Date(iso).getTime()) / 1000);
  const online = secs < 90;
  if (secs < 0) return { text: "just now", online: true };
  if (secs < 60) return { text: `${secs}s ago`, online };
  if (secs < 3600) return { text: `${Math.round(secs / 60)}m ago`, online };
  if (secs < 86400) return { text: `${Math.round(secs / 3600)}h ago`, online };
  return { text: new Date(iso).toISOString().slice(0, 10), online }; // deterministic (UTC) — locale-free
}

export function AgentsView({ agents, clients, trashed, currentBuild, currentVersion, now }: { agents: AgentVM[]; clients: { slug: string; name: string }[]; trashed: TrashedAgentVM[]; currentBuild: string; currentVersion: string | null; now: number }) {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const [scope, setScope] = useState<AgentScope>("central");
  const [busy, setBusy] = useState(false);
  // Start from the server's `now` (so hydration matches), then tick every second to keep "Xs ago" live.
  const [nowMs, setNowMs] = useState(now);
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; scope: string } | null>(null);
  const [install, setInstall] = useState<{ command: string } | null>(null);
  const [clientSlug, setClientSlug] = useState("");
  const [toggling, setToggling] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [jobsHover, setJobsHover] = useState<string | null>(null);
  const [installAgent, setInstallAgent] = useState<AgentVM | null>(null);
  const installRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (installAgent) installRef.current?.showModal(); else installRef.current?.close(); }, [installAgent]);

  // Arrived from the global "Update all" banner: the updates were just queued elsewhere, so the data
  // we navigated in with can be stale (the client router cache). Force one server refetch so the
  // freshly-queued state shows (the bulk button greys out, rows flip to "queued") instead of looking
  // like nothing happened. Strip the flag without a navigation so a later manual refresh won't re-run.
  const searchParams = useSearchParams();
  useEffect(() => {
    if (searchParams.get("updating") === "1") {
      router.refresh();
      window.history.replaceState(null, "", "/agents");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While any agent's self-update is in flight, poll so the status advances live (queued ->
  // updating -> updated) without a manual refresh. Stops once nothing is in flight. A queued
  // request only counts as in-flight for 10 minutes — an offline agent never consumes its
  // updateRequested flag, and without the cap one dead agent would keep every open /agents tab
  // refreshing (full force-dynamic re-render) every 4s forever.
  useEffect(() => {
    const fresh = (iso: string | null, ms: number) => !!iso && Date.now() - new Date(iso).getTime() < ms;
    const inFlight = agents.some(
      (a) => (a.updateRequested && fresh(a.updateRequestedAt, 10 * 60_000)) || fresh(a.updateDeliveredAt, 5 * 60_000)
    );
    if (!inFlight) return;
    const t = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(t);
  }, [agents, router]);

  const origin = typeof window !== "undefined" ? window.location.origin : "<APP_URL>";

  function open() {
    setError(null);
    setCreated(null);
    setInstall(null);
    setScope("central");
    setClientSlug("");
    ref.current?.showModal();
  }

  // Generate the one-line installer (mints a scoped enroll token; the host auto-enrolls + installs).
  async function genInstall(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await createEnrollToken({ scope, clientSlug: scope === "client_network" ? clientSlug : null });
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    // -Headers skips ngrok-free's browser-warning interstitial (harmless on LAN/Cloudflare).
    setInstall({ command: `irm -Headers @{'ngrok-skip-browser-warning'='1'} "${origin}/api/runner/install.ps1?token=${res.token}" | iex` });
  }

  // Manual enroll (e.g. a Mac smoke test) — creates the agent now and shows its id + start command.
  async function enrollManual(name: string) {
    setBusy(true);
    setError(null);
    const res = await enrollAgent({ name: name || `runner-${scope}`, scope, clientSlug: scope === "client_network" ? clientSlug : null });
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    setCreated({ id: res.id, scope: res.scope });
    router.refresh();
  }

  async function toggle(id: string, enabled: boolean) {
    setToggling(id);
    await setAgentEnabled(id, enabled);
    setToggling(null);
    router.refresh();
  }

  async function run(id: string, fn: (id: string) => Promise<{ ok: boolean; error?: string }>) {
    setToggling(id); setError(null);
    const res = await fn(id);
    setToggling(null);
    if (!res.ok) setError(res.error ?? "failed");
    router.refresh();
  }

  // An agent can take an update when it's enabled, doesn't already have one queued, and isn't
  // already on the build the app serves (pre-build runners count as updatable).
  const isUpToDate = (a: AgentVM) => !!a.version && /^[0-9a-f]{6,}$/.test(a.version) && a.version === currentBuild;
  const updatable = (a: AgentVM) => a.enabled && !a.updateRequested && !isUpToDate(a);
  const updatableAgents = agents.filter(updatable);
  const queuedCount = agents.filter((a) => a.enabled && a.updateRequested).length;
  const selectedUpdatable = updatableAgents.filter((a) => selected.has(a.id));

  // Prune ids that are no longer updatable whenever fresh props arrive (the 4s poll, a bulk
  // queue, a deploy changing currentBuild). Without this, an agent that updated while selected
  // stays checked-but-disabled (a disabled checkbox can't fire onChange to uncheck) and would
  // silently re-enter the selection the next time it becomes updatable.
  useEffect(() => {
    setSelected((s) => {
      if (s.size === 0) return s;
      const valid = new Set(agents.filter(updatable).map((a) => a.id));
      const next = new Set([...s].filter((id) => valid.has(id)));
      return next.size === s.size ? s : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, currentBuild]);

  function toggleSelect(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function bulkUpdate(ids: string[]) {
    if (ids.length === 0) return;
    setBulkBusy(true); setError(null);
    const res = await requestAgentUpdates(ids);
    setBulkBusy(false);
    if (!res.ok) setError(res.error ?? "failed");
    // No manual selection clear: the prune effect drops the successfully-queued ids on refresh,
    // leaving exactly the failed ones selected so the operator can see and retry them.
    router.refresh();
  }

  return (
    <>
      <div className="toolbar" style={{ marginBottom: "1rem" }}>
        {selectedUpdatable.length > 0 && (
          <button onClick={() => bulkUpdate(selectedUpdatable.map((a) => a.id))} disabled={bulkBusy}
            title="Queue a self-update for the selected runners">
            {bulkBusy ? "Queuing…" : `Update selected (${selectedUpdatable.length})`}
          </button>
        )}
        <button onClick={() => bulkUpdate(updatableAgents.map((a) => a.id))} disabled={bulkBusy || updatableAgents.length === 0}
          title={
            updatableAgents.length > 0
              ? `Queue a self-update for every enabled runner that isn't on the current build (${updatableAgents.length})`
              : queuedCount > 0
                ? `${queuedCount} update${queuedCount > 1 ? "s" : ""} already queued — waiting for the runner${queuedCount > 1 ? "s" : ""} to poll`
                : "All enabled runners are up to date"
          }>
          {bulkBusy ? "Queuing…" : "Update all"}
        </button>
        <span className="grow" />
        <button className="primary" onClick={open}>Add runner</button>
      </div>

      <details style={{ margin: "0 0 1rem", fontSize: 13 }}>
        <summary style={{ cursor: "pointer", color: "var(--muted)" }}>Runner maintenance &amp; troubleshooting (restart, Exchange Online module)</summary>
        <div style={{ padding: "0.5rem 0.2rem", lineHeight: 1.7 }}>
          <p style={{ margin: "0 0 0.4rem" }}><b>Updating &amp; restarting:</b> click <b>Update</b> on a runner — it re-pulls the latest code <i>and restarts the process automatically</i>. You do <b>not</b> need to restart it yourself. Use a manual restart only if you can&rsquo;t use Update.</p>
          <p style={{ margin: "0 0 0.2rem" }}><b>Manual restart</b> (the runner usually lives at <code>~/iam-runner/</code>):</p>
          <pre style={{ background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 6, padding: "0.4rem 0.6rem", whiteSpace: "pre-wrap" }}>{`pkill -f Start-IamRunner.ps1
nohup ~/.local/pwsh/pwsh -NoProfile -ExecutionPolicy Bypass -File ~/iam-runner/Start-IamRunner.ps1 \\
  -AppUrl <app-url> -AgentId <this-agent-id> -PollSeconds 15 -BatchSize 5 >> ~/iam-runner/runner.log 2>&1 &`}</pre>
          <p style={{ margin: "0.4rem 0 0.2rem" }}><b>Keep-alive supervisor</b> (optional — for a box with no service manager, or as a backstop): a small script that restarts this runner if it exits <i>or</i> wedges (heartbeat goes stale). Run it on a schedule with <code>-Once</code> so the OS scheduler keeps the supervisor itself alive — e.g. a cron line every minute:</p>
          <pre style={{ background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 6, padding: "0.4rem 0.6rem", whiteSpace: "pre-wrap" }}>{`* * * * * ~/.local/pwsh/pwsh -NoProfile -File ~/iam-runner/Keep-IamRunnerAlive.ps1 \\
  -AppUrl <app-url> -AgentId <this-agent-id> -Once >> ~/iam-runner/keepalive.log 2>&1`}</pre>
          <p style={{ margin: "0.2rem 0" }}>Or run it continuously (drop <code>-Once</code>): <code>nohup … Keep-IamRunnerAlive.ps1 -AppUrl &lt;app-url&gt; -AgentId &lt;id&gt; &amp;</code>. On macOS/Linux, <code>install-launchd.sh</code> already keeps the runner up via launchd — this is for hosts without that.</p>
          <p style={{ margin: "0.4rem 0 0.2rem" }}><b>Exchange Online module</b> (needed for distribution-list adds; pinned to 3.9.2 — 3.10.0 breaks on PS 7.6). The installer above includes it; to (re)install on a macOS/Linux central runner, then Update/restart:</p>
          <pre style={{ background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 6, padding: "0.4rem 0.6rem", whiteSpace: "pre-wrap" }}>{`~/.local/pwsh/pwsh -NoProfile -Command "Set-PSRepository PSGallery -InstallationPolicy Trusted; Install-Module ExchangeOnlineManagement -RequiredVersion 3.9.2 -Scope CurrentUser -Force -AllowClobber"`}</pre>
        </div>
      </details>

      <table>
        <thead>
          <tr>
            <th style={{ width: 28 }}>
              <input
                type="checkbox"
                title="Select all runners that can take an update"
                checked={updatableAgents.length > 0 && selectedUpdatable.length === updatableAgents.length}
                disabled={updatableAgents.length === 0}
                onChange={(e) => setSelected(e.target.checked ? new Set(updatableAgents.map((a) => a.id)) : new Set())}
              />
            </th>
            <th>Name</th><th>Scope</th><th>Client</th><th>Version</th><th>Last seen</th><th>Jobs</th><th>Status</th><th></th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => {
            const ls = lastSeen(a.lastSeenAt, nowMs);
            // Up to date = it reports a build hash that matches what the app serves. Only offer
            // Update when there's actually something to apply (or it's mid-update).
            const upToDate = isUpToDate(a);
            return (
              <tr key={a.id}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.has(a.id)}
                    disabled={!updatable(a)}
                    title={updatable(a) ? "Select for bulk update" : !a.enabled ? "Disabled — enable it first" : a.updateRequested ? "Update already queued" : "Already up to date"}
                    onChange={() => toggleSelect(a.id)}
                  />
                </td>
                <td><div>{a.name}</div><code className="muted" style={{ fontSize: 11 }}>{a.id}</code></td>
                <td><span className="badge">{a.scope === "central" ? "central" : "client-network"}</span></td>
                <td>{a.clientName ?? <span className="muted">— all —</span>}</td>
                <td>
                  {(() => {
                    const v = a.version;
                    const isBuild = !!v && /^[0-9a-f]{6,}$/.test(v); // a build hash vs legacy "0.1.0"/"unknown"
                    // Human release version (e.g. "v1.0.0"), shown above the build hash when reported.
                    // Goes amber if it differs from the app's current VERSION (a release the runner
                    // hasn't pulled yet) — the hash below is still the authoritative up-to-date check.
                    const semverLine = a.semver
                      ? <div style={{ fontWeight: 600, color: currentVersion && a.semver !== currentVersion ? "#8a6d00" : undefined }}>v{a.semver}</div>
                      : null;
                    if (isBuild) {
                      return (
                        <>
                          {semverLine}
                          <code className="muted" style={{ fontSize: 11 }}>build {v.slice(0, 7)}</code>
                          {v === currentBuild
                            ? <div className="note" style={{ color: "#2e7d32" }}>✓ up to date</div>
                            : <div className="note" style={{ color: "#8a6d00" }}>⚠ update available</div>}
                        </>
                      );
                    }
                    return (
                      <>
                        <span className="muted">{v ?? "—"}</span>
                        {a.enabled && <div className="note" style={{ color: "#8a6d00" }}>⚠ pre-build runner — Update to report its build</div>}
                      </>
                    );
                  })()}
                </td>
                <td>
                  <span style={{ color: ls.online ? "#2e7d32" : undefined }}>{ls.online ? "● " : ""}{ls.text}</span>
                  {(() => {
                    const s = stuckLabel(a, ls.online, nowMs);
                    return s ? <div className="note" style={{ color: "#b3261e" }} title="No job progress for several minutes — the runner is wedged on a step. The watchdog restarts it at the stall timeout.">{s}</div> : null;
                  })()}
                </td>
                <td
                  style={{ position: "relative", cursor: a.pendingJobs.length ? "help" : undefined }}
                  onMouseEnter={() => setJobsHover(a.id)}
                  onMouseLeave={() => setJobsHover((h) => (h === a.id ? null : h))}
                >
                  <span style={{ textDecoration: a.pendingJobs.length ? "underline dotted" : undefined, textUnderlineOffset: 3 }}>{a.jobCount}</span>
                  {a.pendingJobs.length > 0 && <span className="muted" style={{ marginLeft: 4, fontSize: 11 }}>· {a.pendingJobs.length} queued/active</span>}
                  {jobsHover === a.id && a.pendingJobs.length > 0 && (
                    <div style={{ position: "absolute", zIndex: 30, top: "100%", left: 0, minWidth: 320, maxHeight: 280, overflowY: "auto", background: "#fff", border: "1px solid #ccc", borderRadius: 4, boxShadow: "0 2px 10px rgba(0,0,0,0.18)", padding: 6, fontSize: 12, whiteSpace: "normal", textAlign: "left" }}>
                      <div className="note" style={{ marginBottom: 4 }}>{a.jobCount} total assigned · {a.pendingJobs.length} queued/in-flight for this runner:</div>
                      {a.pendingJobs.map((j, i) => (
                        <div key={i} style={{ padding: "2px 0", borderTop: i ? "1px solid #f0f0f0" : undefined, display: "flex", gap: 6, justifyContent: "space-between" }}>
                          <span><code style={{ fontSize: 11 }}>{j.caseNumber ?? "—"}</code> <span className="muted">· {j.systemKey} · {j.subject ?? "—"}</span></span>
                          <span style={{ color: j.status === "pending" ? "#8a6d00" : "#1565c0", whiteSpace: "nowrap" }}>{j.status}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </td>
                <td>
                  {a.enabled ? "enabled" : <span className="muted">disabled</span>}
                  {(() => { const u = updateStatus(a); return u ? <div className="note" style={{ color: u.color, marginTop: 2 }}>{u.label}</div> : null; })()}
                </td>
                <td>
                  {/* 2-column grid so the per-runner actions stack 2×2 instead of a long row. */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, minWidth: 172 }}>
                    <button onClick={() => setInstallAgent(a)} title="Get the one-line install/run command for this runner">Install</button>
                    <button onClick={() => toggle(a.id, !a.enabled)} disabled={toggling === a.id}>{a.enabled ? "Disable" : "Enable"}</button>
                    {a.enabled && !upToDate && (
                      <button onClick={() => run(a.id, requestAgentUpdate)} disabled={toggling === a.id || a.updateRequested} title="Pull the latest runner code and restart on the next heartbeat (~poll interval)">
                        {toggling === a.id ? "Requesting…" : a.updateRequested ? "Queued…" : "Update"}
                      </button>
                    )}
                    {a.enabled && (
                      <button onClick={() => run(a.id, requestAgentRestart)} disabled={toggling === a.id || a.restartRequested} title="Restart this runner on its next heartbeat (re-exec, no code pull) — for a runner that heartbeats but stops claiming. Needs a supervised runner.">
                        {toggling === a.id ? "…" : a.restartRequested ? "Restarting…" : "Restart"}
                      </button>
                    )}
                    {!a.enabled && (
                      <button onClick={() => run(a.id, trashAgent)} disabled={toggling === a.id} title="Move to trash (restorable for 30 days)">Trash</button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
          {agents.length === 0 && (
            <tr><td colSpan={9} className="muted" style={{ textAlign: "center" }}>No agents yet. Enroll one to start a runner.</td></tr>
          )}
        </tbody>
      </table>
      {error && <p className="note danger">{error}</p>}

      {trashed.length > 0 && (
        <details style={{ marginTop: "1.25rem" }}>
          <summary style={{ cursor: "pointer" }}><b>Trash</b> <span className="note">({trashed.length}) — restorable for 30 days, then permanently deleted</span></summary>
          <table style={{ marginTop: "0.5rem" }}>
            <thead><tr><th>Name</th><th>Scope</th><th>Client</th><th>Trashed</th><th>Auto-delete in</th><th></th></tr></thead>
            <tbody>
              {trashed.map((a) => (
                <tr key={a.id}>
                  <td><div>{a.name}</div><code className="muted" style={{ fontSize: 11 }}>{a.id}</code></td>
                  <td><span className="badge">{a.scope === "central" ? "central" : "client-network"}</span></td>
                  <td>{a.clientName ?? <span className="muted">— all —</span>}</td>
                  <td className="muted">{new Date(a.deletedAt).toLocaleDateString()}</td>
                  <td style={{ color: a.daysLeft <= 3 ? "#b3261e" : undefined }}>{a.daysLeft} day{a.daysLeft === 1 ? "" : "s"}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button onClick={() => run(a.id, restoreAgent)} disabled={toggling === a.id}>Restore</button>
                    <button onClick={() => { if (confirm(`Permanently delete runner "${a.name}"? This can't be undone.`)) run(a.id, deleteAgentForever); }} disabled={toggling === a.id} style={{ marginLeft: 6, color: "#b3261e" }}>Delete forever</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      <dialog ref={ref} style={{ maxWidth: 620 }}>
        {install ? (
          <div>
            <h2>Install the runner</h2>
            <p className="note">On the target host, open an <b>elevated PowerShell</b> and paste this. It installs the modules, downloads the runner, auto-enrolls, and registers a Scheduled Task that starts on boot.</p>
            <textarea readOnly rows={3} style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }}
              value={install.command} onFocus={(e) => e.currentTarget.select()} />
            <div className="toolbar" style={{ marginTop: "0.5rem" }}>
              <button onClick={() => navigator.clipboard?.writeText(install.command)}>Copy command</button>
              <span className="grow" />
              <button className="primary" onClick={() => ref.current?.close()}>Done</button>
            </div>
            <p className="note" style={{ marginTop: "0.75rem", color: "var(--muted)" }}>
              Link is valid for 1 hour. The runner appears Online here within ~30s of finishing.
              {" "}AD/Exchange jobs need a Windows host on the client network; a Mac can run the loop for a connectivity test (enroll manually below).
            </p>
          </div>
        ) : created ? (
          (() => {
            const H = "@{'ngrok-skip-browser-warning'='1'}";
            const manual = `# Run the runner manually (no scheduled task) — e.g. on a DC or for a quick test.
# Run these in an ELEVATED PowerShell on the runner host.

# 1. PowerShell 7 — skip if 'pwsh' already works. Works on Windows Server (no winget needed);
#    after it installs, open a NEW elevated PowerShell window so 'pwsh' is on PATH.
iex "& { $(irm https://aka.ms/install-powershell.ps1) } -UseMSI -Quiet"

# 2. Download the runner to C:\\iam-runner
$App = "${origin}"
$Dir = "C:\\iam-runner"; New-Item -ItemType Directory -Force $Dir | Out-Null
(irm "$App/api/runner/manifest" -Headers ${H}).files | ForEach-Object {
  $d = Join-Path $Dir ($_ -replace '/','\\'); New-Item -ItemType Directory -Force (Split-Path $d) | Out-Null
  (iwr "$App/api/runner/file?path=$([uri]::EscapeDataString($_))" -UseBasicParsing -Headers ${H}).Content | Set-Content -LiteralPath $d
}

# 3. Run it (foreground; Ctrl-C to stop)
pwsh C:\\iam-runner\\Start-IamRunner.ps1 -AppUrl "${origin}" -AgentId "${created.id}"`;
            return (
              <div>
                <h2>Agent enrolled — run it manually</h2>
                <p className="note">Agent id <code>{created.id}</code>. Paste the whole block into an <b>elevated PowerShell</b> on the runner host. No scheduled task — it runs in the window until you Ctrl-C.</p>
                <textarea readOnly rows={14} style={{ width: "100%", fontFamily: "monospace", fontSize: 11 }} value={manual} onFocus={(e) => e.currentTarget.select()} />
                <p className="note" style={{ marginTop: "0.4rem", color: "var(--muted)" }}>On a DC the ActiveDirectory module is already present; for the full chain a host also needs ExchangeOnlineManagement + Microsoft.Graph. AD/Exchange use the brokered secrets, so the host needs no special rights.</p>
                <div className="toolbar" style={{ marginTop: "0.5rem" }}>
                  <button onClick={() => navigator.clipboard?.writeText(manual)}>Copy</button>
                  <span className="grow" />
                  <button className="primary" onClick={() => ref.current?.close()}>Done</button>
                </div>
              </div>
            );
          })()
        ) : (
          <form onSubmit={genInstall}>
            <h2>Add a runner</h2>
            <p className="note">A central runner executes cloud jobs for all clients. A client-network runner runs inside one client&apos;s network and only sees that client&apos;s jobs.</p>

            <label htmlFor="scope">Scope</label>
            <select id="scope" value={scope} onChange={(e) => setScope(e.target.value as AgentScope)}>
              <option value="central">central (all clients, cloud)</option>
              <option value="client_network">client-network (one client)</option>
            </select>

            {scope === "client_network" && (
              <>
                <label htmlFor="clientSlug">Client</label>
                <input id="clientSlug" value={clientSlug} onChange={(e) => setClientSlug(e.target.value)} list="agent-client-options" placeholder="client slug" required />
                <datalist id="agent-client-options">
                  {clients.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
                </datalist>
              </>
            )}

            {error && <p className="note" style={{ color: "#9a3a3a" }}>{error}</p>}

            <div className="toolbar" style={{ marginTop: "1rem", justifyContent: "flex-end" }}>
              <button type="button" onClick={() => ref.current?.close()} disabled={busy}>Cancel</button>
              <button type="button" onClick={() => enrollManual(`runner-${scope === "client_network" ? clientSlug || "client" : "central"}`)} disabled={busy}>Enroll manually</button>
              <button type="submit" className="primary" disabled={busy}>{busy ? "Generating…" : "Generate install command"}</button>
            </div>
          </form>
        )}
      </dialog>

      {/* Per-agent install: one copy-paste to download + run THIS runner on a host. */}
      <dialog ref={installRef} onClose={() => setInstallAgent(null)} style={{ maxWidth: 680 }}>
        {installAgent && (
          <div>
            <div className="row-between">
              <h2>Install runner: {installAgent.name}</h2>
              <button onClick={() => setInstallAgent(null)} aria-label="Close">×</button>
            </div>
            <p className="note">
              Run this in a <b>PowerShell 7 (pwsh)</b> session on the host that should run this{" "}
              {installAgent.scope === "central" ? "central (cloud) runner" : "client-network runner"}. It downloads the
              runner and starts it with this agent&apos;s id — no re-enroll.
              {installAgent.scope === "central" && " The cloud modules (Graph, Exchange) install on first run (can take a few minutes)."}
            </p>
            <textarea readOnly rows={installAgent.scope === "central" ? 6 : 5} style={{ width: "100%", fontFamily: "monospace", fontSize: 11 }}
              value={installCommand(installAgent, origin)} onFocus={(e) => e.currentTarget.select()} />
            <p className="note" style={{ color: "var(--muted)" }}>
              On macOS, start pwsh first with <code>~/.local/pwsh/pwsh</code> (or your pwsh path), then paste. It runs in
              the foreground; the runner appears <b>Online</b> here within ~30s. For an unattended Windows service, use{" "}
              <b>Add runner</b> instead (it registers a Scheduled Task).
            </p>
            <div className="toolbar" style={{ marginTop: "0.5rem" }}>
              <button onClick={() => navigator.clipboard?.writeText(installCommand(installAgent, origin))}>Copy command</button>
              <span className="grow" />
              <button className="primary" onClick={() => setInstallAgent(null)}>Done</button>
            </div>
          </div>
        )}
      </dialog>
    </>
  );
}
