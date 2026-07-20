"use client";

// "Set up M365 automatically" — provision this client's iam-engine app registration end to end
// (device-code Global-Admin sign-in in a runner browser -> Graph app-reg -> Delinea write-back).
// Starts a detached run and polls its status; shows the device user-code (for a manual fallback) and
// any browser sign-in warnings (e.g. non-automatable MFA).
import { useCallback, useEffect, useRef, useState } from "react";

type ClientState = {
  status: string; stage?: string | null; appId?: string | null; verified?: boolean | null;
  wroteCreds?: boolean | null; error?: string | null; warnings?: string[]; userCode?: string | null;
  verificationUri?: string | null; skipReason?: string | null;
};

export function M365SetupButton({ slug }: { slug: string }) {
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<ClientState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/clients/${slug}/m365-setup`, { cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error ?? `failed (${r.status})`); return; }
      setState(d.client ?? null);
    } catch (e) { setError((e as Error).message); }
  }, [slug]);

  // Poll while the client's run is unsettled. Keep polling after a start (active) even through a null
  // first read (the run row / client row may not exist yet) — only a terminal state stops it.
  useEffect(() => {
    const terminal = state && ["done", "skipped", "failed"].includes(state.status);
    if (terminal) { setActive(false); return; }
    const running = active || state?.status === "pending" || state?.status === "running";
    if (timer.current) clearTimeout(timer.current);
    if (running) timer.current = setTimeout(load, 3000);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [state, active, load]);

  useEffect(() => { void load(); }, [load]);

  async function start() {
    setBusy(true); setError(null); setActive(true);
    try {
      const r = await fetch(`/api/clients/${slug}/m365-setup`, { method: "POST" });
      const d = await r.json().catch(() => ({}));
      // Surface a 409 reason too (e.g. this client or the fleet already has a run in progress) instead
      // of swallowing it silently.
      if (!r.ok) setError(d.reason ?? d.error ?? `failed (${r.status})`);
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  const running = state?.status === "pending" || state?.status === "running";
  return (
    <span>
      <button disabled={busy || running} title="Automatically create + configure this client's iam-engine M365 app registration and vault the credential"
        onClick={start}>
        {running ? "Setting up…" : busy ? "Starting…" : "Set up M365 automatically"}
      </button>
      {state && (
        <span className="note" style={{ marginLeft: 8 }}>
          {state.status === "done" && (state.verified ? `Done — app ${state.appId ?? ""} configured & verified.` : `Done — app ${state.appId ?? ""} (some permissions still pending).`)}
          {state.status === "skipped" && `Skipped: ${state.skipReason ?? "not eligible"}.`}
          {state.status === "failed" && `Failed at ${state.stage}: ${state.error ?? "unknown"}${state.warnings?.length ? ` — ${state.warnings[0]}` : ""}`}
          {running && state.userCode && (
            <> In progress — if MFA needs a hand, sign in at <a href={state.verificationUri ?? "https://microsoft.com/devicelogin"} target="_blank" rel="noreferrer">devicelogin</a> with code <code>{state.userCode}</code>.</>
          )}
          {running && !state.userCode && " In progress…"}
        </span>
      )}
      {error && <span className="note" style={{ marginLeft: 8, color: "#b91c1c" }}>{error}</span>}
    </span>
  );
}
