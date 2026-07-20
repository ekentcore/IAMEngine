"use client";

// "Set up M365 automatically" — provision this client's iam-engine app registration end to end
// (device-code Global-Admin sign-in in a runner browser -> Graph app-reg -> Delinea write-back).
// Starts a detached run and polls its status.
//
// The whole flow lives in ONE centered modal with two screens:
//   • form     — pick the Global Admin login's Delinea secret + which optional Graph permissions to
//                request/consent, then Start.
//   • progress — a live step tracker (Connect → Sign in → Configure app registration → Save
//                credential). The sign-in step blocks on a human approving the Global Admin sign-in,
//                so the device code shows as a prominent "action needed" callout (with an elapsed
//                escalation) rather than a footnote. On success it shows the Exchange admin outcome
//                and the Delinea secret id the credential was vaulted as (so an operator knows what to use).
//
// The GA reference is used TRANSIENTLY for this one run — the API threads it onto the case's
// secretOverrides so the runner can broker the login without anything being vaulted on the client.
// After setup the client only carries the app-registration's own m365-admin credential.
import { useCallback, useEffect, useRef, useState } from "react";
import { optionalCapChoices } from "@/lib/secrets/graph-caps";

type ClientState = {
  status: string; stage?: string | null; appId?: string | null; verified?: boolean | null;
  wroteCreds?: boolean | null; error?: string | null; warnings?: string[]; userCode?: string | null;
  verificationUri?: string | null; skipReason?: string | null; log?: string[];
  externalId?: string | null; gaps?: string[];
};

// The live step tracker. Each backend stage maps to exactly one step; the finer work the user pictured
// (API permissions, Exchange admin role) all happens inside the single atomic "provision" step, so it
// carries them as a caption rather than pretending to light them one at a time.
const STEPS: { label: string; caption?: string; stages: string[] }[] = [
  { label: "Connect to Microsoft", stages: ["device-code-init"] },
  { label: "Sign in as Global Admin", stages: ["browser-signin", "token"] },
  { label: "Configure the app registration", caption: "API permissions · optional APIs · Exchange admin role", stages: ["provision"] },
  { label: "Save the credential to Delinea", stages: ["write"] },
];

// Which step a stage belongs to (-1 for stages that don't map to a numbered step: done / error / etc.).
function stepOf(stage?: string | null): number {
  if (!stage) return -1;
  return STEPS.findIndex((s) => s.stages.includes(stage));
}

const OPTIONAL_CAPS = optionalCapChoices();

