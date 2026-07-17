"use client";

// The in-page half of the self-heal watchdog (lib/watchdog/self-heal.ts is the server half).
// Every open page probes /api/health/probe; when the server starts failing wholesale (the
// poisoned-module-graph class that 500s every route, heartbeats included) this pops a modal:
// supervised servers announce "restarting in about a minute" and the page reconnects by itself;
// unsupervised ones say plainly that a human must restart. The two halves never need to talk —
// each detects the same failure from its own side, which is the only design that works when the
// failure IS "no route can answer".
import { useEffect, useRef, useState } from "react";

type Mode = "ok" | "failing" | "waiting" | "db-down";

const PROBE_EVERY_MS = 15_000;
const RECONNECT_EVERY_MS = 3_000;
const FAILS_TO_ALARM = 3;
const COUNTDOWN_S = 60;

export function ServerWatchdog({ supervised }: { supervised: boolean }) {
  const [mode, setMode] = useState<Mode>("ok");
  const [countdown, setCountdown] = useState(COUNTDOWN_S);
  const fails = useRef(0);
  const dbFails = useRef(0);
  const modeRef = useRef<Mode>("ok");
  modeRef.current = mode;
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => { if (mode !== "ok") ref.current?.showModal(); else ref.current?.close(); }, [mode]);

  // Countdown while "failing"; when it hits zero we switch to "waiting" (server should be
  // restarting) and poll faster for its return.
  useEffect(() => {
    if (mode !== "failing") return;
    setCountdown(COUNTDOWN_S);
    const t = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) { setMode("waiting"); return 0; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [mode]);

  useEffect(() => {
    let stopped = false;
    async function probe() {
      if (stopped) return;
      // Background tabs skip probing (no point burning requests), except while we're waiting for a
      // restart to finish — that's exactly when the tab wants to come back on its own.
      if (document.visibilityState !== "visible" && modeRef.current === "ok") return;
      try {
        const res = await fetch("/api/health/probe", { cache: "no-store" });
        const body = (await res.json().catch(() => null)) as { probe?: string; db?: boolean } | null;
        const healthy = res.status < 500 && body?.probe === "iam" && body.db === true;
        const dbDown = res.status < 500 && body?.probe === "iam" && body.db === false;
        if (healthy) {
          fails.current = 0; dbFails.current = 0;
          if (modeRef.current === "failing" || modeRef.current === "waiting") {
            window.location.reload(); // the server is back — reconnect with a clean page
            return;
          }
          if (modeRef.current === "db-down") setMode("ok");
          return;
        }
        if (dbDown) {
          fails.current = 0;
          dbFails.current++;
          if (dbFails.current >= FAILS_TO_ALARM && modeRef.current === "ok") setMode("db-down");
          return;
        }
        // 5xx or a non-probe answer: the route layer is broken.
        dbFails.current = 0;
        fails.current++;
      } catch {
        fails.current++; // server unreachable — same alarm, likely mid-restart
      }
      if (fails.current >= FAILS_TO_ALARM && modeRef.current === "ok") setMode("failing");
    }
    const t = setInterval(() => void probe(), PROBE_EVERY_MS);
    // A faster loop that only bites while waiting for the restart to complete.
    const r = setInterval(() => { if (modeRef.current === "waiting" || modeRef.current === "failing") void probe(); }, RECONNECT_EVERY_MS);
    return () => { stopped = true; clearInterval(t); clearInterval(r); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (mode === "ok") return null;
  return (
    // No onCancel escape-hatch dismissal into a broken page: closing the dialog doesn't fix the
    // server, and it re-opens on the next failed probe anyway. Esc is a no-op by design.
    <dialog ref={ref} style={{ maxWidth: 460 }} onCancel={(e) => e.preventDefault()}>
      {mode === "db-down" ? (
        <>
          <h2>Database unreachable</h2>
          <p>
            The server is running but cannot reach its database, so nothing can load or save.
            Restarting will not help — check the database host and the server&rsquo;s network
            permission. This message clears itself when the connection returns.
          </p>
        </>
      ) : (
        <>
          <h2>{mode === "waiting" ? "Server restarting…" : "Server is failing"}</h2>
          {mode === "failing" && supervised && (
            <p>
              Every request is failing (this usually follows a code update landing under the running
              server). It will <b>restart itself in about {countdown}s</b> — this page reconnects
              automatically when it&rsquo;s back.
            </p>
          )}
          {mode === "failing" && !supervised && (
            <p>
              Every request is failing (this usually follows a code update landing under the running
              server). No supervisor is active, so it cannot restart itself —{" "}
              <b>restart the dev server</b> (or run <code>web/scripts/activate-web-supervisor.sh</code>{" "}
              once to make this automatic). This page reconnects when it&rsquo;s back.
            </p>
          )}
          {mode === "waiting" && (
            <p>Waiting for the server to come back — this page reloads itself the moment it answers.</p>
          )}
          <p className="note" aria-live="polite">
            {mode === "failing" ? `checking every few seconds…` : "reconnecting…"}
          </p>
        </>
      )}
    </dialog>
  );
}
