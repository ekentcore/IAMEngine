"use client";

// "Set up Google Workspace automatically" — provision this client's service account + domain-wide
// delegation end to end (super-admin OAuth sign-in in a runner browser -> GCP project/service-account
// provisioning -> DWD grant -> Delinea write-back). Starts a detached run and polls its status. The
// Google analog of m365-setup-button.tsx — mirrors its dialog/two-phase/polling/openSignal shape and
// styling exactly; see that file for the fuller design rationale.
//
// The whole flow lives in ONE centered modal with two screens:
//   • form     — pick the super-admin login's Delinea secret (+ optionally force a key rotation), Start.
//   • progress — a live 5-step tracker (Sign in -> Create the service account -> Grant domain-wide
//                delegation -> Save the credential to Delinea -> Test the connection). If the automated
//                DWD grant isn't confirmed, the run still finishes (status `needs_action`) with a
//                manual-grant card: paste the service account's client id + scopes into the Admin
//                console by hand, then "Verify again" (re-POSTs with the same inputs — idempotent).
//
// The super-admin reference is used TRANSIENTLY for this one run (never vaulted on the client) — only
// the service account's own `google-admin` credential ends up wired.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CopyButton } from "@/app/_components/copy-button";
import { stepOf, needsActionStep } from "@/lib/secrets/google-setup-steps";

type GoogleClientState = {
  status: string; stage?: string | null; saEmail?: string | null; saClientId?: string | null;
  verified?: boolean | null; wroteCreds?: boolean | null; error?: string | null; warnings?: string[];
  userAction?: { kind: "dwd"; clientId: string; scopes: string[] } | null;
  skipReason?: string | null; log?: string[]; externalId?: string | null;
};

type ConnTestVerdict = {
  status: string; detail: string | null;
  accessOk: boolean | null; accessDetail: string | null;
  fieldsOk: boolean | null; fieldsDetail: string | null;
  finishedAt: string | null;
} | null;

// The live step tracker. Stage -> step routing (incl. the needs_action override) lives in
// google-setup-steps.ts so it's unit-testable without mounting this component.
const STEPS: { label: string }[] = [
  { label: "Sign in to Google" },
  { label: "Create the service account" },
  { label: "Grant domain-wide delegation" },
  { label: "Save the credential to Delinea" },
  { label: "Test the connection" },
];

const TERMINAL = new Set(["done", "needs_action", "skipped", "failed", "cancelled"]);

