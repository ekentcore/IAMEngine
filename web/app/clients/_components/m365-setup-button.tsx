"use client";

// "Set up M365 automatically" — provision this client's iam-engine app registration end to end
// (device-code Global-Admin sign-in in a runner browser -> Graph app-reg -> Delinea write-back).
// Starts a detached run and polls its status; shows the device user-code (for a manual fallback) and
// any browser sign-in warnings (e.g. non-automatable MFA).
//
// The button opens a small modal asking for the Global Admin login's Delinea secret id (gaSecretRef).
// That reference is used TRANSIENTLY for this one run — the API route threads it onto the case's
// secretOverrides so the runner can broker the GA login without anything ever being vaulted on the
// client. After setup the client only carries the app-registration's own m365-admin cert credential.
import { useCallback, useEffect, useRef, useState } from "react";

type ClientState = {
  status: string; stage?: string | null; appId?: string | null; verified?: boolean | null;
  wroteCreds?: boolean | null; error?: string | null; warnings?: string[]; userCode?: string | null;
  verificationUri?: string | null; skipReason?: string | null; log?: string[];
};

// Friendly progress text for each stage of the run, so "Setting up…" isn't the only signal while it's
// in flight. Falls back to a generic "In progress…" for an unmapped/not-yet-set stage.
const STAGE_LABELS: Record<string, string> = {
  "device-code-init": "requesting a device code…",
  "browser-signin": "signing in as the Global Admin…",
  token: "completing sign-in…",
  provision: "provisioning the app registration…",
  write: "vaulting the credential…",
};

function stageLabel(stage?: string | null): string {
  return (stage && STAGE_LABELS[stage]) || "In progress…";
}

