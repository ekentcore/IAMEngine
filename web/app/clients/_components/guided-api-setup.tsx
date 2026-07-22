"use client";

// "Setup <system> API" — a step-by-step wizard for a system's API credential. Driven entirely by the
// catalog entry (lib/secrets/api-setup-catalog.ts): the operator picks a source (Automatic browser /
// Paste fields / Use an existing Delinea id) and the wizard walks the matching steps. The Automatic
// path steps through the browser run (sign in → create app → harvest → vault) advancing by coarse
// stage. A reusable "Suggest from Delinea" panel (DelineaSuggestions) sits at every step where a
// credential reference is entered, so the operator can pick an existing secret instead of typing an id.
//
// Values never leave this component except in the one POST that uses them; only verdict text (ok/error/
// hint) comes back and is rendered — never a credential value.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ApiSetupEntry } from "@/lib/secrets/api-setup-catalog";
import { SECRET_FIELD_REQUIREMENTS } from "@/lib/secrets/field-requirements";
import { buildGuidedValues, deriveSpanningValues } from "@/lib/secrets/guided-api-values";
import { wizardStepIds, type SetupSource } from "@/lib/secrets/wizard-steps";
import { stageIndex } from "@/lib/secrets/setup-stage";
import { isSecretish } from "./create-in-delinea";
import { DelineaSuggestions } from "./delinea-suggestions";

// The requirement label the Spanning derivation OWNS: its value comes from the service/region selects
// (deriveSpanningValues), so the modal must not also render it as a free-text input.
const SPANNING_DERIVED_LABEL = "region or base url";

type Verdict = { ok: boolean; text: string };

// The visible run stages (SETUP_STAGES minus the terminal "done"), with human labels for the checklist.
const RUN_STAGES: { key: string; label: string }[] = [
  { key: "signin", label: "Signing in to the console" },
  { key: "create", label: "Creating the API application" },
  { key: "harvest", label: "Harvesting the credential" },
  { key: "vault", label: "Saving to Delinea & wiring it on" },
];

