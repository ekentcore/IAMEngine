"use client";

// Guided credential-setup wizard: walks the operator one credential at a time to WIRED — a Delinea
// reference saved and (when Delinea is configured) readable with the right fields. It's a nicer
// front-end over the SAME guarded endpoints the Secrets panel uses — PUT /secrets (save the
// reference), POST /secrets/test (app-side field-shape check) — and adds NO mutation of its own.
//
// Wired ≠ verified. computeClientReadiness only calls a system "ready" once its LIVE connection test
// passes (test==="ok"), which needs the matching runner online. So the wizard's goal is to get every
// credential WIRED; live verification is a separate, client-wide "Run connection tests" action whose
// result is surfaced per step but is NOT required to progress (a runner is often offline during
// setup). This keeps the wizard honest — it never claims "verified" on a field-shape pass alone.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { secretIsSet } from "@/lib/secrets/wiring";
import { NOT_NEEDED } from "@/lib/cases/case-secrets";
import type { SetupStep } from "@/lib/clients/setup-steps";
import type { ConnTestState } from "@/lib/clients/readiness";
import type { RunnerReach } from "@/lib/runner/reachability";
import type { DelineaWriteSummary } from "@/lib/secrets/delinea-templates";
import { CreateInDelineaForm, createDisabledReason } from "@/app/clients/_components/create-in-delinea";
import { DelineaSuggestions } from "@/app/clients/_components/delinea-suggestions";
import { M365SetupButton } from "@/app/clients/_components/m365-setup-button";
import { GoogleSetupButton } from "@/app/clients/_components/google-setup-button";
import { GuidedApiSetup } from "@/app/clients/_components/guided-api-setup";
import { API_SETUP_CATALOG } from "@/lib/secrets/api-setup-catalog";

type FieldTest = { status: "idle" | "testing" | "ok" | "fail"; label?: string; missingFields?: string[]; error?: string };
type StepState = { externalId: string; notNeeded: boolean; saved: boolean; skipped: boolean; field: FieldTest; saveMsg?: string };
type ConnResult = { status: "pending" | "running" | "ok" | "fail" | "not_needed"; detail?: string | null; accessOk?: boolean | null; accessDetail?: string | null };

const CONN_POLL_MS = 3000;
const CONN_POLL_DEADLINE_MS = 120_000; // stop polling after this — a system with no runner online never settles