// `open`/`onClose` make the setup modal externally controlled (e.g. opened from the client Actions
// menu). When provided the component renders no trigger button of its own — only the live status,
// run log and dialogs — so its progress stays visible on the page while the menu is closed. Left
// undefined, it keeps its original self-triggering "Set up M365 automatically" button.
export function M365SetupButton({ slug, open, onClose }: { slug: string; open?: boolean; onClose?: () => void }) {
  const controlled = open !== undefined;
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<ClientState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const failRef = useRef<HTMLDialogElement>(null);
  const failShownRef = useRef(false);
  const [gaSecretRef, setGaSecretRef] = useState("");
  const [modalError, setModalError] = useState<string | null>(null);
  // null = no manual choice yet -> defaults open on a terminal failure, closed otherwise. Once the
  // operator toggles it, that choice sticks through further polls of the SAME run.
  const [logOpenOverride, setLogOpenOverride] = useState<boolean | null>(null);

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

  // A Delinea WRITE failure (terminal "failed" at the write stage) pops a modal explaining what to do:
  // the app registration was provisioned but its credential couldn't be vaulted. Shown once per run.
  useEffect(() => {
    const writeFailed =
      state?.status === "failed" &&
      (state.stage === "write" ||
        (state.stage === "error" && (state.log ?? []).some((l) => /delinea write/i.test(l))));
    if (writeFailed && !failShownRef.current) {
      failShownRef.current = true;
      failRef.current?.showModal();
    }
  }, [state]);

  function openModal() {
    setGaSecretRef("");
    setModalError(null);
    dialogRef.current?.showModal();
  }

  function closeModal() {
    dialogRef.current?.close();
  }

  // Controlled mode: mirror the parent's `open` onto the native dialog (guarded so we don't re-show
  // an already-open dialog or double-close it).
  useEffect(() => {
    if (!controlled) return;
    const dlg = dialogRef.current;
    if (!dlg) return;
    if (open && !dlg.open) { setGaSecretRef(""); setModalError(null); dlg.showModal(); }
    else if (!open && dlg.open) dlg.close();
  }, [controlled, open]);

  async function start() {
    const ref = gaSecretRef.trim();
    if (!ref) return;
    setBusy(true); setModalError(null); setError(null); setActive(true); setLogOpenOverride(null); failShownRef.current = false;
    try {
      const r = await fetch(`/api/clients/${slug}/m365-setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gaSecretRef: ref }),
      });
      const d = await r.json().catch(() => ({}));
      // Surface a 409/422 reason too (e.g. this client or the fleet already has a run in progress, or
      // no gaSecretRef was given) instead of swallowing it silently.
      if (!r.ok) {
        const msg = d.reason ?? d.error ?? `failed (${r.status})`;
        setModalError(msg);
        setActive(false);
        return;
      }
      closeModal();
      await load();
    } catch (e) {
      setModalError((e as Error).message);
      setActive(false);
    } finally { setBusy(false); }
  }

  const running = state?.status === "pending" || state?.status === "running";
  // Default the run log open on a terminal failure (there's something worth reading immediately);
  // closed otherwise. A manual toggle (logOpenOverride non-null) always wins over that default.
  const logOpen = logOpenOverride ?? state?.status === "failed";
  const hasLog = Boolean(state?.log && state.log.length > 0);
  return (
    <span>
      {!controlled && (
        <button disabled={busy || running} title="Automatically create + configure this client's iam-engine M365 app registration and vault the credential"
          onClick={openModal}>
          {running ? "Setting up…" : busy ? "Starting…" : "Set up M365 automatically"}
        </button>
      )}
      {state && (
        <span className="note" style={{ marginLeft: 8 }}>
          {state.status === "done" && (state.verified ? `Done — app ${state.appId ?? ""} configured & verified.` : `Done — app ${state.appId ?? ""} (some permissions still pending).`)}
          {state.status === "skipped" && `Skipped: ${state.skipReason ?? "not eligible"}.`}
          {state.status === "failed" && `Failed at ${state.stage}: ${state.error ?? "unknown"}${state.warnings?.length ? ` — ${state.warnings[0]}` : ""}`}
          {running && state.userCode && (
            <> {stageLabel(state.stage)} If MFA needs a hand, sign in at <a href={state.verificationUri ?? "https://microsoft.com/devicelogin"} target="_blank" rel="noreferrer">devicelogin</a> with code <code>{state.userCode}</code>.</>
          )}
          {running && !state.userCode && ` ${stageLabel(state.stage)}`}
        </span>
      )}
      {error && <span className="note" style={{ marginLeft: 8, color: "#b91c1c" }}>{error}</span>}
      {hasLog && (
        <span style={{ marginLeft: 8 }}>
          <button
            type="button"
            className="note"
            style={{ border: "none", background: "none", padding: 0, cursor: "pointer", textDecoration: "underline" }}
            onClick={() => setLogOpenOverride(!logOpen)}
          >
            {logOpen ? "hide details" : "details"}
          </button>
          {logOpen && (
            <pre
              style={{
                marginTop: 4,
                maxHeight: 220,
                overflowY: "auto",
                overflowX: "auto",
                fontSize: 12,
                fontFamily: "var(--mono, monospace)",
                background: "var(--bg-soft, #f3f4f8)",
                padding: "0.5rem",
                border: "1px solid var(--line, #e8e9ef)",
                borderRadius: 4,
              }}
            >
              {state!.log!.join("\n")}
            </pre>
          )}
        </span>
      )}

      <dialog ref={dialogRef} onClose={controlled ? onClose : undefined} style={{ maxWidth: 480 }}>
        <h2>Set up M365 automatically</h2>
        <p className="note">
          The Delinea secret holding a Global Admin UPN + password with One-Time Password enabled.
          Used once for the sign-in, never stored on the client.
        </p>
        <label style={{ display: "block", fontSize: 14, margin: "0.75rem 0 0.5rem" }}>
          Global Admin login — Delinea secret ID
          <input
            type="text"
            required
            autoFocus
            value={gaSecretRef}
            disabled={busy}
            onChange={(e) => setGaSecretRef(e.target.value)}
            style={{ display: "block", marginTop: 4, width: "100%" }}
          />
        </label>
        {modalError && <p className="note" style={{ color: "#b91c1c" }}>{modalError}</p>}
        <div className="toolbar" style={{ marginTop: "0.75rem" }}>
          <span className="grow" />
          <button type="button" onClick={closeModal} disabled={busy}>Cancel</button>
          <button type="button" className="primary" onClick={start} disabled={busy || !gaSecretRef.trim()}>
            {busy ? "Starting…" : "Start"}
          </button>
        </div>
      </dialog>

      {/* Pops when the credential was provisioned but the Delinea WRITE failed. The app secret is
          one-time and server-only, so this is guidance + re-run, not a copyable value. */}
      <dialog ref={failRef} style={{ maxWidth: 560 }}>
        <h2>Couldn&rsquo;t save the credential to Delinea</h2>
        <p className="note" style={{ color: "#b91c1c" }}>{state?.error ?? "The Delinea write failed."}</p>
        <p className="note">
          The app registration{state?.appId ? <> (<code>{state.appId}</code>)</> : null} was created, but its
          credential couldn&rsquo;t be written to the vault. Because the app secret is issued once and isn&rsquo;t
          shown here, the cleanest fix is to <b>re-run</b> &mdash; that rotates a fresh secret and vaults it.
        </p>
        <div style={{ border: "1px solid var(--line, #e8e9ef)", borderRadius: 6, padding: "0.5rem 0.7rem", margin: "0.6rem 0", fontSize: 13 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Or create it by hand in Delinea:</div>
          <div><span className="note muted" style={{ display: "inline-block", minWidth: 74 }}>Template</span> Entra Azure AD Account</div>
          <div><span className="note muted" style={{ display: "inline-block", minWidth: 74 }}>Fields</span> Username = the app id{state?.appId ? <> (<code>{state.appId}</code>)</> : null}, Password = a client secret you generate for that app registration, TenantId = the client&rsquo;s tenant/domain</div>
          <div className="note muted" style={{ marginTop: 4 }}>Then paste the new secret&rsquo;s Delinea id onto this client&rsquo;s m365-admin secret.</div>
        </div>
        {state?.log && state.log.length > 0 && (
          <details style={{ marginTop: 4 }}>
            <summary className="note" style={{ cursor: "pointer" }}>run log</summary>
            <pre style={{ marginTop: 4, maxHeight: 200, overflow: "auto", fontSize: 12, fontFamily: "var(--mono, monospace)", background: "var(--bg-soft, #f3f4f8)", padding: "0.5rem", border: "1px solid var(--line, #e8e9ef)", borderRadius: 4 }}>
              {state.log.join("\n")}
            </pre>
          </details>
        )}
        <div className="toolbar" style={{ marginTop: "0.75rem" }}>
          <span className="grow" />
          <button type="button" onClick={() => failRef.current?.close()}>Close</button>
          <button type="button" className="primary" onClick={() => { failRef.current?.close(); openModal(); }}>Re-run setup</button>
        </div>
      </dialog>
    </span>
  );
}