// Poll the browser job's status endpoint until terminal (or we give up). Fixed 3 s cadence, bounded so a
// wedged job can't spin forever — the runner-side flow has its own hard timeout.
const SIGNIN_POLL_MS = 3000;
const SIGNIN_MAX_POLLS = 80; // ~4 min — comfortably past a browser launch + sign-in + MFA window
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function GuidedApiSetup({
  slug,
  entry,
  openSignal,
  hideTrigger,
}: {
  slug: string;
  entry: ApiSetupEntry;
  openSignal?: number;
  hideTrigger?: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  // Default source: automatic when the vendor supports it, else paste.
  const defaultSource: SetupSource = entry.autoCreateEndpoint ? "auto" : "paste";
  const [source, setSource] = useState<SetupSource>(defaultSource);
  const [stepIndex, setStepIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [region, setRegion] = useState(entry.regionOptions?.[0] ?? "");
  const [service, setService] = useState(entry.serviceOptions?.[0] ?? "");
  const [externalId, setExternalId] = useState("");
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [done, setDone] = useState(false);
  // Automatic path: an optional per-run Delinea secret id to sign in with (sent transiently, never stored).
  const [consoleSecretRef, setConsoleSecretRef] = useState("");
  const [signinStatus, setSigninStatus] = useState<{ state: "idle" | "running" | "done"; verdict?: Verdict }>({ state: "idle" });
  const [createStatus, setCreateStatus] = useState<{ state: "idle" | "running" | "done"; verdict?: Verdict }>({ state: "idle" });
  // Coarse run stage reported by the create-api GET poll (best-effort; often undefined today → the run
  // checklist shows an indeterminate "working…" until the terminal result). See lib/secrets/setup-stage.
  const [runStage, setRunStage] = useState<string | undefined>(undefined);
  const refreshedOnDone = useRef(false);

  const steps = wizardStepIds(entry, source);
  const step = steps[stepIndex] ?? "overview";
  const doneIndex = steps.indexOf("done");

  // Required fields only — optional ones (incl. Proofpoint's Region, owned by the select) have a runner
  // fallback and are never collected here. A Spanning entry derives its base-url requirement instead.
  const fields = (SECRET_FIELD_REQUIREMENTS[entry.secretName] ?? [])
    .filter((f) => !f.optional)
    .filter((f) => entry.derive !== "spanning" || f.label !== SPANNING_DERIVED_LABEL);

  const openModal = useCallback(() => {
    setVerdict(null);
    setDone(false);
    setBusy(false);
    setValues({});
    setExternalId("");
    setRegion(entry.regionOptions?.[0] ?? "");
    setService(entry.serviceOptions?.[0] ?? "");
    setConsoleSecretRef("");
    setSigninStatus({ state: "idle" });
    setCreateStatus({ state: "idle" });
    setRunStage(undefined);
    setSource(entry.autoCreateEndpoint ? "auto" : "paste");
    setStepIndex(0);
    refreshedOnDone.current = false;
    dialogRef.current?.showModal();
  }, [entry.regionOptions, entry.serviceOptions, entry.autoCreateEndpoint]);

  useEffect(() => {
    if (openSignal === undefined || openSignal === 0) return;
    openModal();
  }, [openSignal, openModal]);

  function closeModal() {
    dialogRef.current?.close();
  }

  // On a successful save, jump to the Done step and refresh the page once.
  function markDone() {
    setDone(true);
    if (doneIndex >= 0) setStepIndex(doneIndex);
    if (!refreshedOnDone.current) {
      refreshedOnDone.current = true;
      router.refresh();
    }
  }

  // Pick source on the overview step; changing it recomputes the step list (stepIndex stays at overview=0).
  function chooseSource(s: SetupSource) {
    setSource(s);
    setStepIndex(0);
    setVerdict(null);
  }

  async function verifyAndSavePaste() {
    setBusy(true);
    setVerdict(null);
    try {
      const typed = buildGuidedValues(fields, values, entry.derive === "spanning" ? undefined : entry.regionOptions ? region : undefined);
      const loginEmail = fields.find((f) => f.anyOf[0] === "ClientID");
      const derived = entry.derive === "spanning" ? deriveSpanningValues(loginEmail ? values[loginEmail.label] ?? "" : "", service, region) : {};
      const body = { name: entry.secretName, values: { ...typed, ...derived }, label: `${entry.label} (auto)` };
      const r = await fetch(`/api/clients/${slug}/secrets/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setVerdict({ ok: false, text: [d.error, d.hint].filter(Boolean).join(" — ") || `failed (${r.status})` });
        return;
      }
      setVerdict({ ok: true, text: `Saved — wired as ${entry.secretName} (Delinea id ${d.externalId}).` });
      markDone();
    } catch (e) {
      setVerdict({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function verifyAndSaveExisting() {
    const id = externalId.trim();
    if (!id) return;
    setBusy(true);
    setVerdict(null);
    try {
      const r = await fetch(`/api/clients/${slug}/secrets/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secrets: [{ name: entry.secretName, externalId: id }], wireOnPass: true }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setVerdict({ ok: false, text: d.error ?? `failed (${r.status})` });
        return;
      }
      const result = Array.isArray(d.results) ? d.results[0] : null;
      if (!result) {
        setVerdict({ ok: false, text: "no result returned" });
        return;
      }
      if (result.ok && result.wired) {
        setVerdict({ ok: true, text: `Verified & wired${result.label ? ` as ${result.label}` : ""}.` });
        markDone();
      } else if (result.ok && !result.wired) {
        setVerdict({ ok: false, text: result.wireError ?? "verified but could not be wired" });
      } else {
        setVerdict({ ok: false, text: result.error ?? "verification failed" });
      }
    } catch (e) {
      setVerdict({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  // Automatic path (mimecast only): dispatch the console sign-in test and poll it. Proves the login + MFA
  // work; a typed Delinea secret id is sent transiently (case override, never stored).
  async function testConsoleSignin() {
    setSigninStatus({ state: "running" });
    try {
      const ref = consoleSecretRef.trim();
      const r = await fetch(`/api/clients/${slug}/mimecast-console/signin-test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ref ? { consoleSecretRef: ref } : {}),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.jobId) {
        setSigninStatus({ state: "done", verdict: { ok: false, text: d.error ?? `couldn't start the test (${r.status})` } });
        return;
      }
      for (let i = 0; i < SIGNIN_MAX_POLLS; i++) {
        await sleep(SIGNIN_POLL_MS);
        const s = await fetch(`/api/clients/${slug}/mimecast-console/signin-test?jobId=${encodeURIComponent(d.jobId)}`);
        const sd = await s.json().catch(() => ({}));
        if (!s.ok) {
          setSigninStatus({ state: "done", verdict: { ok: false, text: sd.error ?? `couldn't read the test status (${s.status})` } });
          return;
        }
        if (sd.done) {
          setSigninStatus({
            state: "done",
            verdict: sd.ok
              ? { ok: true, text: "Signed in to the Mimecast console — the login and MFA work." }
              : { ok: false, text: sd.error ?? "sign-in failed" },
          });
          return;
        }
      }
      setSigninStatus({ state: "done", verdict: { ok: false, text: "the sign-in test is still running after several minutes — check the agent, then try again." } });
    } catch (e) {
      setSigninStatus({ state: "done", verdict: { ok: false, text: (e as Error).message } });
    }
  }

  // Automatic path: the generic "create API app & vault" action. POSTs to entry.autoCreateEndpoint to
  // dispatch the runner's browser flow, then polls its GET to a terminal { done, ok, externalId, error },
  // capturing the coarse `stage` each poll so the run checklist advances. On success the route has already
  // vaulted the harvested credential and wired it. Same contract for every vendor.
  async function createApiApp() {
    if (!entry.autoCreateEndpoint) return;
    setCreateStatus({ state: "running" });
    setRunStage(undefined);
    try {
      const ref = consoleSecretRef.trim();
      const r = await fetch(`/api/clients/${slug}/${entry.autoCreateEndpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ref ? { consoleSecretRef: ref } : {}),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.jobId) {
        setCreateStatus({ state: "done", verdict: { ok: false, text: [d.error, d.hint].filter(Boolean).join(" — ") || `couldn't start the setup (${r.status})` } });
        return;
      }
      for (let i = 0; i < SIGNIN_MAX_POLLS; i++) {
        await sleep(SIGNIN_POLL_MS);
        const s = await fetch(`/api/clients/${slug}/${entry.autoCreateEndpoint}?jobId=${encodeURIComponent(d.jobId)}`);
        const sd = await s.json().catch(() => ({}));
        if (!s.ok) {
          setCreateStatus({ state: "done", verdict: { ok: false, text: sd.error ?? `couldn't read the setup status (${s.status})` } });
          return;
        }
        if (typeof sd.stage === "string") setRunStage(sd.stage);
        if (sd.done) {
          if (sd.ok) {
            setRunStage("vault");
            setCreateStatus({ state: "done", verdict: { ok: true, text: `Created and vaulted — wired as ${entry.secretName}${sd.externalId ? ` (Delinea id ${sd.externalId})` : ""}.` } });
            markDone();
          } else {
            setCreateStatus({ state: "done", verdict: { ok: false, text: sd.error ?? "the automated setup did not complete" } });
          }
          return;
        }
      }
      setCreateStatus({ state: "done", verdict: { ok: false, text: "the setup is still running after several minutes — check the agent/run, then try again or paste the credential." } });
    } catch (e) {
      setCreateStatus({ state: "done", verdict: { ok: false, text: (e as Error).message } });
    }
  }

  const canSubmitPaste = fields.every((f) => (values[f.label] ?? "").trim() !== "");
  const canSubmitExisting = externalId.trim() !== "";
  const signinRunning = signinStatus.state === "running";
  const createRunning = createStatus.state === "running";
  const autoRunning = signinRunning || createRunning;

  // How far the run checklist has progressed. On a successful terminal we mark all complete.
  const runIdx = createStatus.state === "done" && createStatus.verdict?.ok ? RUN_STAGES.length : stageIndex(runStage);

  const sourceLabel: Record<SetupSource, string> = { auto: "Automatic (browser)", paste: "Paste fields", existing: "Use an existing Delinea secret" };

  return (
    <>
      {!hideTrigger && (
        <button disabled={busy} onClick={openModal}>
          Setup {entry.label} API
        </button>
      )}

      <dialog ref={dialogRef} className="m365-setup-dialog">
        <h2>Setup {entry.label} API</h2>

        {/* Step rail */}
        <div className="toolbar note" style={{ gap: 6, marginBottom: "0.5rem", flexWrap: "wrap" }}>
          {steps.map((s, i) => (
            <span key={s} style={{ fontWeight: i === stepIndex ? 700 : 400, color: i === stepIndex ? "var(--fg)" : "var(--muted)" }}>
              {i > 0 ? "› " : ""}{stepLabel(s)}
            </span>
          ))}
        </div>

        {/* STEP: overview — pick the source */}
        {step === "overview" && (
          <div style={{ marginTop: "0.5rem" }}>
            <p className="note">
              We'll set up the <b>{entry.label}</b> API credential and vault it in this client's Delinea
              <b> Vendor</b> subfolder, then wire it on. Choose how to provide the credential:
            </p>
            <div className="toolbar" style={{ flexDirection: "column", alignItems: "stretch", gap: 6, marginTop: "0.5rem" }}>
              {entry.autoCreateEndpoint && (
                <button type="button" className={source === "auto" ? "primary" : undefined} onClick={() => chooseSource("auto")}>
                  {sourceLabel.auto} — the runner drives the console for you
                </button>
              )}
              <button type="button" className={source === "paste" ? "primary" : undefined} onClick={() => chooseSource("paste")}>
                {sourceLabel.paste} — enter the credential by hand
              </button>
              <button type="button" className={source === "existing" ? "primary" : undefined} onClick={() => chooseSource("existing")}>
                {sourceLabel.existing} — you already saved it in Delinea
              </button>
            </div>
          </div>
        )}

        {/* STEP: prep — the console steps as a checklist (automatic path) */}
        {step === "prep" && (
          <div style={{ marginTop: "0.5rem" }}>
            <p className="note">Here's what the automation will do — have the console handy in case it needs a hand:</p>
            <ol className="note" style={{ paddingLeft: 18, margin: "0.5rem 0" }}>
              {entry.steps.map((s, i) => <li key={i}>{s}</li>)}
            </ol>
            <div className="toolbar">
              <a className="button" href={entry.consoleUrl} target="_blank" rel="noreferrer">Open console ↗</a>
              {entry.helpPath && <a className="button" href={entry.helpPath} target="_blank" rel="noreferrer">Full guide ↗</a>}
            </div>
          </div>
        )}

        {/* STEP: login — the console login secret (automatic path), with Delinea suggestions */}
        {step === "login" && (
          <div style={{ marginTop: "0.5rem" }}>
            <p className="note">
              Sign in with a <code>{entry.autoConsoleSecret ?? "console"}</code> login (admin email + password,
              with One-Time Password on the Delinea secret for MFA). Pick an existing Delinea secret, or enter its
              id to use it just for this run (nothing extra is stored); leave blank to use one already wired.
            </p>
            <label style={{ display: "block", marginTop: "0.5rem", marginBottom: 6 }}>
              <span className="note" style={{ display: "block", marginBottom: 2 }}>Delinea secret id (optional)</span>
              <input
                type="text"
                autoComplete="off"
                disabled={autoRunning}
                value={consoleSecretRef}
                placeholder="e.g. 8404 — the console login, used for this run only"
                onChange={(e) => { setConsoleSecretRef(e.target.value); setSigninStatus({ state: "idle" }); setCreateStatus({ state: "idle" }); }}
                style={{ width: 320 }}
              />
            </label>
            {entry.autoConsoleSecret && (
              <DelineaSuggestions slug={slug} secretName={entry.autoConsoleSecret} onPick={(id) => setConsoleSecretRef(id)} />
            )}
            {entry.systemKey === "mimecast" && (
              <div className="toolbar" style={{ marginTop: "0.5rem" }}>
                <button type="button" disabled={autoRunning} onClick={testConsoleSignin}>
                  {signinRunning ? "Signing in…" : "Test sign-in first (optional)"}
                </button>
              </div>
            )}
            {signinStatus.verdict && (
              <p className="note" style={{ color: signinStatus.verdict.ok ? "#2e7d32" : "#b91c1c" }}>
                {signinStatus.verdict.ok ? "✓ " : "✗ "}{signinStatus.verdict.text}
              </p>
            )}
          </div>
        )}

        {/* STEP: run — the browser flow, with a stage checklist */}
        {step === "run" && (
          <div style={{ marginTop: "0.5rem" }}>
            <p className="note">The runner signs in, creates the API application, harvests the credential, and vaults it. Click below to start.</p>
            <ul style={{ listStyle: "none", paddingLeft: 0, margin: "0.5rem 0" }}>
              {RUN_STAGES.map((s, i) => {
                const state = runIdx > i ? "done" : (createRunning && (runIdx === i || runIdx < 0 && i === 0)) ? "active" : "todo";
                return (
                  <li key={s.key} className="note" style={{ padding: "2px 0", color: state === "done" ? "#2e7d32" : state === "active" ? "var(--fg)" : "var(--muted)" }}>
                    {state === "done" ? "✓ " : state === "active" ? "⏳ " : "○ "}{s.label}
                    {state === "active" && runIdx < 0 && " (working…)"}
                  </li>
                );
              })}
            </ul>
            {createStatus.verdict && (
              <p className="note" style={{ color: createStatus.verdict.ok ? "#2e7d32" : "#b91c1c" }}>
                {createStatus.verdict.ok ? "✓ " : "✗ "}{createStatus.verdict.text}
              </p>
            )}
            <p className="note muted" style={{ marginTop: "0.5rem" }}>
              Browser automation is best-effort — selectors vary by console/SSO. If it can't complete, go{" "}
              <b>Back</b> and choose <b>Paste fields</b> to enter the credential by hand.
            </p>
          </div>
        )}

        {/* STEP: fields — paste the credential, with Delinea suggestions to jump to an existing id */}
        {step === "fields" && (
          <div style={{ marginTop: "0.5rem" }}>
            <ol className="note" style={{ paddingLeft: 18, margin: "0 0 0.5rem" }}>
              {entry.steps.map((s, i) => <li key={i}>{s}</li>)}
            </ol>
            <div className="toolbar" style={{ marginBottom: 8 }}>
              <a className="button" href={entry.consoleUrl} target="_blank" rel="noreferrer">Open console ↗</a>
              {entry.helpPath && <a className="button" href={entry.helpPath} target="_blank" rel="noreferrer">Full guide ↗</a>}
            </div>
            {fields.map((f) => (
              <label key={f.label} style={{ display: "block", marginBottom: 10 }}>
                <span className="note" style={{ display: "block", marginBottom: 2 }}>{f.label}</span>
                <input
                  type={isSecretish(f.label) ? "password" : "text"}
                  autoComplete="off"
                  disabled={busy}
                  value={values[f.label] ?? ""}
                  placeholder={f.hint ?? ""}
                  onChange={(e) => { const v = e.target.value; setValues((prev) => ({ ...prev, [f.label]: v })); setVerdict(null); }}
                  style={{ width: 320 }}
                />
              </label>
            ))}
            {fields.length === 0 && <p className="note muted">No field requirements known for this secret — add its fields in Delinea directly.</p>}
            {entry.serviceOptions && (
              <label style={{ display: "block", marginBottom: 10 }}>
                <span className="note" style={{ display: "block", marginBottom: 2 }}>Email service</span>
                <select value={service} disabled={busy} onChange={(e) => { setService(e.target.value); setVerdict(null); }}>
                  {entry.serviceOptions.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
            )}
            {entry.regionOptions && (
              <label style={{ display: "block", marginBottom: 10 }}>
                <span className="note" style={{ display: "block", marginBottom: 2 }}>Region</span>
                <select value={region} disabled={busy} onChange={(e) => { setRegion(e.target.value); setVerdict(null); }}>
                  {entry.regionOptions.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </label>
            )}
            <DelineaSuggestions slug={slug} secretName={entry.secretName} onPick={(id) => { setSource("existing"); setStepIndex(wizardStepIds(entry, "existing").indexOf("existing")); setExternalId(id); setVerdict(null); }} />
          </div>
        )}

        {/* STEP: existing — wire a saved Delinea id, with suggestions */}
        {step === "existing" && (
          <div style={{ marginTop: "0.5rem" }}>
            <label style={{ display: "block", marginBottom: 10 }}>
              <span className="note" style={{ display: "block", marginBottom: 2 }}>Delinea secret id</span>
              <input
                type="text"
                autoComplete="off"
                disabled={busy}
                value={externalId}
                onChange={(e) => { setExternalId(e.target.value); setVerdict(null); }}
                style={{ width: 320 }}
              />
            </label>
            <DelineaSuggestions slug={slug} secretName={entry.secretName} onPick={(id) => { setExternalId(id); setVerdict(null); }} />
          </div>
        )}

        {/* STEP: done */}
        {step === "done" && (
          <div style={{ marginTop: "0.5rem" }}>
            <p className="note" style={{ color: "#2e7d32" }}>✓ {verdict?.text ?? createStatus.verdict?.text ?? "Done — the credential is vaulted and wired."}</p>
            <p className="note muted">You can test it from the client's connection panel.</p>
          </div>
        )}

        {/* verdict for the fields/existing paths (run/login show their own verdict lines above) */}
        {verdict && step !== "done" && (step === "fields" || step === "existing") && (
          <p className="note" style={{ color: verdict.ok ? "#2e7d32" : "#b91c1c" }}>
            {verdict.ok ? "✓ " : "✗ "}{verdict.text}
          </p>
        )}

        {/* Footer nav */}
        <div className="toolbar" style={{ marginTop: "0.9rem" }}>
          {stepIndex > 0 && step !== "done" && (
            <button type="button" disabled={busy || autoRunning} onClick={() => { setStepIndex((i) => Math.max(0, i - 1)); setVerdict(null); }}>Back</button>
          )}
          <span className="grow" />
          <button type="button" onClick={closeModal} disabled={busy || autoRunning}>{done ? "Close" : "Cancel"}</button>

          {/* Nav-only steps advance with Next */}
          {(step === "overview" || step === "prep" || step === "login") && (
            <button type="button" className="primary" disabled={autoRunning} onClick={() => setStepIndex((i) => Math.min(steps.length - 1, i + 1))}>Next</button>
          )}
          {/* Action steps carry their own primary action */}
          {step === "fields" && !done && (
            <button type="button" className="primary" disabled={busy || !canSubmitPaste} onClick={verifyAndSavePaste}>{busy ? "Verifying…" : "Verify & save"}</button>
          )}
          {step === "existing" && !done && (
            <button type="button" className="primary" disabled={busy || !canSubmitExisting} onClick={verifyAndSaveExisting}>{busy ? "Verifying…" : "Verify & save"}</button>
          )}
          {step === "run" && !done && (
            <button type="button" className="primary" disabled={autoRunning} onClick={createApiApp}>{createRunning ? "Setting up…" : "Create API app & vault"}</button>
          )}
        </div>
      </dialog>
    </>
  );
}

function stepLabel(id: string): string {
  switch (id) {
    case "overview": return "Overview";
    case "prep": return "Console steps";
    case "login": return "Login";
    case "run": return "Run";
    case "fields": return "Enter credential";
    case "existing": return "Existing secret";
    case "done": return "Done";
    default: return id;
  }
}