export function M365SetupButton({ slug, openSignal, hideTrigger }: { slug: string; openSignal?: number; hideTrigger?: boolean }) {
  const [phase, setPhase] = useState<"form" | "progress">("form");
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<ClientState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [gaSecretRef, setGaSecretRef] = useState("");
  // Optional permissions to request — default all on (matches the old required+optional behaviour), the
  // operator unticks any they don't want granted. Keyed by each cap's suggestedRole.
  const [optRoles, setOptRoles] = useState<Set<string>>(() => new Set(OPTIONAL_CAPS.map((c) => c.role)));
  const [modalError, setModalError] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // Highest step index the run has reached — monotonic, so a fast stage transition still leaves earlier
  // steps marked done even if a poll skipped over them. Reset at the start of each run.
  const maxStep = useRef(-1);
  // Elapsed time on the sign-in step, so the "approve the sign-in" prompt can escalate if it's been a
  // while (that step blocks on a human approving MFA / entering the device code). `tick` just forces a
  // re-render each second; `signinSince` is when the sign-in step was first entered.
  const [, setTick] = useState(0);
  const signinSince = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/clients/${slug}/m365-setup`, { cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error ?? `failed (${r.status})`); return d?.client ?? null; }
      setState(d.client ?? null);
      return d.client ?? null;
    } catch (e) { setError((e as Error).message); return null; }
  }, [slug]);

  // Poll while the client's run is unsettled.
  useEffect(() => {
    const terminal = state && ["done", "skipped", "failed"].includes(state.status);
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

  // Stamp when the sign-in step is first entered (for the elapsed/escalation prompt), clear otherwise.
  useEffect(() => {
    const onSignin = state?.stage === "browser-signin" || state?.stage === "token";
    if (onSignin) { if (signinSince.current == null) signinSince.current = Date.now(); }
    else signinSince.current = null;
  }, [state?.stage]);

  // While a run is live, re-render every second so the sign-in elapsed counter advances.
  useEffect(() => {
    const live = active || state?.status === "pending" || state?.status === "running";
    if (!live) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [active, state?.status]);

  const openForm = useCallback(async () => {
    setModalError(null); setError(null); setLogOpen(false); setCopied(false);
    dialogRef.current?.showModal();
    // If a run for this client is already in flight (or just finished), jump straight to progress so a
    // reopen shows live status instead of a fresh form.
    const c = await load();
    const s = (c as ClientState | null)?.status;
    if (s === "running" || s === "pending" || s === "done" || s === "failed") setPhase("progress");
    else setPhase("form");
  }, [load]);

  // Menu-driven open: a change in openSignal (an incrementing counter) requests the modal.
  useEffect(() => {
    if (openSignal === undefined || openSignal === 0) return;
    void openForm();
  }, [openSignal, openForm]);

  function closeModal() { dialogRef.current?.close(); }

  async function start() {
    const ref = gaSecretRef.trim();
    if (!ref) return;
    setBusy(true); setModalError(null); setError(null); setActive(true); setLogOpen(false); setCopied(false);
    maxStep.current = -1;
    signinSince.current = null;
    setState({ status: "pending", stage: null });
    setPhase("progress");
    try {
      const r = await fetch(`/api/clients/${slug}/m365-setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gaSecretRef: ref, optionalRoles: [...optRoles] }),
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

  function reRun() {
    setState(null); setActive(false); setError(null); setModalError(null); setPhase("form");
  }

  async function copyId(id: string) {
    try {
      if (navigator.clipboard) { await navigator.clipboard.writeText(id); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    } catch { /* clipboard blocked on plain-http LAN — the id is shown as selectable text anyway */ }
  }

  const running = state?.status === "pending" || state?.status === "running";
  const done = state?.status === "done";
  const failed = state?.status === "failed";
  const hasLog = Boolean(state?.log && state.log.length > 0);
  // The step the failure landed on (from the terminal stage), else the furthest running step.
  const failedStep = failed ? (stepOf(state?.stage) >= 0 ? stepOf(state?.stage) : maxStep.current) : -1;
  const activeStep = Math.max(maxStep.current, stepOf(state?.stage));

  function stepStatus(i: number): "done" | "active" | "failed" | "pending" {
    if (done) return "done";
    if (failed) return i === failedStep ? "failed" : i < failedStep ? "done" : "pending";
    if (i < activeStep) return "done";
    if (i === activeStep || (activeStep < 0 && i === 0)) return "active";
    return "pending";
  }

  const isWriteFail = failed && (state?.stage === "write" || (state?.stage === "error" && (state?.log ?? []).some((l) => /delinea write/i.test(l))));

  // Seconds spent on the sign-in step (blocks on a human approving the sign-in).
  const signinElapsed = signinSince.current ? Math.floor((Date.now() - signinSince.current) / 1000) : 0;

  // Exchange Online admin outcome, read from the run log (provision emits deterministic lines for the
  // Exchange.ManageAsApp grant + Exchange Administrator role membership, or WARNs when a piece fails).
  const log = state?.log ?? [];
  const exchangeWarns = log.filter((l) => /warn.*exchange/i.test(l));
  const exchangeGranted = done && log.some((l) => /exchange\.manageasapp|exchange administrator/i.test(l)) && exchangeWarns.length === 0;

  return (
    <>
      {!hideTrigger && (
        <button disabled={busy || running} title="Automatically create + configure this client's iam-engine M365 app registration and vault the credential"
          onClick={() => void openForm()}>
          {running ? "Setting up…" : "Set up M365 automatically"}
        </button>
      )}

      <dialog ref={dialogRef} className="m365-setup-dialog" onClose={() => { setPhase("form"); }}>
        {phase === "form" ? (
          <>
            <h2>Set up M365 automatically</h2>
            <p className="note">
              Creates + configures this client&rsquo;s iam-engine app registration and vaults its credential.
              Sign in with a Global Admin login (UPN + password, One-Time Password enabled) — used once for
              this run, never stored on the client.
            </p>
            <label style={{ display: "block", fontSize: 14, margin: "0.75rem 0 0.4rem" }}>
              Global Admin login — Delinea secret ID
              <input type="text" required autoFocus value={gaSecretRef} disabled={busy}
                onChange={(e) => setGaSecretRef(e.target.value)} style={{ display: "block", marginTop: 4, width: "100%" }} />
            </label>

            <fieldset className="m365-optperms">
              <legend>Optional permissions to request &amp; consent</legend>
              <p className="note" style={{ margin: "0 0 0.5rem" }}>
                Required permissions are always granted. Tick the optional ones this client needs — each
                is requested and admin-consented during setup. Untick any you don&rsquo;t want granted.
              </p>
              {OPTIONAL_CAPS.map((c) => {
                const on = optRoles.has(c.role);
                return (
                  <label key={c.role} className="m365-optperm" title={c.why}>
                    <input type="checkbox" checked={on} disabled={busy}
                      onChange={(e) => setOptRoles((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(c.role); else next.delete(c.role);
                        return next;
                      })} />
                    <span>
                      <span className="m365-optperm-need">{c.need}</span>
                      <code className="m365-optperm-role">{c.role}</code>
                    </span>
                  </label>
                );
              })}
              <div className="note" style={{ marginTop: 6 }}>
                <button type="button" className="btn-quiet" style={{ fontSize: 12, padding: "1px 6px" }} disabled={busy}
                  onClick={() => setOptRoles(new Set(OPTIONAL_CAPS.map((c) => c.role)))}>All</button>{" "}
                <button type="button" className="btn-quiet" style={{ fontSize: 12, padding: "1px 6px" }} disabled={busy}
                  onClick={() => setOptRoles(new Set())}>None</button>
              </div>
            </fieldset>

            {modalError && <p className="note" style={{ color: "#b91c1c" }}>{modalError}</p>}
            <div className="toolbar" style={{ marginTop: "0.75rem" }}>
              <span className="grow" />
              <button type="button" onClick={closeModal} disabled={busy}>Cancel</button>
              <button type="button" className="primary" onClick={start} disabled={busy || !gaSecretRef.trim()}>
                {busy ? "Starting…" : "Start setup"}
              </button>
            </div>
          </>
        ) : (
          <>
            <h2>
              {done ? "M365 setup complete" : failed ? "M365 setup failed" : "Setting up M365…"}
            </h2>

            <ol className="setup-steps">
              {STEPS.map((s, i) => {
                const st = stepStatus(i);
                return (
                  <li key={s.label} className={`setup-step is-${st}`}>
                    <span className="setup-step-mark" aria-hidden="true">
                      {st === "done" ? "✓" : st === "failed" ? "✕" : st === "active" ? <span className="spinner" /> : ""}
                    </span>
                    <span className="setup-step-body">
                      <span className="setup-step-label">{s.label}</span>
                      {s.caption && <span className="setup-step-caption">{s.caption}</span>}
                    </span>
                  </li>
                );
              })}
            </ol>

            {/* Sign-in step blocks on a HUMAN approving the Global Admin sign-in — the runner drives the
                browser, but MFA (push / number-match / SMS) needs the operator. Surface the device code
                prominently as an "action needed" callout so a spinning sign-in doesn't look wedged. */}
            {running && stepStatus(1) === "active" && (
              <div className="setup-signin-callout">
                <div className="setup-signin-title">⚠ Action needed — approve the Global Admin sign-in</div>
                {state?.userCode ? (
                  <>
                    <div className="setup-signin-code">
                      <span className="note">Code</span>
                      <code>{state.userCode}</code>
                      <a className="button" href={state.verificationUri ?? "https://microsoft.com/devicelogin"} target="_blank" rel="noreferrer">Open devicelogin ↗</a>
                    </div>
                    <div className="note">
                      The runner is signing in for you, but a Global Admin has to approve it: approve the
                      sign-in prompt on your device, or open <b>microsoft.com/devicelogin</b> and enter the
                      code above yourself.
                      {signinElapsed >= 20 && (
                        <> <b>Still waiting after {signinElapsed}s</b> — it&rsquo;s almost certainly waiting on that approval.</>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="note">Requesting a sign-in code…</div>
                )}
              </div>
            )}

            {done && (
              <div className="setup-result-ok">
                <div>
                  {state?.verified ? "App registration configured & verified." : "App registration configured — some permissions are still pending."}
                  {state?.appId && <> App id <code>{state.appId}</code>.</>}
                </div>
                {state?.externalId ? (
                  <div className="setup-cred">
                    <span>Delinea credential (use this to wire / test the client):</span>
                    <code className="setup-cred-id">{state.externalId}</code>
                    <button type="button" className="btn-quiet" style={{ fontSize: 12 }} onClick={() => copyId(state.externalId!)}>
                      {copied ? "Copied ✓" : "Copy"}
                    </button>
                    <span className="note"> — wired as the <code>m365-admin</code> secret.</span>
                  </div>
                ) : (
                  <div className="note" style={{ color: "#8a6d00" }}>
                    ⚠ No Delinea credential is wired for this client — the app registration exists but its
                    credential was never vaulted (the wiring still holds a placeholder). Click <b>Set up
                    again</b> below to create and vault a real one.
                  </div>
                )}
                {/* Exchange Online app-only (Exchange.ManageAsApp + Exchange Administrator role) — its own
                    line so an operator can see whether the Exchange admin grant actually landed. */}
                {exchangeGranted ? (
                  <div className="note" style={{ color: "#2e7d32" }}>✓ Exchange Online admin granted (Exchange.ManageAsApp + Exchange Administrator role).</div>
                ) : exchangeWarns.length > 0 ? (
                  <div className="note" style={{ color: "#8a6d00" }}>
                    ⚠ Exchange Online admin needs attention: {exchangeWarns[0].replace(/^WARN\s*/i, "")}
                  </div>
                ) : null}
                {state?.gaps && state.gaps.length > 0 && (
                  <div className="note">Still-pending permissions: {state.gaps.join(", ")}.</div>
                )}
                {state?.warnings && state.warnings.length > 0 && (
                  <div className="note" style={{ color: "#8a6d00" }}>{state.warnings[0]}</div>
                )}
              </div>
            )}

            {failed && (
              <div className="setup-result-fail">
                <div style={{ color: "#b91c1c" }}>{state?.error ?? "The run failed."}</div>
                {isWriteFail && (
                  <div style={{ border: "1px solid var(--line, #e8e9ef)", borderRadius: 6, padding: "0.5rem 0.7rem", margin: "0.5rem 0", fontSize: 13 }}>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>The app was created but its credential couldn&rsquo;t be vaulted.</div>
                    <div className="note">Because the app secret is issued once and isn&rsquo;t shown here, the cleanest fix is to <b>re-run</b> — that rotates a fresh secret and vaults it. Or create it by hand in Delinea (template <b>Entra Azure AD Account</b>: Username = the app id{state?.appId ? <> <code>{state.appId}</code></> : null}, Password = a client secret you generate for the app, TenantId = the client&rsquo;s tenant/domain) and paste its id onto the <code>m365-admin</code> secret.</div>
                  </div>
                )}
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
              {/* Re-run is available on BOTH a failed and a completed run — a "done" run still needs a
                  way back (re-provision to reconcile permissions, rotate a credential, or recover a
                  client whose vault only ever got a placeholder). */}
              {(failed || done) && (
                <button type="button" onClick={reRun} disabled={running}>
                  {failed ? "Re-run setup" : "Set up again"}
                </button>
              )}
              <button type="button" className={done ? "primary" : undefined} onClick={closeModal} disabled={running && !failed && !done}>
                {running ? "Running…" : "Close"}
              </button>
            </div>
          </>
        )}
      </dialog>
    </>
  );
}
