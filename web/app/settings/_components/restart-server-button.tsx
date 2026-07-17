"use client";

// "Restart server" (settings.manage): asks the app to exit; the supervisor (launchd locally,
// the App Service platform on Azure) relaunches it. Polls /api/health until the new process
// answers, so the operator sees when it's back. `children` renders beside the restart control —
// the Merge PRs dialog lives there (merge, then restart to pick up what landed).
import { useRef, useState } from "react";

export function RestartServerButton({ supervised, children }: { supervised: boolean; children?: React.ReactNode }) {
  const [state, setState] = useState<"idle" | "confirm" | "restarting" | "back" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const started = useRef(0);

  async function restart() {
    setState("restarting"); setErr(null);
    try {
      const r = await fetch("/api/admin/restart-server", { method: "POST" });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        setErr(d.error ?? `failed (${r.status})`); setState("error"); return;
      }
    } catch { /* the process may die before the response flushes — that's the restart happening */ }
    started.current = Date.now();
    poll();
  }

  function poll() {
    // Give the old process a beat to die, then wait for the new one (up to 90s).
    setTimeout(async () => {
      try {
        const r = await fetch("/api/health", { cache: "no-store" });
        if (r.ok) { setState("back"); return; }
      } catch { /* still down */ }
      if (Date.now() - started.current > 90_000) { setErr("server didn't come back within 90s — check the supervisor log (~/Library/Logs/iam-web.log)"); setState("error"); return; }
      poll();
    }, 2500);
  }

  return (
    <section style={{ marginTop: "1.5rem" }}>
      <h2>Server</h2>
      {!supervised ? (
        <p className="note">
          Restart from here needs a supervisor to relaunch the exited process — run{" "}
          <code>web/scripts/install-web-supervisor.sh</code> once on the host (the server then also
          auto-restarts on crashes). On Azure App Service this works with no setup: the platform
          relaunches the process itself.
        </p>
      ) : state === "restarting" ? (
        <p className="note">Restarting… waiting for the server to come back.</p>
      ) : state === "back" ? (
        <p className="note" style={{ color: "var(--ok-fg, #15803d)" }}>✓ Server is back. <button onClick={() => window.location.reload()}>Reload page</button></p>
      ) : state === "confirm" ? (
        <p className="note">
          Restart the web server now? In-flight requests drop; it&rsquo;s typically back in a few seconds.{" "}
          <button className="btn-danger" onClick={restart}>Restart now</button>{" "}
          <button onClick={() => setState("idle")}>Cancel</button>
        </p>
      ) : (
        <p className="note">
          <button onClick={() => setState("confirm")}>↻ Restart server</button>
          {" "}The supervisor relaunches it automatically; use after config or code changes (e.g. a just-merged PR).
        </p>
      )}
      {/* Merge PRs lives here as a sibling, NOT inside the <p> above — it renders a <dialog> with a
          <table>, and block content inside <p> is invalid HTML that React 18 rejects at hydration. */}
      {children && <div className="note" style={{ marginTop: 6 }}>{children}</div>}
      {err && <p className="note" style={{ color: "#b3261e" }}>{err}</p>}
    </section>
  );
}
