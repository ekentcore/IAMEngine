# Per-agent bearer selection + token adoption. The runner is issued a per-agent token over time
# (Task 5/7 on the app side); until then — and forever as a fallback — it uses the interim shared
# token. Centralizing "which token is the bearer right now" here means every header-building site
# (Invoke-AppApi, Update-CtgRunner, Invoke-CtgMigrate, the progress/watchdog globals) flips to the
# per-agent token the instant one is adopted, with no other code change.
#
# Dot-sourced by Start-IamRunner.ps1 (so $script:AgentToken / $script:ApiToken resolve to its own
# script scope — the param-block variables) and by tests/AgentToken.Tests.ps1, so Pester exercises
# the exact same functions production runs, not a re-implementation.

function Get-CtgBearer {
    # The bearer for every authenticated call: prefer the per-agent token; fall back to the shared
    # one until it's adopted (or if adoption never lands — e.g. an older installer with no
    # -AgentToken). mTLS replaces this entirely in production.
    if ($script:AgentToken) { return $script:AgentToken }
    return $script:ApiToken
}

function Set-CtgAgentToken {
    # Adopt a per-agent token delivered by the heartbeat response (hb.provisionToken): persist it
    # (this process' env, so an immediate relaunch inherits it even before the supervisor entry is
    # rewritten, plus best-effort machine-scope so it survives a plain reboot without the app), switch
    # the bearer, and drop the shared token everywhere so a migrated agent can never fall back to it.
    # Pure state mutation only — no relaunch — so it's independently Pester-testable; the caller (the
    # runner's heartbeat branch) triggers the re-exec via Invoke-CtgRelaunch after calling this.
    param([Parameter(Mandatory)][string]$Token)

    $script:AgentToken = $Token
    $env:RUNNER_AGENT_TOKEN = $Token

    $script:ApiToken = $null
    $env:RUNNER_API_TOKEN = $null

    # Machine-scope env vars are Windows-only in .NET — [Environment]::SetEnvironmentVariable throws
    # PlatformNotSupportedException for the Machine/User targets on macOS/Linux. Best-effort: a client-
    # network Windows agent gets durable persistence across a plain reboot; everywhere else the process
    # env set above (inherited by the relaunch that follows) is what actually matters.
    try {
        [Environment]::SetEnvironmentVariable('RUNNER_AGENT_TOKEN', $Token, 'Machine')
        [Environment]::SetEnvironmentVariable('RUNNER_API_TOKEN', $null, 'Machine')
    } catch { }
}