export function SetupWizard({
  slug,
  clientName,
  steps,
  systemKeys,
  initialConn,
  reach,
  delineaConfigured,
  write,
}: {
  slug: string;
  clientName: string;
  steps: SetupStep[];
  systemKeys: string[]; // every credentialed api system, for live-test bookkeeping
  initialConn: Record<string, ConnTestState>; // latest live-test state per systemKey (seed)
  reach?: Record<string, RunnerReach>; // runner reachability per systemKey (the "test comms to the runner" signal)
  delineaConfigured: boolean;
  write?: DelineaWriteSummary;
}) {
  const [state, setState] = useState<Record<string, StepState>>(() =>
    Object.fromEntries(
      steps.map((s) => [
        s.secretName,
        {
          // Show the REPLACE_ME placeholder / manual sentinel as an empty field, not literal text.
          externalId: s.notNeeded || !secretIsSet(s.externalId) ? "" : s.externalId,
          notNeeded: s.notNeeded,
          saved: true, // the server value is what's persisted; edits flip this to false
          skipped: false,
          // Seed the field check ok when the server already reads the step wired, so prior progress shows.
          field: (s.wired && !s.notNeeded ? { status: "ok" } : { status: "idle" }) as FieldTest,
        },
      ])
    )
  );
  const [conn, setConn] = useState<Record<string, ConnResult>>(() =>
    Object.fromEntries(
      systemKeys.map((k) => {
        const c = initialConn[k];
        return [k, { status: c === "ok" ? "ok" : c === "fail" ? "fail" : c === "not_needed" ? "not_needed" : "pending" }];
      })
    )
  );
  const [connBusy, setConnBusy] = useState(false);
  const [connError, setConnError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollDeadline = useRef<number>(0);

  // ---- derived per-step status --------------------------------------------------------------
  // Live connection-test verdict for a step, aggregated across its systems.
  const connStatusFor = useCallback(
    (s: SetupStep): ConnResult["status"] | "untested" => {
      const keys = s.systemKeys.filter((k) => k in conn);
      if (keys.length === 0) return "untested";
      const rs = keys.map((k) => conn[k].status);
      if (rs.some((r) => r === "fail")) return "fail";
      if (rs.some((r) => r === "running")) return "running";
      if (rs.every((r) => r === "ok" || r === "not_needed")) return "ok";
      return "pending";
    },
    [conn]
  );

  // WIRED = the operator's completion here: a saved reference that (when Delinea is configured) the
  // app can read with the right fields. NOT the live connection test — that's verification, shown
  // separately and never required to advance.
  const isWired = useCallback(
    (s: SetupStep): boolean => {
      const st = state[s.secretName];
      if (!st) return false;
      if (st.notNeeded) return st.saved;
      if (!secretIsSet(st.externalId) || !st.saved) return false;
      // Delinea unconfigured → the app-side field test can't run; a saved reference is the best we can do.
      if (!delineaConfigured) return true;
      return st.field.status === "ok" && !(st.field.missingFields && st.field.missingFields.length);
    },
    [state, delineaConfigured]
  );
  const isVerified = useCallback((s: SetupStep) => connStatusFor(s) === "ok", [connStatusFor]);

  // Does this step count toward "is this client set up?" An OPTIONAL credential (e.g. spanning-portal,
  // which only unlocks Spanning's force-sync) does NOT — nothing requires it, so counting an untouched
  // one would tell every Spanning client they're a credential short and make "All set" unreachable.
  // It starts counting the moment the operator actually enters a reference: a credential you chose to
  // add and got WRONG is worth blocking on, unlike one you never wanted.
  const counts = useCallback(
    (s: SetupStep): boolean => !s.optional || secretIsSet(state[s.secretName]?.externalId ?? s.externalId),
    [state]
  );
  const counted = useMemo(() => steps.filter(counts), [steps, counts]);

  const allWired = useMemo(() => counted.every((s) => isWired(s)), [counted, isWired]);
  const pending = useMemo(() => counted.filter((s) => !isWired(s) && !state[s.secretName]?.skipped), [counted, isWired, state]);

  // Active step: default to the first not-wired, not-manual step the client actually needs — never an
  // untouched optional one, or the wizard would open on a credential nobody asked for.
  const [activeIdx, setActiveIdx] = useState(() => {
    const i = steps.findIndex((s) => !s.wired && !s.notNeeded && !s.optional);
    return i === -1 ? 0 : i;
  });
  const active = steps[activeIdx];

  const wiredCount = useMemo(() => counted.filter((s) => isWired(s)).length, [counted, isWired]);
  const verifiedCount = useMemo(() => counted.filter((s) => isVerified(s) || (state[s.secretName]?.notNeeded ?? s.notNeeded)).length, [counted, isVerified, state]);

  const patch = (name: string, p: Partial<StepState>) => setState((s) => ({ ...s, [name]: { ...s[name], ...p } }));

  // "Next" walks the steps the client actually needs. An untouched optional credential is never
  // auto-advanced to — it's reachable from the rail for anyone who wants it, and skipped otherwise.
  function goNext(fromIdx: number) {
    const needs = (s: SetupStep) => counts(s) && !isWired(s) && !state[s.secretName]?.skipped;
    for (let i = fromIdx + 1; i < steps.length; i++) {
      if (needs(steps[i])) return setActiveIdx(i);
    }
    const first = steps.findIndex(needs);
    if (first !== -1) setActiveIdx(first);
  }

  // ---- actions (reuse the existing guarded endpoints) ---------------------------------------
  async function save(s: SetupStep, opts: { notNeeded?: boolean; externalId?: string } = {}): Promise<boolean> {
    const st = state[s.secretName];
    const notNeeded = opts.notNeeded ?? st.notNeeded;
    // An explicit externalId (a picked Delinea suggestion) wins over the field's state, which may not
    // have flushed yet — mirrors test()'s externalIdOverride so the SAME wiring call serves both.
    const externalId = notNeeded ? NOT_NEEDED : (opts.externalId ?? st.externalId).trim();
    patch(s.secretName, { saveMsg: undefined });
    try {
      const res = await fetch(`/api/clients/${slug}/secrets`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secrets: [{ name: s.secretName, externalId, label: s.label }] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        patch(s.secretName, { saveMsg: data.error ?? res.statusText });
        return false;
      }
      patch(s.secretName, { saved: true, notNeeded });
      return true;
    } catch (e) {
      patch(s.secretName, { saveMsg: (e as Error).message });
      return false;
    }
  }

  async function test(s: SetupStep, externalIdOverride?: string) {
    // Override lets a just-created reference be tested immediately, before its setState has flushed.
    const externalId = (externalIdOverride ?? state[s.secretName].externalId).trim();
    patch(s.secretName, { field: { status: "testing" } });
    try {
      const res = await fetch(`/api/clients/${slug}/secrets/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secrets: [{ name: s.secretName, externalId }] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      const r = (data.results as { ok: boolean; label?: string; error?: string; missingFields?: string[] }[])[0];
      patch(s.secretName, {
        field: r?.ok ? { status: "ok", label: r.label, missingFields: r.missingFields } : { status: "fail", error: r?.error },
      });
    } catch (e) {
      patch(s.secretName, { field: { status: "fail", error: (e as Error).message } });
    }
  }

  async function saveAndTest(s: SetupStep) {
    const ok = await save(s);
    if (!ok) return;
    if (delineaConfigured && secretIsSet(state[s.secretName].externalId)) await test(s);
  }

  // A secret was created in Delinea (and wired server-side): reflect the returned id as saved + reads-ok
  // so the step shows wired immediately. The operator can still run the live connection test.
  async function onCreated(s: SetupStep, externalId: string) {
    // The reference is created + wired; don't ASSUME it reads ok — run the real field-shape check so
    // a mis-shaped secret shows ⚠/✗ instead of a false green. (The create route already refuses to
    // POST a blank secret, but the read-back is the honest confirmation.)
    patch(s.secretName, { externalId, saved: true, notNeeded: false, field: { status: "idle" }, saveMsg: undefined });
    if (delineaConfigured) await test(s, externalId);
  }

  // An EXISTING Delinea secret was picked from the suggestions panel: wire it through the SAME path
  // "paste an id → Save and test" uses (PUT /secrets then the field-shape test) — unlike onCreated,
  // whose secret was already wired server-side by the create route. Reuses save() + test(), just with
  // an explicit id so it doesn't race the input's setState.
  async function onPickSuggestion(s: SetupStep, externalId: string) {
    patch(s.secretName, { externalId, saved: false, notNeeded: false, field: { status: "idle" }, saveMsg: undefined });
    const ok = await save(s, { externalId });
    if (ok && delineaConfigured && secretIsSet(externalId)) await test(s, externalId);
  }

  async function markNotNeeded(s: SetupStep) {
    patch(s.secretName, { notNeeded: true, field: { status: "idle" } });
    await save(s, { notNeeded: true });
  }
  function undoNotNeeded(s: SetupStep) {
    patch(s.secretName, { notNeeded: false, saved: false });
  }

  function edit(s: SetupStep, value: string) {
    // A prior ✓/✗ tested a different id — clear it so nothing claims a stale verification.
    patch(s.secretName, { externalId: value, saved: false, field: { status: "idle" }, saveMsg: undefined });
  }

  function skip(s: SetupStep, idx: number) {
    patch(s.secretName, { skipped: true });
    goNext(idx);
  }

  // ---- deep connection test (CLIENT-WIDE — /conn-test re-queues every system, so this is one
  //      action for the whole client, not per credential) --------------------------------------
  const loadConn = useCallback(async () => {
    try {
      const r = await fetch(`/api/clients/${slug}/conn-test`, { cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setConnError(d.error ?? `failed (${r.status})`); return; }
      const next: Record<string, ConnResult> = {};
      for (const t of (d.tests ?? []) as { systemKey: string; status: ConnResult["status"]; detail: string | null; accessOk: boolean | null; accessDetail: string | null }[]) {
        next[t.systemKey] = { status: t.status, detail: t.detail, accessOk: t.accessOk, accessDetail: t.accessDetail };
      }
      setConn((c) => ({ ...c, ...next }));
    } catch (e) { setConnError((e as Error).message); }
  }, [slug]);

  // Poll while a test is in flight — but bounded by a deadline, so a system whose runner never comes
  // online (a permanently-pending test) can't leave the poll (and the button) stuck forever.
  useEffect(() => {
    if (!connBusy) return;
    const unsettled = Object.values(conn).some((c) => c.status === "pending" || c.status === "running");
    if (!unsettled || Date.now() >= pollDeadline.current) { setConnBusy(false); return; }
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = setTimeout(loadConn, CONN_POLL_MS);
    return () => { if (pollTimer.current) clearTimeout(pollTimer.current); };
  }, [conn, connBusy, loadConn]);

  async function runConnTests() {
    setConnBusy(true); setConnError(null);
    pollDeadline.current = Date.now() + CONN_POLL_DEADLINE_MS;
    // Mark every testable system in-flight so the operator sees motion (the endpoint re-queues them all).
    setConn((c) => {
      const next = { ...c };
      for (const k of Object.keys(next)) if (next[k].status !== "not_needed") next[k] = { status: "running" };
      return next;
    });
    try {
      const r = await fetch(`/api/clients/${slug}/conn-test`, { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setConnError(d.error ?? `failed (${r.status})`); setConnBusy(false); return; }
      if ((d.tests ?? []).length === 0) { setConnError("No testable systems yet — wire a credential first."); setConnBusy(false); return; }
      await loadConn();
    } catch (e) { setConnError((e as Error).message); setConnBusy(false); }
  }

  // ---- render --------------------------------------------------------------------------------
  const stuckSkipped = !allWired && pending.length === 0; // everything left was skipped

  const ConnControl = (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <button onClick={runConnTests} disabled={connBusy} style={{ fontSize: 13 }}>
        {connBusy ? "Testing connections…" : "Run live connection tests"}
      </button>
      <span className="note muted">{verifiedCount} of {counted.length} verified live</span>
      {connError && <span className="note danger">{connError}</span>}
    </div>
  );

  return (
    <main>
      <p className="note"><Link href={`/clients/${slug}`}>← {clientName}</Link></p>
      <div className="row-between" style={{ alignItems: "baseline" }}>
        <h1 style={{ marginBottom: 4 }}>Guided credential setup</h1>
        <span className="note">{wiredCount} of {counted.length} credentials wired</span>
      </div>
      <p className="note" style={{ marginTop: 0 }}>
        One credential at a time — map its Delinea reference and verify the app can read the right fields.
        Stores references only; the value stays in Delinea. A live connection test (needs the matching
        runner online) confirms each one end-to-end.
      </p>
      <ProgressBar ready={wiredCount} total={counted.length} />
      <div style={{ marginTop: 12 }}>{ConnControl}</div>

      {allWired ? (
        <AllSet slug={slug} clientName={clientName} count={counted.length} verified={verifiedCount} connControl={ConnControl} />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 220px) minmax(0, 1fr)", gap: 24, marginTop: 20, alignItems: "start" }}>
          <Rail steps={steps} activeIdx={activeIdx} isWired={isWired} isVerified={isVerified} state={state} onPick={setActiveIdx} />
          <section>
            {stuckSkipped && (
              <p className="note" style={{ border: "1px solid var(--warn-fg)", background: "var(--warn-bg)", color: "var(--warn-fg)", borderRadius: 8, padding: "0.5rem 0.7rem" }}>
                Every remaining credential is skipped. Pick one from the list to finish it, or head back to the client.
              </p>
            )}
            {active && (
              <StepCard
                key={active.secretName}
                slug={slug}
                step={active}
                st={state[active.secretName]}
                connStatus={connStatusFor(active)}
                conn={conn}
                reach={reach}
                wired={isWired(active)}
                delineaConfigured={delineaConfigured}
                write={write}
                onEdit={(v) => edit(active, v)}
                onSaveTest={() => saveAndTest(active)}
                onTest={() => test(active)}
                onMarkNotNeeded={() => markNotNeeded(active)}
                onUndoNotNeeded={() => undoNotNeeded(active)}
                onSkip={() => skip(active, activeIdx)}
                onNext={() => goNext(activeIdx)}
                onCreated={(id) => onCreated(active, id)}
                onPickSuggestion={(id) => onPickSuggestion(active, id)}
              />
            )}
          </section>
        </div>
      )}
    </main>
  );
}

function ProgressBar({ ready, total }: { ready: number; total: number }) {
  const pct = total === 0 ? 100 : Math.round((ready / total) * 100);
  return (
    <div style={{ height: 6, background: "var(--bg-soft)", borderRadius: 999, overflow: "hidden", marginTop: 8, maxWidth: 640 }}>
      <div style={{ height: "100%", width: `${pct}%`, background: "var(--accent)", transition: "width 240ms ease" }} />
    </div>
  );
}

function statusDot(wired: boolean, verified: boolean, active: boolean, skipped: boolean) {
  const color = verified ? "var(--ok-fg)" : wired ? "var(--accent-press, var(--accent))" : skipped ? "var(--muted)" : active ? "var(--accent)" : "var(--line-2)";
  const mark = wired ? "✓" : skipped ? "–" : "•";
  return <span aria-hidden style={{ display: "inline-block", width: 16, textAlign: "center", color, fontWeight: 600 }}>{mark}</span>;
}

function Rail({
  steps, activeIdx, isWired, isVerified, state, onPick,
}: {
  steps: SetupStep[];
  activeIdx: number;
  isWired: (s: SetupStep) => boolean;
  isVerified: (s: SetupStep) => boolean;
  state: Record<string, StepState>;
  onPick: (i: number) => void;
}) {
  return (
    <nav aria-label="Setup steps" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {steps.map((s, i) => {
        const wired = isWired(s);
        const active = i === activeIdx;
        const skipped = !!state[s.secretName]?.skipped && !wired;
        return (
          <button
            key={s.secretName}
            onClick={() => onPick(i)}
            title={s.purpose}
            style={{
              display: "flex", alignItems: "center", gap: 6, textAlign: "left", width: "100%",
              padding: "6px 8px", borderRadius: 6, border: "1px solid transparent",
              background: active ? "var(--accent-soft)" : "transparent",
              color: active ? "var(--fg)" : "var(--muted)", cursor: "pointer", fontSize: 13,
            }}
          >
            {statusDot(wired, isVerified(s), active, skipped)}
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {s.systemNames[0] ?? s.secretName}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

function Badge({ children, color, bg, title }: { children: React.ReactNode; color: string; bg?: string; title?: string }) {
  return <span className="badge" title={title} style={{ color, background: bg, borderColor: "transparent" }}>{children}</span>;
}

function StepCard({
  slug, step, st, connStatus, conn, reach, wired, delineaConfigured, write,
  onEdit, onSaveTest, onTest, onMarkNotNeeded, onUndoNotNeeded, onSkip, onNext, onCreated, onPickSuggestion,
}: {
  slug: string;
  step: SetupStep;
  st: StepState;
  connStatus: "pending" | "running" | "ok" | "fail" | "not_needed" | "untested";
  conn: Record<string, ConnResult>;
  reach?: Record<string, RunnerReach>;
  wired: boolean;
  delineaConfigured: boolean;
  write?: DelineaWriteSummary;
  onEdit: (v: string) => void;
  onSaveTest: () => void;
  onTest: () => void;
  onMarkNotNeeded: () => void;
  onUndoNotNeeded: () => void;
  onSkip: () => void;
  onNext: () => void;
  onCreated: (externalId: string) => void;
  onPickSuggestion: (externalId: string) => void;
}) {
  const hasValue = st.notNeeded || secretIsSet(st.externalId);
  // "Create in Delinea" capability: instance write account + a template for this secret (folder is
  // collected inline). Absent write summary → not available.
  const cap = write ? { hasAccount: write.hasAccount, hasTemplate: write.templates[step.secretName] ?? false, folderId: write.folderId, templateName: write.templateNames[step.secretName] ?? null } : null;
  const canCreate = Boolean(cap && cap.hasAccount && cap.hasTemplate);
  const createReason = cap ? createDisabledReason(cap) : "Delinea write path is not available.";
  // Lead with entering the credentials: a fresh, not-yet-wired step opens straight into the create form
  // so "type the fields → test → write" is the front-and-center path. Paste-an-existing-id stays below.
  const [creating, setCreating] = useState(() => canCreate && !hasValue && !st.notNeeded);

  // "Automatic setup" — the same one-click provisioning flows the client actions menu offers, embedded
  // per step so an operator can run them without leaving the wizard. Which one applies is derived from
  // the step's systems / secret name, exactly as client-actions-menu gates them. Each keeps the modal
  // lifecycle inside its own component (M365/Google run long); we just ping an incrementing openSignal.
  const showM365 = step.systemKeys.some((k) => k === "m365" || k === "entra" || k === "exchange");
  const showGoogle = step.systemKeys.includes("google-workspace");
  const apiEntry = API_SETUP_CATALOG.find((e) => e.secretName === step.secretName && e.autoBrowser);
  const hasAuto = showM365 || showGoogle || Boolean(apiEntry);
  const [m365Signal, setM365Signal] = useState(0);
  const [googleSignal, setGoogleSignal] = useState(0);
  const [apiSignal, setApiSignal] = useState(0);

  // Runner reachability for this step's systems — the "test comms to the runner" signal. Only meaningful
  // for a step that runs on the client's OWN agent (on-prem AD/exchange): a cloud step is served centrally.
  const stepReach = step.systemKeys.map((k) => reach?.[k]).filter((r): r is RunnerReach => !!r);
  const onPremReach = stepReach.filter((r) => r.needsOwnAgent);
  const runnerLine = onPremReach.length > 0
    ? onPremReach.every((r) => r.servable)
      ? { ok: true as const, text: "Runner online for this client — its connection test can run now." }
      : { ok: false as const, text: onPremReach.map((r) => r.reason).find(Boolean) ?? "No runner online for this client — its connection test can't run until one connects." }
    : null;
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "1.1rem 1.2rem" }}>
      <div className="row-between" style={{ alignItems: "baseline" }}>
        <div>
          <h2 style={{ margin: 0 }}>{step.systemNames[0] ?? step.secretName}</h2>
          <p className="note" style={{ margin: "2px 0 0" }}>{step.purpose}</p>
        </div>
        {connStatus === "ok"
          ? <Badge color="var(--ok-fg)" bg="var(--ok-bg)" title="Live connection test passed">✓ verified live</Badge>
          : wired
          ? <Badge color="var(--accent-press, var(--accent))" bg="var(--accent-soft)" title="Reference is wired; run the live connection test to verify end-to-end">✓ wired</Badge>
          : <code style={{ color: "var(--muted)" }}>{step.secretName}</code>}
      </div>

      {st.notNeeded ? (
        <div style={{ marginTop: 16 }}>
          <p className="note">Marked as a manual step — no credential required, won&rsquo;t block a case.</p>
          <button onClick={onUndoNotNeeded}>This credential is needed</button>
        </div>
      ) : (
        <>
          {/* Vendor setup guide — from step.help (computed at build time from the client-level
              referencedBy, so a hybrid M365 client gets the right hybrid guide). */}
          {step.help ? (
            <div style={{ marginTop: 14 }}>
              <div className="note" style={{ marginBottom: 2 }}>Set this up at the vendor first:</div>
              <a href={step.help.href} target="_blank" rel="noreferrer" style={{ fontSize: 13 }}
                 title={`Setup guide: ${step.help.kind} — shows exactly what to set up for this client`}>
                {step.help.kind} — setup guide ↗
              </a>
            </div>
          ) : (
            <p className="note" style={{ marginTop: 14 }}>Plain username + password credential — no extra vendor setup.</p>
          )}

          {/* Runner comms — for on-prem steps, whether the client's own agent is reachable to test this
              credential (the app can't bind AD itself, so a reachable runner IS the pre-write signal). */}
          {runnerLine && (
            <p
              className="note"
              style={{
                marginTop: 12,
                border: "1px solid var(--line-2)",
                borderRadius: 8,
                padding: "0.45rem 0.65rem",
                color: runnerLine.ok ? "var(--ok-fg)" : "var(--warn-fg)",
                background: runnerLine.ok ? "var(--ok-bg)" : "var(--warn-bg)",
              }}
            >
              {runnerLine.ok ? "✓ " : "⚠ "}{runnerLine.text}
            </p>
          )}

          {/* Exact fields to collect */}
          {step.fieldRequirements.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div className="note" style={{ marginBottom: 6 }}>The Delinea secret must carry these fields:</div>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {step.fieldRequirements.map((f) => {
                  const missing = st.field.status === "ok" && st.field.missingFields?.includes(f.label);
                  return (
                    <li key={f.label} style={{ fontSize: 13, color: missing ? "var(--warn-fg)" : "var(--fg)", marginBottom: f.hint ? 4 : 0 }}>
                      {f.label}
                      {f.optional && <span className="muted"> (optional)</span>}
                      <span className="muted" style={{ fontSize: 11 }}> — e.g. {f.anyOf.slice(0, 3).join(" / ")}</span>
                      {f.hint && <span className="muted" style={{ display: "block", fontSize: 11 }}>{f.hint}</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* AUTOMATIC path — the one-click provisioning flow for this system (the same modals the client
              actions menu drives). Sits above the manual "type it" form so the fastest route leads. Each
              flow owns its own dialog; the inline button just pings an incrementing openSignal. */}
          {hasAuto && (
            <div style={{ marginTop: 16, border: "1px solid var(--line)", borderRadius: 8, padding: "0.8rem 0.9rem" }}>
              <div className="note" style={{ marginBottom: 6 }}>
                <b>Automatic setup</b> — let the runner provision + vault this credential for you.
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {showM365 && (
                  <button onClick={() => setM365Signal((n) => n + 1)}
                    title="Automatically create + configure this client's iam-engine M365 app registration and vault the credential">
                    Set up M365 automatically
                  </button>
                )}
                {showGoogle && (
                  <button onClick={() => setGoogleSignal((n) => n + 1)}
                    title="Automatically create this client's Google service account, grant domain-wide delegation, and vault the credential">
                    Set up Google Workspace automatically
                  </button>
                )}
                {apiEntry && (
                  <button onClick={() => setApiSignal((n) => n + 1)}
                    title={`Guided setup for the ${apiEntry.label} API credential — the runner drives the console`}>
                    Set up {apiEntry.label} automatically
                  </button>
                )}
              </div>
              {/* Always-mounted dialogs (hideTrigger) — each owns its lifecycle so its live status survives
                  the button click; opened only when its signal increments. */}
              {showM365 && <M365SetupButton slug={slug} openSignal={m365Signal} hideTrigger />}
              {showGoogle && <GoogleSetupButton slug={slug} openSignal={googleSignal} hideTrigger />}
              {apiEntry && <GuidedApiSetup slug={slug} entry={apiEntry} openSignal={apiSignal} hideTrigger />}
            </div>
          )}

          {/* PRIMARY path — enter the credential's fields, test them, and create it in Delinea. Opens by
              default for a fresh (not-yet-wired) step so the walkthrough leads with entering credentials. */}
          {cap && creating && (
            <div style={{ marginTop: 16 }}>
              <CreateInDelineaForm
                slug={slug}
                secretName={step.secretName}
                fieldRequirements={step.fieldRequirements}
                capability={cap}
                onCreated={(id) => { setCreating(false); onCreated(id); }}
                onCancel={() => setCreating(false)}
              />
            </div>
          )}

          {/* SECONDARY path — already have a Delinea secret id? paste it. Also hosts Save / Not-needed and
              the toggle that (re)opens the create form. */}
          <div style={{ marginTop: 16 }}>
            <label className="note" htmlFor={`sec-${step.secretName}`} style={{ display: "block", marginBottom: 4 }}>
              {creating ? <>Or, if you already have one, paste its Delinea secret id</> : <>Delinea secret id for <code>{step.secretName}</code></>}
            </label>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input
                id={`sec-${step.secretName}`}
                value={st.externalId}
                onChange={(e) => onEdit(e.target.value)}
                placeholder="e.g. 4821"
                style={{ width: 180, fontFamily: "var(--mono, monospace)" }}
              />
              <button className="primary" onClick={onSaveTest} disabled={!hasValue}>
                {delineaConfigured ? "Save and test" : "Save"}
              </button>
              <button onClick={onMarkNotNeeded} style={{ fontSize: 13 }} title="Its module is handled as a manual step — won't block a case">
                Mark not needed
              </button>
              {!creating && (
                <button
                  onClick={() => setCreating(true)}
                  disabled={!canCreate}
                  title={canCreate ? "Enter the credential's fields; the app tests them and creates the secret in Delinea" : createReason ?? undefined}
                  style={{ fontSize: 13 }}
                >
                  Enter credentials &amp; create…
                </button>
              )}
              {st.saved === false && <span className="note muted">unsaved</span>}
            </div>
            {/* 🔎 Suggest from Delinea — pick an EXISTING secret from this client's folders; wired + tested
                through the same PUT /secrets + field-shape check the paste box uses. */}
            <DelineaSuggestions slug={slug} secretName={step.secretName} onPick={onPickSuggestion} />
            {st.saveMsg && <p className="note danger" style={{ marginTop: 6 }}>{st.saveMsg}</p>}
          </div>

          {/* App-side field-shape result */}
          <div style={{ marginTop: 12, minHeight: 22 }}>
            {st.field.status === "testing" && <span className="note">Testing the reference…</span>}
            {st.field.status === "ok" && (st.field.missingFields && st.field.missingFields.length > 0
              ? <Badge color="var(--warn-fg)" bg="var(--warn-bg)" title={`Reads OK, but the connector needs: ${st.field.missingFields.join(", ")}`}>⚠ reads ok — add: {st.field.missingFields.join(", ")}</Badge>
              : <Badge color="var(--ok-fg)" bg="var(--ok-bg)" title={st.field.label}>✓ reads ok{st.field.label ? ` — ${st.field.label}` : ""}</Badge>)}
            {st.field.status === "fail" && <Badge color="var(--err-fg)" bg="var(--err-bg)" title={st.field.error}>✗ {st.field.error ?? "could not read"}</Badge>}
            {st.field.status === "idle" && hasValue && st.saved && <button onClick={onTest} disabled={!delineaConfigured} style={{ fontSize: 13 }}>Test reference</button>}
          </div>

          {/* Live connection verdict (read-only here — the test itself is the client-wide control up top) */}
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--line-2)" }}>
            <div className="note" style={{ marginBottom: 6 }}>Live connection (verified via “Run live connection tests” above):</div>
            {connStatus === "ok" && <Badge color="var(--ok-fg)" bg="var(--ok-bg)">✓ live read succeeded</Badge>}
            {connStatus === "fail" && <Badge color="var(--err-fg)" bg="var(--err-bg)">✗ live read failed</Badge>}
            {connStatus === "running" && <span className="note">waiting for a runner to connect…</span>}
            {(connStatus === "pending" || connStatus === "untested") && <span className="note muted">not verified yet — needs the matching runner online</span>}
            {(connStatus === "running" || connStatus === "fail") && (
              <table style={{ marginTop: 8 }}>
                <tbody>
                  {step.systemKeys.map((k) => {
                    const c = conn[k];
                    const detail = c?.accessOk === false ? c?.accessDetail : c?.detail;
                    return (
                      <tr key={k}>
                        <td style={{ fontSize: 13 }}>{k}</td>
                        <td className="muted" style={{ fontSize: 13, whiteSpace: "normal", maxWidth: 340 }}>{detail ?? (c?.status ?? "—")}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Step navigation */}
          <div className="dialog-actions" style={{ justifyContent: "flex-start", marginTop: 18 }}>
            {wired ? <button className="primary" onClick={onNext}>Next credential →</button> : <button onClick={onSkip}>Skip for now</button>}
          </div>
        </>
      )}
    </div>
  );
}

function AllSet({ slug, clientName, count, verified, connControl }: { slug: string; clientName: string; count: number; verified: number; connControl: React.ReactNode }) {
  const fullyVerified = verified >= count;
  return (
    <div style={{ border: "1px solid var(--ok-fg)", background: "var(--ok-bg)", borderRadius: 10, padding: "1.4rem 1.5rem", marginTop: 20, maxWidth: 640 }}>
      <h2 style={{ marginTop: 0, color: "var(--ok-fg)" }}>✓ All credentials wired</h2>
      <p className="note" style={{ color: "var(--ok-fg)" }}>
        Every credential {clientName} needs is wired across {count} credential{count === 1 ? "" : "s"}.
        {fullyVerified
          ? " All are verified with a live connection test — the client reads fully ready."
          : ` ${verified} of ${count} verified with a live connection test. Run the tests to confirm the rest end-to-end (the client's readiness reflects the live result).`}
      </p>
      {!fullyVerified && <div style={{ margin: "8px 0 4px" }}>{connControl}</div>}
      <div className="dialog-actions" style={{ justifyContent: "flex-start", marginTop: 8 }}>
        <Link href={`/clients/${slug}`}><button className="primary">Back to {clientName}</button></Link>
      </div>
    </div>
  );
}
