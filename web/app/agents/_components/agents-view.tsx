"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { AgentScope } from "@prisma/client";
import { ActionsMenu } from "../../_components/actions-menu";
import { enrollAgent, setAgentEnabled, createEnrollToken, requestAgentUpdate, requestAgentRestart, requestAgentMigrate, requestAgentUpdates, trashAgent, restoreAgent, deleteAgentForever, setAgentPriority, updateAgentIdentity } from "../actions";
import { CopyButton } from "@/app/_components/copy-button";

export type AgentVM = {
  id: string;
  name: string;
  scope: AgentScope;
  clientSlug: string | null;
  clientName: string | null;
  version: string | null; // content-hash build id
  semver: string | null; // human release version (runner/VERSION), display only
  // What this runner reported it can DO: on-prem systems it has modules for (active-directory,
  // directory-sync…) plus cross-cutting 'browser' when the Playwright sidecar is installed. The
  // claim gate withholds work an agent hasn't claimed the capability for, so this is load-bearing.
  capabilities: string[] | null; // null = legacy runner that never reported (treated as capable)
  priority: number; // failover rank (lower = higher precedence); a backup stands by while a higher peer is online
  enabled: boolean;
  lastSeenAt: string | null;
  bootAt: string | null;
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
  restartRequestedAt: string | null;
  restartRequestedBy: string | null;
  restartDeliveredAt: string | null;
  updateDeliveredAt: string | null;
  // App-URL migration: the base URL the agent last reported polling, plus the move lifecycle.
  currentAppUrl: string | null;
  migrateRequested: boolean;
  migrateRequestedAt: string | null;
  migrateRequestedBy: string | null;
  migrateDeliveredAt: string | null;
  migratedAt: string | null;
  migrateError: string | null;
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

// One-liner that pulls + runs the per-agent troubleshoot script (served by /api/runner/
// troubleshoot.ps1) — for a runner that enrolled but never comes online: it checks pwsh 7, the
// runner files, the Scheduled Task, RUNNER_API_TOKEN, reachability and auth, then offers a
// foreground run. -Headers skips ngrok-free's browser-warning interstitial (harmless elsewhere).
function troubleshootCommand(a: AgentVM, origin: string): string {
  return `irm -Headers @{'ngrok-skip-browser-warning'='1'} "${origin}/api/runner/troubleshoot.ps1?agent=${a.id}" | iex`;
}

function updateStatus(a: AgentVM): { label: string; color: string } | null {
  const by = a.updateRequestedBy ? ` (by ${a.updateRequestedBy})` : "";
  if (a.updateRequested) return { label: `↻ update queued${by} — waiting for the runner to poll…`, color: "var(--warn-fg)" };
  if (a.updateDeliveredAt) {
    const del = new Date(a.updateDeliveredAt).getTime();
    if (Date.now() - del > 5 * 60_000) return null;
    const seen = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
    if (seen > del + 3000) return { label: `✓ updated${by} — runner back online on new code`, color: "var(--ok-fg)" };
    return { label: `↻ updating${by} — pulling files + restarting…`, color: "var(--info-fg)" };
  }
  return null;
}

// Live restart status from the lifecycle timestamps, mirroring updateStatus: queued (set, not yet
// polled) -> restarting (the runner consumed it and is re-launching) -> restarted (its heartbeat came
// back after delivery). A plain restart pulls no code, so "back online" keys off a heartbeat that
// lands after delivery (lastSeenAt is server-stamped, so no runner-clock skew). Returns null once
// nothing is in flight (or the delivery is >5 min stale). This is what makes a restart VISIBLE on the
// row — the v2 Actions menu closes on click, so the in-menu "Restarting…" label alone is invisible.
function restartStatus(a: AgentVM): { label: string; color: string } | null {
  const by = a.restartRequestedBy ? ` (by ${a.restartRequestedBy})` : "";
  if (a.restartRequested) return { label: `↻ restart queued${by} — waiting for the runner to poll…`, color: "var(--warn-fg)" };
  if (a.restartDeliveredAt) {
    const del = new Date(a.restartDeliveredAt).getTime();
    if (Date.now() - del > 5 * 60_000) return null;
    const seen = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
    if (seen > del + 3000) return { label: `✓ restarted${by} — runner back online`, color: "var(--ok-fg)" };
    return { label: `↻ restarting${by} — re-launching…`, color: "var(--info-fg)" };
  }
  return null;
}

// Live app-URL migration status. failed (agent tried the new URL and couldn't verify/rewrite — stays
// on the old one) -> migrated (its heartbeat came back reporting the new URL) -> queued (operator asked,
// not yet polled) -> migrating (delivered, agent verifying+rewriting+relaunching). migratedAt/migrateError
// are terminal-ish so they take precedence over the in-flight labels. Returns null when nothing's afoot.
function migrateStatus(a: AgentVM): { label: string; color: string } | null {
  const by = a.migrateRequestedBy ? ` (by ${a.migrateRequestedBy})` : "";
  if (a.migrateError) return { label: `⚠ migration failed — ${a.migrateError} (still on the old URL)`, color: "var(--danger-fg, #b00)" };
  if (a.migratedAt) return { label: `✓ migrated${by} — now on ${a.currentAppUrl ?? "the new URL"}`, color: "var(--ok-fg)" };
  if (a.migrateRequested) return { label: `↻ migration queued${by} — waiting for the runner to poll…`, color: "var(--warn-fg)" };
  if (a.migrateDeliveredAt) {
    if (Date.now() - new Date(a.migrateDeliveredAt).getTime() > 5 * 60_000) return null;
    return { label: `↻ migrating${by} — verifying the new URL + rewriting the scheduled task…`, color: "var(--info-fg)" };
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

// Uptime since the runner's reported boot time (resets on restart/self-update — a new process). "—"
// when unknown (older runner not yet reporting it, or never seen).
function uptime(iso: string | null, now: number): string {
  if (!iso) return "—";
  const secs = Math.floor((now - new Date(iso).getTime()) / 1000);
  if (secs < 0) return "just started";
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
  return `${Math.floor(secs / 86400)}d ${Math.floor((secs % 86400) / 3600)}h`;
}

// Failover priority editor (LOWER = higher precedence). A backup runner stands by while a higher-priority
// peer of the same scope is online, and takes over when it goes silent; equal priority load-balances.
function PriorityControl({ a }: { a: AgentVM }) {
  const router = useRouter();
  const [val, setVal] = useState(String(a.priority));
  const [busy, setBusy] = useState(false);
  useEffect(() => { setVal(String(a.priority)); }, [a.priority]);
  async function save(v: string) {
    const n = Math.max(1, Math.min(999, Math.round(Number(v) || 100)));
    if (n === a.priority) { setVal(String(a.priority)); return; }
    setBusy(true);
    const r = await setAgentPriority(a.id, n);
    setBusy(false);
    if (r.ok) { setVal(String(r.priority)); router.refresh(); } else setVal(String(a.priority));
  }
  return (
    <label className="note" style={{ display: "inline-flex", gap: 4, alignItems: "center", fontSize: 11, whiteSpace: "nowrap" }}
      title="Failover priority — LOWER = higher precedence. A backup runner stands by while a higher-priority peer of the same scope (this client's agents, or the central runners) is online, and takes over when it goes silent. Equal priority = load-balance.">
      priority
      <input type="number" min={1} max={999} value={val} disabled={busy}
        onChange={(e) => setVal(e.target.value)}
        onBlur={(e) => save(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        style={{ width: 50 }} />
    </label>
  );
}

// What the runner reported it can DO. Load-bearing, not decoration: the claim gate withholds work an
// agent hasn't claimed the capability for — so a missing 'browser' chip is exactly why a Spanning
// force-sync never dispatches, and a missing 'active-directory' chip is why AD jobs sit unclaimed.
const CAP_LABEL: Record<string, string> = {
  browser: "browser",
  "active-directory": "AD",
  "directory-sync": "dir-sync",
};
function CapabilityChips({ a }: { a: AgentVM }) {
  if (!a.lastSeenAt) return <span className="note muted" style={{ fontSize: 11 }}>— not reported yet</span>;
  // null = a pre-1.31 runner that doesn't report capabilities at all. The claim gate treats it as
  // capable (old behaviour), so say so rather than implying it can do nothing.
  if (a.capabilities === null) return <span className="note muted" style={{ fontSize: 11 }}>legacy runner (no capability report)</span>;
  if (a.capabilities.length === 0) return <span className="note muted" style={{ fontSize: 11 }}>cloud only</span>;
  return (
    <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
      {a.capabilities.map((c) => (
        <span key={c} className="badge" style={{ fontSize: 10, color: c === "browser" ? "var(--ok-fg)" : undefined }}
          title={c === "browser"
            ? "Playwright/Chromium sidecar installed — this agent can run browser jobs (e.g. Spanning force-sync)"
            : `this runner has the ${c} module loaded`}>
          {CAP_LABEL[c] ?? c}
        </span>
      ))}
    </span>
  );
}

// Version display (semver line + build hash + up-to-date/needs-update note). Shared so the v2 table
// reads the same as the classic one without inlining the branch twice.
function VersionCell({ a, currentBuild, currentVersion }: { a: AgentVM; currentBuild: string; currentVersion: string | null }) {
  const v = a.version;
  const isBuild = !!v && /^[0-9a-f]{6,}$/.test(v); // a build hash vs legacy "0.1.0"/"unknown"
  const semverLine = a.semver
    ? <div style={{ fontWeight: 600, color: currentVersion && a.semver !== currentVersion ? "var(--warn-fg)" : undefined }}>v{a.semver}</div>
    : null;
  if (isBuild) {
    return (
      <>
        {semverLine}
        <code className="muted" style={{ fontSize: 11 }}>build {v!.slice(0, 7)}</code>
        {v === currentBuild
          ? <div className="note" style={{ color: "var(--ok-fg)" }}>✓ up to date</div>
          : <div className="note" style={{ color: "var(--warn-fg)" }}>⚠ update available</div>}
        <div style={{ marginTop: 3 }}><CapabilityChips a={a} /></div>
      </>
    );
  }
  return (
    <>
      <span className="muted">{v ?? "—"}</span>
      {a.enabled && <div className="note" style={{ color: "var(--warn-fg)" }}>⚠ pre-build runner — Update to report its build; still here after an update? Troubleshoot</div>}
      <div style={{ marginTop: 3 }}><CapabilityChips a={a} /></div>
    </>
  );
}

export function AgentsView({ agents, clients, trashed, currentBuild, currentVersion, now, v2 = false }: { agents: AgentVM[]; clients: { slug: string; name: string }[]; trashed: TrashedAgentVM[]; currentBuild: string; currentVersion: string | null; now: number; v2?: boolean }) {
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
  const [install, setInstall] = useState<{ command: string; token: string } | null>(null);
  const [clientSlug, setClientSlug] = useState("");
  const [toggling, setToggling] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [installAgent, setInstallAgent] = useState<AgentVM | null>(null);
  const installRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (installAgent) installRef.current?.showModal(); else installRef.current?.close(); }, [installAgent]);

  const [troubleshootAgent, setTroubleshootAgent] = useState<AgentVM | null>(null);
  const troubleshootRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (troubleshootAgent) troubleshootRef.current?.showModal(); else troubleshootRef.current?.close(); }, [troubleshootAgent]);
  const [localRestartAgent, setLocalRestartAgent] = useState<AgentVM | null>(null);
  const localRestartRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (localRestartAgent) localRestartRef.current?.showModal(); else localRestartRef.current?.close(); }, [localRestartAgent]);

  // Edit an agent's identity: rename, and re-point a client-network agent at its client. Also the
  // recovery path for an agent row recreated after data loss — the runner keeps polling with its
  // baked-in id, so fixing the row here re-links it without touching the host.
  const [editAgent, setEditAgent] = useState<AgentVM | null>(null);
  const [editName, setEditName] = useState("");
  const [editClient, setEditClient] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const editRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (editAgent) editRef.current?.showModal(); else editRef.current?.close(); }, [editAgent]);
  function openEdit(a: AgentVM) {
    setEditName(a.name); setEditClient(a.clientSlug ?? ""); setEditError(null); setEditAgent(a);
  }
  async function saveEdit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editAgent) return;
    setEditBusy(true); setEditError(null);
    const res = await updateAgentIdentity(editAgent.id, {
      name: editName,
      clientSlug: editAgent.scope === "client_network" ? editClient || null : null,
    });
    setEditBusy(false);
    if (!res.ok) { setEditError(res.error); return; }
    setEditAgent(null);
    router.refresh();
  }

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
      (a) =>
        (a.updateRequested && fresh(a.updateRequestedAt, 10 * 60_000)) ||
        fresh(a.updateDeliveredAt, 5 * 60_000) ||
        (a.restartRequested && fresh(a.restartRequestedAt, 10 * 60_000)) ||
        fresh(a.restartDeliveredAt, 5 * 60_000) ||
        (a.migrateRequested && fresh(a.migrateRequestedAt, 10 * 60_000)) ||
        fresh(a.migrateDeliveredAt, 5 * 60_000)
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
    // Download to a FILE, then run it — the installer re-launches itself under pwsh 7, which needs
    // a script path on disk (irm|iex can't re-exec, so modules got installed for the wrong shell).
    // Run via `powershell -ExecutionPolicy Bypass -File` so RemoteSigned + mark-of-the-web on the
    // downloaded file can't block it (irm|iex never hit execution policy; a .ps1 on disk does).
    // -Headers skips ngrok-free's browser-warning interstitial (harmless on LAN/Cloudflare).
    setInstall({ command: `$f = "$env:TEMP\\install-iam-runner.ps1"; iwr -UseBasicParsing -Headers @{'ngrok-skip-browser-warning'='1'} "${origin}/api/runner/install.ps1?token=${res.token}" -OutFile $f; powershell -NoProfile -ExecutionPolicy Bypass -File $f`, token: res.token });
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

      {!v2 && (
      <table className="desk-only">
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
            <th>Name</th><th>Scope</th><th>Client</th><th>Version</th><th>Last seen</th><th>Uptime</th><th>Status</th><th></th>
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
                      ? <div style={{ fontWeight: 600, color: currentVersion && a.semver !== currentVersion ? "var(--warn-fg)" : undefined }}>v{a.semver}</div>
                      : null;
                    if (isBuild) {
                      return (
                        <>
                          {semverLine}
                          <code className="muted" style={{ fontSize: 11 }}>build {v.slice(0, 7)}</code>
                          {v === currentBuild
                            ? <div className="note" style={{ color: "var(--ok-fg)" }}>✓ up to date</div>
                            : <div className="note" style={{ color: "var(--warn-fg)" }}>⚠ update available</div>}
                        </>
                      );
                    }
                    return (
                      <>
                        <span className="muted">{v ?? "—"}</span>
                        {/* An update only lands if the runner heartbeats; if this never clears, the
                            runner isn't reaching the app at all — point at Troubleshoot, not Update. */}
                        {a.enabled && <div className="note" style={{ color: "var(--warn-fg)" }}>⚠ pre-build runner — Update to report its build; still here after an update? Troubleshoot</div>}
                      </>
                    );
                  })()}
                </td>
                <td>
                  <span style={{ color: ls.online ? "var(--ok-fg)" : undefined }}>{ls.online ? "● " : ""}{ls.text}</span>
                  {(() => {
                    const s = stuckLabel(a, ls.online, nowMs);
                    return s ? <div className="note" style={{ color: "var(--err-fg)" }} title="No job progress for several minutes — the runner is wedged on a step. The watchdog restarts it at the stall timeout.">{s}</div> : null;
                  })()}
                </td>
                <td className="muted tnum" title={a.bootAt ? `up since ${a.bootAt}` : "uptime unknown — the runner hasn't reported a start time yet"}>
                  {a.enabled && ls.online ? uptime(a.bootAt, nowMs) : "—"}
                </td>
                <td>
                  {a.enabled ? "enabled" : <span className="muted">disabled</span>}
                  {a.currentAppUrl && <div className="note muted" style={{ marginTop: 2 }} title="the app URL this runner is polling">url: {a.currentAppUrl}</div>}
                  {(() => { const u = updateStatus(a); return u ? <div className="note" style={{ color: u.color, marginTop: 2 }}>{u.label}</div> : null; })()}
                  {(() => { const r = restartStatus(a); return r ? <div className="note" style={{ color: r.color, marginTop: 2 }}>{r.label}</div> : null; })()}
                  {(() => { const m = migrateStatus(a); return m ? <div className="note" style={{ color: m.color, marginTop: 2 }}>{m.label}</div> : null; })()}
                </td>
                <td>
                  {/* 2-column grid so the per-runner actions stack 2×2 instead of a long row. */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, minWidth: 172 }}>
                    <button onClick={() => openEdit(a)} title="Rename this runner or point it at a different client">Edit</button>
                    <button onClick={() => setInstallAgent(a)} title="Get the one-line install/run command for this runner">Install</button>
                    <button onClick={() => toggle(a.id, !a.enabled)} disabled={toggling === a.id}>{a.enabled ? "Disable" : "Enable"}</button>
                    <button onClick={() => setTroubleshootAgent(a)} title="Get a diagnostic command for a runner that never comes online (pre-build / update stuck on queued)">Troubleshoot</button>
                    <button onClick={() => setLocalRestartAgent(a)} title="Get the command to restart this runner ON the device itself — when you can't use the app's Restart">Local Restart</button>
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
                    {a.enabled && !a.migratedAt && (
                      <button onClick={() => run(a.id, requestAgentMigrate)} disabled={toggling === a.id || a.migrateRequested} title="Move this runner to the new app URL (set the target in Settings first). It verifies the new URL, rewrites its own scheduled task, and switches — the old URL is removed once it reports in.">
                        {toggling === a.id ? "…" : a.migrateRequested ? "Migrating…" : "Migrate"}
                      </button>
                    )}
                    {!a.enabled && (
                      <button onClick={() => run(a.id, trashAgent)} disabled={toggling === a.id} title="Move to trash (restorable for 30 days)">Trash</button>
                    )}
                  </div>
                  <div style={{ marginTop: 4 }}><PriorityControl a={a} /></div>
                </td>
              </tr>
            );
          })}
          {agents.length === 0 && (
            <tr><td colSpan={9} className="muted" style={{ textAlign: "center" }}>No agents yet. Enroll one to start a runner.</td></tr>
          )}
        </tbody>
      </table>
      )}

      {/* v2: fewer, denser columns. Identity (name · scope · client · id · priority) in one cell,
          version, activity (last seen · uptime · status), and every action behind one Actions ▾ menu. */}
      {v2 && (
      <table className="desk-only agents-v2">
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
            <th>Runner</th><th>Version</th><th>Activity</th><th style={{ textAlign: "right" }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => {
            const ls = lastSeen(a.lastSeenAt, nowMs);
            const upToDate = isUpToDate(a);
            const u = updateStatus(a);
            const r = restartStatus(a);
            const m = migrateStatus(a);
            const stuck = stuckLabel(a, ls.online, nowMs);
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
                <td>
                  <div style={{ fontWeight: 600 }}>{a.name}</div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 2 }}>
                    <span className="badge">{a.scope === "central" ? "central" : "client-network"}</span>
                    {a.clientName
                      ? <span className="muted" style={{ fontSize: 12 }}>{a.clientName}</span>
                      : <span className="muted" style={{ fontSize: 12 }}>— all —</span>}
                  </div>
                  <code className="muted" style={{ fontSize: 11, display: "block", marginTop: 2 }}>{a.id}</code>
                  <div style={{ marginTop: 4 }}><PriorityControl a={a} /></div>
                </td>
                <td><VersionCell a={a} currentBuild={currentBuild} currentVersion={currentVersion} /></td>
                <td>
                  <div>
                    <span style={{ color: ls.online ? "var(--ok-fg)" : undefined }}>{ls.online ? "● " : ""}{ls.text}</span>
                    {a.enabled ? null : <span className="muted"> · disabled</span>}
                  </div>
                  {a.enabled && ls.online && (
                    <div className="note muted" title={a.bootAt ? `up since ${a.bootAt}` : "uptime unknown"}>up {uptime(a.bootAt, nowMs)}</div>
                  )}
                  {stuck && <div className="note" style={{ color: "var(--err-fg)" }} title="No job progress for several minutes — the runner is wedged on a step. The watchdog restarts it at the stall timeout.">{stuck}</div>}
                  {a.currentAppUrl && <div className="note muted" style={{ marginTop: 2 }} title="the app URL this runner is polling">url: {a.currentAppUrl}</div>}
                  {u && <div className="note" style={{ color: u.color, marginTop: 2 }}>{u.label}</div>}
                  {r && <div className="note" style={{ color: r.color, marginTop: 2 }}>{r.label}</div>}
                  {m && <div className="note" style={{ color: m.color, marginTop: 2 }}>{m.label}</div>}
                </td>
                <td style={{ textAlign: "right" }}>
                  {/* Every per-agent action behind one shared "Actions ▾" menu (the classic view
                      shows every button inline). */}
                  <ActionsMenu items={[
                    { label: "Edit", onClick: () => openEdit(a) },
                    { label: "Install", onClick: () => setInstallAgent(a) },
                    { label: a.enabled ? "Disable" : "Enable", disabled: toggling === a.id, onClick: () => toggle(a.id, !a.enabled) },
                    { label: "Troubleshoot", onClick: () => setTroubleshootAgent(a) },
                    { label: "Local restart", onClick: () => setLocalRestartAgent(a) },
                    ...(a.enabled && !upToDate
                      ? [{ label: a.updateRequested ? "Queued…" : "Update", disabled: toggling === a.id || a.updateRequested, onClick: () => run(a.id, requestAgentUpdate) }]
                      : []),
                    ...(a.enabled
                      ? [{ label: a.restartRequested ? "Restarting…" : "Restart", disabled: toggling === a.id || a.restartRequested, onClick: () => run(a.id, requestAgentRestart) }]
                      : []),
                    ...(a.enabled && !a.migratedAt
                      ? [{ label: a.migrateRequested ? "Migrating…" : "Migrate to new URL", disabled: toggling === a.id || a.migrateRequested, onClick: () => run(a.id, requestAgentMigrate) }]
                      : []),
                    ...(!a.enabled
                      ? [{ label: "Trash", danger: true, onClick: () => run(a.id, trashAgent) }]
                      : []),
                  ]} />
                </td>
              </tr>
            );
          })}
          {agents.length === 0 && (
            <tr><td colSpan={5} className="muted" style={{ textAlign: "center" }}>No agents yet. Enroll one to start a runner.</td></tr>
          )}
        </tbody>
      </table>
      )}

      {/* Mobile: status-focused card per agent (online/version/last-seen/uptime). Enroll + per-agent
          actions stay on desktop. */}
      <div className="mob-only m-list">
        {agents.map((a) => {
          const ls = lastSeen(a.lastSeenAt, nowMs);
          return (
            <div key={a.id} className="m-card" style={{ opacity: a.enabled ? 1 : 0.6 }}>
              <div className="m-card-top">
                <span className="m-card-title">{a.name}</span>
                <span className="badge" style={{ color: ls.online ? "var(--ok-fg)" : "var(--muted)", background: ls.online ? "var(--ok-bg)" : "var(--neutral-bg)" }}>{ls.online ? "● online" : "○ offline"}</span>
              </div>
              <div className="m-card-sub">{a.scope === "central" ? "central" : "client-network"}{a.clientName ? ` · ${a.clientName}` : " · all"}{a.enabled ? "" : " · disabled"}</div>
              <div className="m-card-meta">
                <span><span className="k">version</span> {a.semver ?? "—"}</span>
                <span><span className="k">build</span> <code style={{ fontSize: 11 }}>{a.version ? a.version.slice(0, 8) : "—"}</code></span>
                <span><span className="k">last seen</span> {ls.text}</span>
                <span><span className="k">uptime</span> {uptime(a.bootAt, nowMs)}</span>
                {v2 && <span><span className="k">priority</span> {a.priority}</span>}
              </div>
            </div>
          );
        })}
        {agents.length === 0 && <div className="note" style={{ padding: "1rem 0" }}>No agents enrolled.</div>}
      </div>
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
                  <td style={{ color: a.daysLeft <= 3 ? "var(--err-fg)" : undefined }}>{a.daysLeft} day{a.daysLeft === 1 ? "" : "s"}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button onClick={() => run(a.id, restoreAgent)} disabled={toggling === a.id}>Restore</button>
                    <button onClick={() => { if (confirm(`Permanently delete runner "${a.name}"? This can't be undone.`)) run(a.id, deleteAgentForever); }} disabled={toggling === a.id} style={{ marginLeft: 6, color: "var(--err-fg)" }}>Delete forever</button>
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
            <p className="note">On the target host, open an <b>elevated PowerShell</b> (5.1 or 7) and paste this. It downloads the installer, re-launches itself under PowerShell 7, installs any missing modules where the runner can load them, downloads the runner, auto-enrolls, and registers a Scheduled Task that starts on boot.</p>
            <textarea readOnly rows={3} style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }}
              value={install.command} onFocus={(e) => e.currentTarget.select()} />
            <div className="toolbar" style={{ marginTop: "0.5rem" }}>
              <CopyButton text={install.command} label="Copy command" copiedLabel="Copied ✓" style={{ fontSize: 13, padding: "0.25rem 0.6rem" }} />
              {/* Same installer as a saved file for shops that block `irm | iex`: save it, then run it
                  locally. `download` + attachment header name it install-iam-runner.ps1 to match the run line. */}
              <a className="button" href={`${origin}/api/runner/install.ps1?token=${install.token}&download=1`} download="install-iam-runner.ps1">Download install.ps1</a>
              <span className="grow" />
              <button className="primary" onClick={() => ref.current?.close()}>Done</button>
            </div>
            <p className="note" style={{ marginTop: "0.75rem", color: "var(--muted)" }}>
              Prefer a file? <b>Download install.ps1</b>, copy it to the host, then in an <b>elevated PowerShell</b> run{" "}
              <code>powershell -ExecutionPolicy Bypass -File .\install-iam-runner.ps1</code> (run <code>Unblock-File .\install-iam-runner.ps1</code> first if Windows flags it as downloaded). Same result as the one-liner.
            </p>
            <p className="note" style={{ marginTop: "0.5rem", color: "var(--muted)" }}>
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
                  <CopyButton text={manual} label="Copy" copiedLabel="Copied ✓" style={{ fontSize: 13, padding: "0.25rem 0.6rem" }} />
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

            {error && <p className="note" style={{ color: "var(--err-fg)" }}>{error}</p>}

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
              <CopyButton text={installCommand(installAgent, origin)} label="Copy command" copiedLabel="Copied ✓" style={{ fontSize: 13, padding: "0.25rem 0.6rem" }} />
              <span className="grow" />
              <button className="primary" onClick={() => setInstallAgent(null)}>Done</button>
            </div>
          </div>
        )}
      </dialog>

      {/* Edit agent: rename + (client-network) re-point at a client. */}
      <dialog ref={editRef} onClose={() => setEditAgent(null)} style={{ maxWidth: 480 }}>
        {editAgent && (
          <form onSubmit={saveEdit}>
            <div className="row-between">
              <h2>Edit agent</h2>
              <button type="button" onClick={() => setEditAgent(null)} aria-label="Close">×</button>
            </div>
            <label style={{ display: "block", marginTop: "0.5rem" }}>Name
              <input value={editName} onChange={(e) => setEditName(e.target.value)} required style={{ width: "100%" }} />
            </label>
            {editAgent.scope === "client_network" ? (
              <label style={{ display: "block", marginTop: "0.5rem" }}>Client
                <select value={editClient} onChange={(e) => setEditClient(e.target.value)} required style={{ width: "100%" }}>
                  <option value="">— pick a client —</option>
                  {clients.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
                </select>
              </label>
            ) : (
              <p className="note">A central runner serves all clients — only the name is editable.</p>
            )}
            {editError && <p className="note danger">{editError}</p>}
            <div className="toolbar" style={{ marginTop: "0.75rem" }}>
              <span className="grow" />
              <button type="button" onClick={() => setEditAgent(null)}>Cancel</button>
              <button className="primary" disabled={editBusy}>{editBusy ? "Saving…" : "Save"}</button>
            </div>
          </form>
        )}
      </dialog>

      {/* Per-agent troubleshoot: diagnose a runner that enrolled but never heartbeats (the "pre-build
          runner" that stays that way, an update stuck on "queued…"). The served script checks each
          layer on the host and ends with a verdict + an optional foreground run. */}
      <dialog ref={troubleshootRef} onClose={() => setTroubleshootAgent(null)} style={{ maxWidth: 680 }}>
        {troubleshootAgent && (
          <div>
            <div className="row-between">
              <h2>Troubleshoot runner: {troubleshootAgent.name}</h2>
              <button onClick={() => setTroubleshootAgent(null)} aria-label="Close">×</button>
            </div>
            <p className="note">
              For a runner that <b>never comes online</b> — it shows &ldquo;pre-build runner&rdquo; forever, or an update
              sits on &ldquo;queued — waiting for the runner to poll&rdquo;. Run this in <b>PowerShell on the runner host</b>{" "}
              (elevated, so it can read the machine-level token). It checks PowerShell 7, the runner files, the
              Scheduled Task, <code>RUNNER_API_TOKEN</code>, the browser sidecar, connectivity and auth — then prints a
              verdict, <b>offers to fix</b> what it safely can, and <b>offers to reboot</b> (a SYSTEM task only picks up
              machine env vars after one). It can also run the runner in the foreground so you can watch it live.
              {" "}<a href="/help/runner-troubleshooting" target="_blank" rel="noreferrer">Troubleshooting guide →</a>
            </p>
            <textarea readOnly rows={2} style={{ width: "100%", fontFamily: "monospace", fontSize: 11 }}
              value={troubleshootCommand(troubleshootAgent, origin)} onFocus={(e) => e.currentTarget.select()} />
            <p className="note" style={{ color: "var(--muted)" }}>
              Diagnostics are read-only and never touch this agent&apos;s status here (the auth check uses a probe id, so
              it can&apos;t consume a queued update or fake &ldquo;last seen&rdquo;). Common outcome: everything passes but the
              service started before the token landed — the fix is a <b>reboot</b> of the runner host.
            </p>
            <div className="toolbar" style={{ marginTop: "0.5rem" }}>
              <CopyButton text={troubleshootCommand(troubleshootAgent, origin)} label="Copy command" copiedLabel="Copied ✓" style={{ fontSize: 13, padding: "0.25rem 0.6rem" }} />
              <span className="grow" />
              <button className="primary" onClick={() => setTroubleshootAgent(null)}>Done</button>
            </div>
          </div>
        )}
      </dialog>

      {/* Per-agent LOCAL restart: the command to restart the runner process ON the device itself — for
          when the app's Restart (delivered via heartbeat) can't be used because the agent isn't
          heartbeating. How it's supervised varies by OS, so show each and run the matching block. */}
      <dialog ref={localRestartRef} onClose={() => setLocalRestartAgent(null)} style={{ maxWidth: 680 }}>
        {localRestartAgent && (() => {
          const win = "Stop-ScheduledTask -TaskName iam-runner; Start-ScheduledTask -TaskName iam-runner";
          const mac = "launchctl kickstart -k gui/$(id -u)/com.coretelligent.iamrunner";
          const linux = "sudo systemctl restart iam-runner";
          const pre = { background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 6, padding: "0.4rem 0.6rem", whiteSpace: "pre-wrap" as const, fontSize: 12, margin: 0 };
          const hdr = { margin: "0.6rem 0 0.15rem" };
          const central = localRestartAgent.scope === "central";
          return (
            <div>
              <div className="row-between">
                <h2>Local restart: {localRestartAgent.name}</h2>
                <button onClick={() => setLocalRestartAgent(null)} aria-label="Close">×</button>
              </div>
              <p className="note">
                Restart the runner <b>on the device itself</b> — use this when the app&apos;s <b>Restart</b> can&apos;t reach it
                (it isn&apos;t heartbeating). Run the block that matches how the host supervises the runner, in an
                <b> elevated</b> shell on the runner host.{" "}
                {central ? "This is a central runner — usually macOS (launchd) or Linux (systemd)." : "This is a client-network runner — usually Windows (Scheduled Task)."}
              </p>
              <p className="note" style={hdr}><b>Windows</b> (Scheduled Task):</p>
              <pre style={pre}>{win}</pre>
              <p className="note" style={hdr}><b>macOS</b> (launchd — adjust the label if different: <code>launchctl list | grep -i iam</code>):</p>
              <pre style={pre}>{mac}</pre>
              <p className="note" style={hdr}><b>Linux</b> (systemd):</p>
              <pre style={pre}>{linux}</pre>
              <p className="note" style={{ color: "var(--muted)", marginTop: "0.5rem" }}>
                Last resort on any OS: kill the runner process (<code>pwsh</code> running <code>Start-IamRunner</code>) and
                its supervisor relaunches it. A local restart re-runs the code already on disk — to get new code, use <b>Update</b>.
              </p>
              <div className="toolbar" style={{ marginTop: "0.5rem" }}>
                <CopyButton text={central ? mac : win} label={<>Copy {central ? "macOS" : "Windows"} command</>} copiedLabel="Copied ✓" style={{ fontSize: 13, padding: "0.25rem 0.6rem" }} />
                <span className="grow" />
                <button className="primary" onClick={() => setLocalRestartAgent(null)}>Done</button>
              </div>
            </div>
          );
        })()}
      </dialog>
    </>
  );
}