export function GoogleSetupButton({ slug, openSignal, hideTrigger }: { slug: string; openSignal?: number; hideTrigger?: boolean }) {
  const [phase, setPhase] = useState<"form" | "progress">("form");
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [state, setState] = useState<GoogleClientState | null>(null);
  const [connTest, setConnTest] = useState<ConnTestVerdict>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [seedSecretRef, setSeedSecretRef] = useState("");
  // Force a fresh service-account key even when the existing one is valid — the manual fix for an
  // incompletely-vaulted credential. Off by default: rotation churns credentials.
  const [forceRotate, setForceRotate] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  // Highest step index the run has reached — monotonic, so a fast stage transition still leaves
  // earlier steps marked done even if a poll skipped over them. Reset at the start of each run.
  const maxStep = useRef(-1);
  const router = useRouter();
  // Refresh the page ONCE when a run lands on a terminal status, so the client's Secrets panel below
  // reflects the newly-wired Delinea id (`done` OR `needs_action` both wire a real credential — only
  // the DWD grant differs). Reset when a new run starts.
  const refreshedOnTerminal = useRef(false);
  // Set by cancelRun: a poll that was already in flight when the cancel landed must not repopulate
  // the just-cleared state (it would flash the "running" view back for one cycle). Cleared whenever
  // the modal is (re)opened or a new run starts.
  const abandoned = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/clients/${slug}/google-setup`, { cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (abandoned.current) return null;
      if (!r.ok) { setError(d.error ?? `failed (${r.status})`); return null; }
      setState(d.client ?? null);
      setConnTest(d.connTest ?? null);
      return d.client ?? null;
    } catch (e) { if (!abandoned.current) setError((e as Error).message); return null; }
  }, [slug]);

  // Poll while the client's run is unsettled.
  useEffect(() => {
    const terminal = state && TERMINAL.has(state.status);
    if (terminal) { setActive(false); return; }
    const running = active || state?.status === "pending" || state?.status === "running";
    if (timer.current) clearTimeout(timer.current);
    if (running) timer.current = setTimeout(load, 3000);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [state, active, load]);

  // Track the furthest step reached as stages arrive.
  useEffect(() => {
    const i = stepOf(state?.stage);
    if (i > maxStep.current) maxStep.current = i;
  }, [state?.stage]);

  // On landing on a terminal status, re-fetch the page so the Secrets panel shows the freshly-wired id.
  useEffect(() => {
    if (state && TERMINAL.has(state.status)) {
      if (!refreshedOnTerminal.current) { refreshedOnTerminal.current = true; router.refresh(); }
    } else {
      refreshedOnTerminal.current = false;
    }
  }, [state, router]);

  const openForm = useCallback(async () => {
    abandoned.current = false;
    setModalError(null); setError(null); setLogOpen(false);
    dialogRef.current?.showModal();
    // If a run for this client is already in flight (or just finished), jump straight to progress so a
    // reopen shows live status instead of a fresh form.
    const c = await load();
    const s = (c as GoogleClientState | null)?.status;
    if (s && (s === "running" || s === "pending" || TERMINAL.has(s))) setPhase("progress");
    else setPhase("form");
  }, [load]);

  // Menu-driven open: a change in openSignal (an incrementing counter) requests the modal.
  useEffect(() => {
    if (openSignal === undefined || openSignal === 0) return;
    void openForm();
  }, [openSignal, openForm]);

  function closeModal() { dialogRef.current?.close(); }

  // Emergency stop: cancel the server-side run (which also stops its browser jobs), then wipe every
  // bit of local run state — timer, step tracker, state itself — and close the modal. The teardown
  // runs even if the DELETE fails (network blip / the run just finished): the operator asked for the
  // modal to go away, and the run's own timeouts+stale reaper are the server backstop.
  async function cancelRun() {
    setCancelling(true);
    abandoned.current = true; // drop any poll response still in flight — it must not repopulate state
    try {
      await fetch(`/api/clients/${slug}/google-setup`, { method: "DELETE" });
    } catch { /* teardown below still applies */ }
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    maxStep.current = -1;
    refreshedOnTerminal.current = false;
    setState(null); setConnTest(null); setActive(false); setError(null); setModalError(null); setLogOpen(false);
    setCancelling(false);
    setPhase("form");
    dialogRef.current?.close();
  }

  async function start() {
    const ref = seedSecretRef.trim();
    if (!ref) {
      // Can happen on "Verify again" after a remount landed on a needs_action run with the form's
      // local state empty — surface it instead of silently doing nothing.
      setPhase("form");
      setModalError("Re-enter the super-admin login secret ID to continue.");
      return;
    }
    abandoned.current = false;
    setBusy(true); setModalError(null); setError(null); setActive(true); setLogOpen(false);
    maxStep.current = -1;
    setState({ status: "pending", stage: null });
    setConnTest(null);
    setPhase("progress");
    try {
      const r = await fetch(`/api/clients/${slug}/google-setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seedSecretRef: ref, forceRotate }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = d.reason ?? d.error ?? `failed (${r.status})`;
        setModalError(msg); setActive(false); setPhase("form");
        return;
      }
      await load();
    } catch (e) {
      setModalError((e as Error).message); setActive(false); setPhase("form");
    } finally { setBusy(false); }
  }

  // "Verify again" on the needs_action card — re-POSTs with the SAME inputs already on hand (the
  // super-admin secret id + forceRotate), no form re-entry. Idempotent: a re-run just re-confirms the
  // DWD grant against the already-provisioned service account.
  async function verifyAgain() { await start(); }

  function reRun() {
    setState(null); setConnTest(null); setActive(false); setError(null); setModalError(null); setPhase("form");
  }

  const running = state?.status === "pending" || state?.status === "running";
  const done = state?.status === "done";
  const needsAction = state?.status === "needs_action";
  const failed = state?.status === "failed";
  const skipped = state?.status === "skipped";
  const cancelledRun = state?.status === "cancelled";
  const hasLog = Boolean(state?.log && state.log.length > 0);
  const attnStep = needsActionStep(state?.status);
  // The step the failure landed on (from the terminal stage), else the furthest running step.
  const failedStep = failed ? (stepOf(state?.stage) >= 0 ? stepOf(state?.stage) : maxStep.current) : -1;
  const activeStep = Math.max(maxStep.current, stepOf(state?.stage));

  function stepStatus(i: number): "done" | "active" | "failed" | "attn" | "pending" {
    if (cancelledRun) return "pending"; // a cancelled run's steps are moot — no spinner, no ✕
    if (needsAction && attnStep !== null) return i === attnStep ? "attn" : i < attnStep ? "done" : "pending";
    if (done) return "done";
    if (failed) return i === failedStep ? "failed" : i < failedStep ? "done" : "pending";
    if (i < activeStep) return "done";
    if (i === activeStep || (activeStep < 0 && i === 0)) return "active";
    return "pending";
  }

  return (
    <>
      {!hideTrigger && (
        <button disabled={busy || running} title="Automatically create this client's Google service account, grant domain-wide delegation, and vault the credential"
          onClick={() => void openForm()}>
          {running ? "Setting up…" : "Set up Google Workspace automatically"}
        </button>
      )}

      <dialog ref={dialogRef} className="google-setup-dialog" onClose={() => { setPhase("form"); }}>
        {phase === "form" ? (
          <>
            <h2>Set up Google Workspace automatically</h2>
            <p className="note">
              Creates + configures this client&rsquo;s Google service account (domain-wide delegation)
              and vaults its credential. Sign in with a super-admin login — used once for this run,
              never stored on the client.
            </p>
            <label style={{ display: "block", fontSize: 14, margin: "0.75rem 0 0.4rem" }}>
              Super-admin login — Delinea secret ID
              <input type="text" required autoFocus value={seedSecretRef} disabled={busy}
                onChange={(e) => setSeedSecretRef(e.target.value)} style={{ display: "block", marginTop: 4, width: "100%" }} />
            </label>

            <label className="m365-optperm" style={{ marginTop: "0.6rem" }}
              title="Issues a brand-new service-account key and re-vaults it, even if the current one is still valid. Use when the vaulted credential is incomplete.">
              <input type="checkbox" checked={forceRotate} disabled={busy} onChange={(e) => setForceRotate(e.target.checked)} />
              <span>
                <span className="m365-optperm-need">Rotate the service-account key</span>
                <span className="m365-optperm-role">for repairing an incomplete vault entry; the old key stops working</span>
              </span>
            </label>

            {modalError && <p className="note" style={{ color: "#b91c1c" }}>{modalError}</p>}
            <div className="toolbar" style={{ marginTop: "0.75rem" }}>
              <span className="grow" />
              <button type="button" onClick={closeModal} disabled={busy}>Cancel</button>
              <button type="button" className="primary" onClick={start} disabled={busy || !seedSecretRef.trim()}>
                {busy ? "Starting…" : "Start setup"}
              </button>
            </div>
          </>
        ) : (
          <>
            <h2>
              {done ? "Google Workspace setup complete" : needsAction ? "Almost done — one manual step" : failed ? "Google Workspace setup failed" : cancelledRun ? "Google Workspace setup cancelled" : "Setting up Google Workspace…"}
            </h2>

            <ol className="setup-steps">
              {STEPS.map((s, i) => {
                const st = stepStatus(i);
                return (
                  <li key={s.label} className={`setup-step is-${st}`}>
                    <span className="setup-step-mark" aria-hidden="true">
                      {st === "done" ? "✓" : st === "failed" ? "✕" : st === "attn" ? "!" : st === "active" ? <span className="spinner" /> : ""}
                    </span>
                    <span className="setup-step-body">
                      <span className="setup-step-label">{s.label}</span>
                    </span>
                  </li>
                );
              })}
            </ol>

            {needsAction && state?.userAction && (
              <div className="setup-dwd-card">
                <div style={{ fontWeight: 600 }}>Finish the domain-wide delegation grant by hand</div>
                <div className="note">
                  The automated grant wasn&rsquo;t confirmed. In the Google Admin console:
                </div>
                <div className="note" style={{ fontWeight: 600 }}>
                  Admin console → Security → Access and data control → API controls → Domain-wide delegation → Add new
                </div>
                <div className="setup-cred">
                  <span>Client ID</span>
                  <code className="setup-cred-id">{state.userAction.clientId}</code>
                  <CopyButton text={state.userAction.clientId} />
                </div>
                <div className="setup-cred">
                  <span>OAuth scopes</span>
                  <code className="setup-cred-id" style={{ fontSize: 12, fontWeight: 400 }}>{state.userAction.scopes.join(", ")}</code>
                  <CopyButton text={state.userAction.scopes.join(", ")} />
                </div>
                <div className="toolbar" style={{ marginTop: "0.4rem" }}>
                  <span className="grow" />
                  <button type="button" className="primary" onClick={verifyAgain} disabled={busy || running}>
                    {busy ? "Verifying…" : "Verify again"}
                  </button>
                </div>
              </div>
            )}

            {(done || needsAction) && (
              <div className="setup-result-ok">
                <div>
                  {state?.verified ? "Service account provisioned & domain-wide delegation verified." : "Service account provisioned."}
                  {state?.saEmail && <> Service account <code>{state.saEmail}</code>.</>}
                </div>
                {state?.externalId ? (
                  <div className="setup-cred">
                    <span>Delinea credential (use this to wire / test the client):</span>
                    <code className="setup-cred-id">{state.externalId}</code>
                    <CopyButton text={state.externalId} />
                    <span className="note"> — wired as the <code>google-admin</code> secret.</span>
                  </div>
                ) : (
                  <div className="note" style={{ color: "#8a6d00" }}>
                    ⚠ No Delinea credential is wired for this client yet.
                  </div>
                )}
                {connTest && (
                  <div className="note">
                    Connection test: <b>{connTest.status}</b>{connTest.detail ? ` — ${connTest.detail}` : ""}
                  </div>
                )}
                {state?.warnings && state.warnings.length > 0 && (
                  <div className="note" style={{ color: "#8a6d00" }}>{state.warnings[0]}</div>
                )}
              </div>
            )}

            {failed && (
              <div className="setup-result-fail">
                <div style={{ color: "#b91c1c" }}>{state?.error ?? "The run failed."}</div>
                {state?.warnings && state.warnings.length > 0 && (
                  <div className="note" style={{ color: "#8a6d00" }}>{state.warnings[0]}</div>
                )}
              </div>
            )}

            {skipped && (
              <div className="setup-result-fail">
                <div className="note">{state?.skipReason ?? "This client's setup was skipped."}</div>
              </div>
            )}

            {/* A cancelled run seen from another tab / a reopen — the tab that cancelled closes itself. */}
            {cancelledRun && (
              <div className="setup-result-fail">
                <div className="note">{state?.error ?? "This run was cancelled."}</div>
              </div>
            )}

            {error && <p className="note" style={{ color: "#b91c1c" }}>{error}</p>}

            {hasLog && (
              <div style={{ marginTop: 8 }}>
                <button type="button" className="btn-quiet" style={{ fontSize: 12 }} onClick={() => setLogOpen((v) => !v)}>
                  {logOpen ? "Hide run log" : "Show run log"}
                </button>
                {logOpen && (
                  <pre className="setup-log">{state!.log!.join("\n")}</pre>
                )}
              </div>
            )}

            <div className="toolbar" style={{ marginTop: "0.9rem" }}>
              <span className="grow" />
              {/* Re-run is a full reset back to the form — available on any terminal status, so an
                  operator can change the super-admin secret or force a rotation and start clean. The
                  needs_action card's own "Verify again" above is the faster path for that one case. */}
              {(failed || done || needsAction || skipped || cancelledRun) && (
                <button type="button" onClick={reRun} disabled={running}>
                  {failed || cancelledRun ? "Re-run setup" : "Set up again"}
                </button>
              )}
              {/* Emergency stop while the run is live: aborts the server-side run + its browser jobs,
                  clears everything held for it here, and closes the modal. */}
              {running && (
                <button type="button" onClick={() => void cancelRun()} disabled={cancelling}>
                  {cancelling ? "Cancelling…" : "Cancel setup"}
                </button>
              )}
              <button type="button" className={done ? "primary" : undefined} onClick={closeModal} disabled={running}>
                {running ? "Running…" : "Close"}
              </button>
            </div>
          </>
        )}
      </dialog>
    </>
  );
}
