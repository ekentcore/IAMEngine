"use client";

// "Setup <system> API" — the guided credential-entry modal for a system with no full auto-provisioning
// flow (Mimecast / Spanning / Proofpoint today; see lib/secrets/api-setup-catalog.ts). Mirrors
// M365SetupButton's dialog + openSignal contract (menu-driven open, hideTrigger for a bare-modal use)
// and CreateInDelineaForm's field-requirements rendering, but folds BOTH of that form's paths — paste
// fresh fields, or wire an id already saved in Delinea — into one modal with a mode toggle.
//
//   • paste fields    — one <input> per REQUIRED field (SECRET_FIELD_REQUIREMENTS[secretName], same
//                        !f.optional filter as create-in-delinea) + a region <select> when the catalog
//                        entry carries regionOptions (Proofpoint). POSTs values straight to
//                        /secrets/create, which tests-then-vaults in one call.
//   • existing id     — one <input> for a Delinea secret id already holding this credential. POSTs to
//                        /secrets/test with wireOnPass so a passing test also wires it onto the client.
//
// Values never leave this component except in the one POST that uses them; only the verdict text (ok/
// error/hint) comes back and is rendered — never a credential value.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ApiSetupEntry } from "@/lib/secrets/api-setup-catalog";
import { SECRET_FIELD_REQUIREMENTS } from "@/lib/secrets/field-requirements";
import { buildGuidedValues, deriveSpanningValues } from "@/lib/secrets/guided-api-values";
import { isSecretish } from "./create-in-delinea";

// The requirement label the Spanning derivation OWNS: its value comes from the service/region selects
// (deriveSpanningValues), so the modal must not also render it as a free-text input.
const SPANNING_DERIVED_LABEL = "region or base url";

type Mode = "paste" | "existing" | "automatic";
type Verdict = { ok: boolean; text: string };

// Poll the console sign-in test's status endpoint until the job is terminal (or we give up). Kept
// simple: a fixed 3 s cadence, bounded so a wedged job can't spin forever — the runner-side flow has
// its own hard timeout, so a "still running" here past the cap means something is stuck.
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
  const [mode, setMode] = useState<Mode>("paste");
  const [busy, setBusy] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [region, setRegion] = useState(entry.regionOptions?.[0] ?? "");
  const [service, setService] = useState(entry.serviceOptions?.[0] ?? "");
  const [externalId, setExternalId] = useState("");
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [done, setDone] = useState(false);
  // Automatic tab: an optional per-run Delinea secret id to sign in with, so a login can be tested
  // without wiring a persistent mimecast-console secret. Sent transiently in the POST; never stored.
  const [consoleSecretRef, setConsoleSecretRef] = useState("");
  // Automatic tab: the live status line for the console sign-in test ("Signing in…", pass, fail).
  const [signinStatus, setSigninStatus] = useState<{ state: "idle" | "running" | "done"; verdict?: Verdict }>({ state: "idle" });
  // Automatic tab: Phase-2 "create the API app & vault" status.
  const [createStatus, setCreateStatus] = useState<{ state: "idle" | "running" | "done"; verdict?: Verdict }>({ state: "idle" });
  // Refresh the page ONCE per successful save, mirroring M365SetupButton's refreshedOnDone guard.
  const refreshedOnDone = useRef(false);

  // Required fields only — optional ones (incl. Proofpoint's `Region`, which the select below owns
  // exclusively) have a runner fallback and are never collected here, same filter as create-in-delinea.
  // A Spanning entry additionally derives the base-url requirement from the service/region selects, so
  // that field is never typed either.
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
    setMode("paste");
    refreshedOnDone.current = false;
    dialogRef.current?.showModal();
  }, [entry.regionOptions, entry.serviceOptions]);

  // Menu-driven open: a change in openSignal (an incrementing counter) requests the modal — same
  // contract as M365SetupButton.
  useEffect(() => {
    if (openSignal === undefined || openSignal === 0) return;
    openModal();
  }, [openSignal, openModal]);

  function closeModal() {
    dialogRef.current?.close();
  }

  function markDone() {
    setDone(true);
    if (!refreshedOnDone.current) {
      refreshedOnDone.current = true;
      router.refresh();
    }
  }

  async function verifyAndSavePaste() {
    setBusy(true);
    setVerdict(null);
    try {
      // Keyed by each field's CANONICAL synonym (f.anyOf[0]), not its human label — see
      // guided-api-values.ts. The region <select> (Proofpoint) contributes under "Region" only when
      // the catalog entry offers region options; a Spanning entry instead folds region + email service
      // into the derived apiURL/account-id pair (never a bare Region key — the create route would map
      // it onto the same slug as apiURL and clobber the URL).
      const typed = buildGuidedValues(fields, values, entry.derive === "spanning" ? undefined : entry.regionOptions ? region : undefined);
      const loginEmail = fields.find((f) => f.anyOf[0] === "ClientID");
      const derived = entry.derive === "spanning" ? deriveSpanningValues(loginEmail ? values[loginEmail.label] ?? "" : "", service, region) : {};
      const body = {
        name: entry.secretName,
        values: { ...typed, ...derived },
        label: `${entry.label} (auto)`,
      };
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

  // Automatic tab: dispatch the console sign-in test, then poll its status to a verdict. Proves the
  // mimecast-console login + MFA work before Phase 2's create-app automation is built on top. A typed
  // Delinea secret id is sent transiently (used via a case override, never stored); left blank, the
  // route requires a wired mimecast-console secret and returns actionable guidance on a 409.
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

  // Automatic tab, Phase 2: create the API 2.0 app in the console, harvest its Client ID/Secret, and
  // vault them to Delinea. Dispatches the full (signInOnly:false) console job, polls to completion; the
  // GET vaults the harvested credential and returns the new Delinea secret id. Do a sign-in test first.
  async function createApiApp() {
    setCreateStatus({ state: "running" });
    try {
      const ref = consoleSecretRef.trim();
      const r = await fetch(`/api/clients/${slug}/mimecast-console/create-api-app`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ref ? { consoleSecretRef: ref } : {}),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.jobId) {
        setCreateStatus({ state: "done", verdict: { ok: false, text: d.error ?? `couldn't start (${r.status})` } });
        return;
      }
      for (let i = 0; i < SIGNIN_MAX_POLLS; i++) {
        await sleep(SIGNIN_POLL_MS);
        const s = await fetch(`/api/clients/${slug}/mimecast-console/create-api-app?jobId=${encodeURIComponent(d.jobId)}`);
        const sd = await s.json().catch(() => ({}));
        if (sd.done) {
          setCreateStatus({
            state: "done",
            verdict: sd.ok
              ? { ok: true, text: `API application created and its credential vaulted${sd.externalId ? ` (Delinea secret ${sd.externalId})` : ""}.` }
              : { ok: false, text: sd.error ?? "the automated setup failed" },
          });
          if (sd.ok && !refreshedOnDone.current) { refreshedOnDone.current = true; router.refresh(); }
          return;
        }
      }
      setCreateStatus({ state: "done", verdict: { ok: false, text: "still running after several minutes — check the agent and re-run." } });
    } catch (e) {
      setCreateStatus({ state: "done", verdict: { ok: false, text: (e as Error).message } });
    }
  }

  const canSubmitPaste = fields.every((f) => (values[f.label] ?? "").trim() !== "");
  const canSubmitExisting = externalId.trim() !== "";
  const signinRunning = signinStatus.state === "running";
  const createRunning = createStatus.state === "running";

  return (
    <>
      {!hideTrigger && (
        <button disabled={busy} onClick={openModal}>
          Setup {entry.label} API
        </button>
      )}

      <dialog ref={dialogRef} className="m365-setup-dialog">
        <h2>Setup {entry.label} API</h2>

        <ol className="note" style={{ paddingLeft: 18, margin: "0 0 0.5rem" }}>
          {entry.steps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
        <div className="toolbar">
          <a className="button" href={entry.consoleUrl} target="_blank" rel="noreferrer">
            Open console ↗
          </a>
          {entry.helpPath && (
            <a className="button" href={entry.helpPath} target="_blank" rel="noreferrer">
              Full guide ↗
            </a>
          )}
        </div>

        <div className="toolbar" style={{ marginTop: "0.75rem" }}>
          <button type="button" className={mode === "paste" ? "primary" : undefined} disabled={busy || signinRunning} onClick={() => { setMode("paste"); setVerdict(null); }}>
            Paste fields
          </button>
          <button type="button" className={mode === "existing" ? "primary" : undefined} disabled={busy || signinRunning} onClick={() => { setMode("existing"); setVerdict(null); }}>
            Existing Delinea id
          </button>
          {entry.autoBrowser && (
            <button type="button" className={mode === "automatic" ? "primary" : undefined} disabled={busy || signinRunning} onClick={() => { setMode("automatic"); setVerdict(null); }}>
              Automatic (browser)
            </button>
          )}
        </div>

        {mode === "paste" ? (
          <div style={{ marginTop: "0.75rem" }}>
            {fields.map((f) => (
              <label key={f.label} style={{ display: "block", marginBottom: 10 }}>
                <span className="note" style={{ display: "block", marginBottom: 2 }}>{f.label}</span>
                <input
                  type={isSecretish(f.label) ? "password" : "text"}
                  autoComplete="off"
                  disabled={busy}
                  value={values[f.label] ?? ""}
                  placeholder={f.hint ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    setValues((prev) => ({ ...prev, [f.label]: v }));
                    setVerdict(null);
                  }}
                  style={{ width: 320 }}
                />
              </label>
            ))}
            {fields.length === 0 && (
              <p className="note muted">No field requirements known for this secret — add its fields in Delinea directly.</p>
            )}
            {entry.serviceOptions && (
              <label style={{ display: "block", marginBottom: 10 }}>
                <span className="note" style={{ display: "block", marginBottom: 2 }}>Email service</span>
                <select
                  value={service}
                  disabled={busy}
                  onChange={(e) => {
                    setService(e.target.value);
                    setVerdict(null);
                  }}
                >
                  {entry.serviceOptions.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </label>
            )}
            {entry.regionOptions && (
              <label style={{ display: "block", marginBottom: 10 }}>
                <span className="note" style={{ display: "block", marginBottom: 2 }}>Region</span>
                <select
                  value={region}
                  disabled={busy}
                  onChange={(e) => {
                    setRegion(e.target.value);
                    setVerdict(null);
                  }}
                >
                  {entry.regionOptions.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
        ) : mode === "existing" ? (
          <div style={{ marginTop: "0.75rem" }}>
            <label style={{ display: "block", marginBottom: 10 }}>
              <span className="note" style={{ display: "block", marginBottom: 2 }}>Delinea secret id</span>
              <input
                type="text"
                autoComplete="off"
                disabled={busy}
                value={externalId}
                onChange={(e) => {
                  setExternalId(e.target.value);
                  setVerdict(null);
                }}
                style={{ width: 320 }}
              />
            </label>
          </div>
        ) : (
          <div style={{ marginTop: "0.75rem" }}>
            <p className="note">
              The runner drives the Mimecast console for you. First confirm it can sign in; once that works,
              the automated setup will create the API application and save the credential to Delinea.
            </p>
            <p className="note muted">
              Sign in with a <code>mimecast-console</code> login — the Mimecast admin email + password, with
              One-Time Password enabled on the Delinea secret for MFA. Enter a Delinea secret id below to use it
              just for this test (nothing is stored), or leave it blank to use a <code>mimecast-console</code>
              {" "}secret already wired on this client.
            </p>
            <label style={{ display: "block", marginTop: "0.5rem", marginBottom: 10 }}>
              <span className="note" style={{ display: "block", marginBottom: 2 }}>Delinea secret id (optional)</span>
              <input
                type="text"
                autoComplete="off"
                disabled={signinRunning}
                value={consoleSecretRef}
                placeholder="e.g. 8404 — used for this test only, not saved"
                onChange={(e) => {
                  setConsoleSecretRef(e.target.value);
                  setSigninStatus({ state: "idle" });
                }}
                style={{ width: 320 }}
              />
            </label>
            <div className="toolbar" style={{ marginTop: "0.5rem", gap: 8 }}>
              <button type="button" disabled={signinRunning || createRunning} onClick={testConsoleSignin}>
                {signinRunning ? "Signing in…" : "Test sign-in"}
              </button>
              <button type="button" className="primary" disabled={signinRunning || createRunning} onClick={createApiApp}
                title="Create the API 2.0 application in the console, harvest its Client ID/Secret, and vault them to Delinea. Run a sign-in test first.">
                {createRunning ? "Creating & vaulting…" : "Create API app & vault"}
              </button>
            </div>
            {signinStatus.verdict && (
              <p className="note" style={{ color: signinStatus.verdict.ok ? "#2e7d32" : "#b91c1c" }}>
                {signinStatus.verdict.ok ? "✓ " : "✗ "}{signinStatus.verdict.text}
              </p>
            )}
            {createStatus.verdict && (
              <p className="note" style={{ color: createStatus.verdict.ok ? "#2e7d32" : "#b91c1c" }}>
                {createStatus.verdict.ok ? "✓ " : "✗ "}{createStatus.verdict.text}
              </p>
            )}
            <p className="note muted" style={{ marginTop: "0.5rem" }}>
              Creates an “iam-engine” API 2.0 app (Basic Administrator + Account/Domain/User &amp; Group
              Management) and vaults the credential. Needs live-console validation. If it can’t drive the
              console, use <b>Paste fields</b> after a successful sign-in test.
            </p>
          </div>
        )}

        {verdict && (
          <p className="note" style={{ color: verdict.ok ? "#2e7d32" : "#b91c1c" }}>
            {verdict.ok ? "✓ " : "✗ "}{verdict.text}
          </p>
        )}

        <div className="toolbar" style={{ marginTop: "0.9rem" }}>
          <span className="grow" />
          <button type="button" onClick={closeModal} disabled={busy || signinRunning}>{done ? "Close" : "Cancel"}</button>
          {/* Verify & save belongs to the two credential-entry tabs; the Automatic tab has its own action. */}
          {!done && mode !== "automatic" && (
            <button
              type="button"
              className="primary"
              disabled={busy || (mode === "paste" ? !canSubmitPaste : !canSubmitExisting)}
              onClick={mode === "paste" ? verifyAndSavePaste : verifyAndSaveExisting}
            >
              {busy ? "Verifying…" : "Verify & save"}
            </button>
          )}
        </div>
      </dialog>
    </>
  );
}
