"use client";

// Live connection / permission preflight. "Test connections" queues a probe per cloud/on-prem
// system; the runner connects with the brokered credential, does one read, and reports back. This
// panel polls the results until every test settles. Four stages per system: Fields (app-side —
// does the secret read + carry the right fields, stamped at queue time), Can access (runner
// resolved the secret), API works (connect + one live read), Rights (per-operation permission
// check where the probe supports it). Per-row "Retest" replaces only that system's row.
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { summarizeRights, type RightsRow } from "@/lib/jobs/conn-test-logic";

type Test = {
  systemKey: string;
  status: "pending" | "running" | "ok" | "fail";
  detail: string | null;
  accessOk: boolean | null;
  accessDetail: string | null;
  fieldsOk: boolean | null;
  fieldsDetail: string | null;
  rights: RightsRow[] | null;
  credExpiresAt: string | null;
  onPrem: boolean;
  finishedAt: string | null;
};

// Stage 0 — app-side: the secret resolves and carries the fields its connector needs.
function fieldsBadge(t: Test): { text: string; color: string } {
  if (t.fieldsOk === true) return { text: "✓ fields ok", color: "#15803d" };
  if (t.fieldsOk === false) return { text: "✗ fields", color: "#b91c1c" };
  return { text: "—", color: "var(--muted)" }; // preflight not run (Delinea unconfigured / older row)
}
// Stage 1 — can the runner RESOLVE the secret from Delinea.
function accessBadge(t: Test): { text: string; color: string } {
  if (t.accessOk === true) return { text: "✓ resolved", color: "#15803d" };
  if (t.accessOk === false) return { text: "✗ no access", color: "#b91c1c" };
  if (t.status === "running") return { text: "testing…", color: "#92400e" };
  if (t.status === "pending") return { text: "queued", color: "var(--muted)" };
  return { text: "—", color: "var(--muted)" }; // older runner didn't report the stage
}
// Stage 2 — connect + one live read against the vendor API.
function apiBadge(t: Test): { text: string; color: string } {
  if (t.accessOk === false) return { text: "— skipped", color: "var(--muted)" };
  if (t.status === "ok") return { text: "✓ read ok", color: "#15803d" };
  if (t.status === "fail") return { text: "✗ failed", color: "#b91c1c" };
  if (t.status === "running") return { text: "testing…", color: "#92400e" };
  return { text: "queued", color: "var(--muted)" };
}
// Stage 3 — per-operation rights, where the probe can verify them. A missing OPTIONAL permission is
// appended as a muted note (e.g. "+1 optional"), never as its own failing badge.
//
// `surplus` is the reverse finding — permissions the credential holds that we never use. It rides in
// as optional rows, so it must be named separately: "+3 optional" about permissions there are too
// MANY of would read as the exact opposite of the truth. It never colours the badge (a green
// credential that also has too much authority is still green: it works — the surplus is the client's
// call, and the detail rows say what each one permits).
function rightsBadge(t: Test): { text: string; color: string } {
  const s = summarizeRights(t.rights);
  if (s.state === "unknown") return { text: "—", color: "var(--muted)" };
  const opt = s.optionalMissing > 0 ? ` +${s.optionalMissing} optional` : "";
  // Extra Access = over-permissioned (the reverse finding from a missing optional). Never blocking —
  // it rides beside the badge's own color, which is still driven only by the required ops below.
  // When any surplus row is an escalation risk (e.g. could self-assign Global Admin), call that out.
  const extra =
    s.surplus > 0 ? ` · Extra Access: ${s.surplus}${s.escalation > 0 ? ` (${s.escalation} risky)` : ""}` : "";
  if (s.state === "verified") return { text: `✓ ${s.total}/${s.total} ops${opt}${extra}`, color: "#15803d" };
  if (s.state === "missing") return { text: `✗ missing ${s.missing}${opt}${extra}`, color: "#b91c1c" };
  return { text: `? ${s.unverified} unverified${opt}${extra}`, color: "#92400e" };
}

export function ConnectionTestPanel({ slug, systemNames }: { slug: string; systemNames: Record<string, string> }) {
  const [tests, setTests] = useState<Test[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [retesting, setRetesting] = useState<string | null>(null);
  const [openRights, setOpenRights] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/clients/${slug}/conn-test`, { cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error ?? `failed (${r.status})`); return; }
      setTests(d.tests ?? []);
    } catch (e) { setError((e as Error).message); }
  }, [slug]);

  // Poll while anything is unsettled; stop once all tests are ok/fail.
  useEffect(() => {
    if (!tests) return;
    const pending = tests.some((t) => t.status === "pending" || t.status === "running");
    if (timer.current) clearTimeout(timer.current);
    if (pending) timer.current = setTimeout(load, 3000);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [tests, load]);

  // The secrets panel dispatches this after "Save & test" so freshly queued rows show up here.
  useEffect(() => {
    const onQueued = () => { void load(); };
    window.addEventListener("iam:conn-test-queued", onQueued);
    return () => window.removeEventListener("iam:conn-test-queued", onQueued);
  }, [load]);

  async function run() {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/clients/${slug}/conn-test`, { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error ?? `failed (${r.status})`); return; }
      if ((d.tests ?? []).length === 0) { setTests([]); setError("No testable systems — add an api system with a wired secret first."); return; }
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function retest(systemKey: string) {
    setRetesting(systemKey); setError(null);
    try {
      // deep: an operator explicitly testing ONE system is the only thing that may run an interactive
      // probe (e.g. actually signing in to Spanning's console in a browser). Save-and-test and the
      // whole-client / fleet runs deliberately don't — one scripted M365 sign-in per client per sweep
      // is the burst that risk-based Conditional Access starts challenging.
      const r = await fetch(`/api/clients/${slug}/conn-test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ systemKey, deep: true }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error ?? `failed (${r.status})`); return; }
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setRetesting(null); }
  }

  return (
    <div style={{ marginTop: "0.6rem" }}>
      <div className="toolbar">
        <button className="primary" onClick={run} disabled={busy}>{busy ? "Queuing…" : "Test connections"}</button>
        <span className="note">Connects to each system with its credential and does one read — proves real access, not just that the secret resolves. Needs the matching runner online (cloud → central; on-prem → the client agent).</span>
      </div>
      {error && <p className="note danger">{error}</p>}
      {tests && tests.length > 0 && (
        <table style={{ marginTop: "0.5rem" }}>
          <thead><tr>
            <th>System</th><th>Where</th>
            <th title="App-side: does the secret resolve and carry the fields its connector needs?">Fields</th>
            <th title="Can the runner resolve the secret from Delinea?">Can access</th>
            <th title="Does connecting + one live read against the vendor API work?">API works</th>
            <th title="Per-operation permission check, where the system's probe can verify it">Rights</th>
            <th>Detail</th>
            <th></th>
          </tr></thead>
          <tbody>
            {tests.map((t) => {
              const flds = fieldsBadge(t);
              const acc = accessBadge(t);
              const api = apiBadge(t);
              const rts = rightsBadge(t);
              const hasRights = Boolean(t.rights && t.rights.length > 0);
              // Show the failing stage's detail; else the API detail (the live read result).
              const detail = t.fieldsOk === false ? t.fieldsDetail : t.accessOk === false ? t.accessDetail : t.detail;
              return (
                <Fragment key={t.systemKey}>
                  <tr>
                    <td>{systemNames[t.systemKey] ?? t.systemKey}</td>
                    <td className="muted">{t.onPrem ? "client agent" : "central runner"}</td>
                    <td><span className="badge" style={{ color: flds.color }} title={t.fieldsDetail ?? undefined}>{flds.text}</span></td>
                    <td><span className="badge" style={{ color: acc.color }} title={t.accessDetail ?? undefined}>{acc.text}</span></td>
                    <td><span className="badge" style={{ color: api.color }} title={t.detail ?? undefined}>{api.text}</span></td>
                    <td>
                      {hasRights ? (
                        <button
                          className="linklike"
                          style={{ color: rts.color, background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit" }}
                          onClick={() => setOpenRights(openRights === t.systemKey ? null : t.systemKey)}
                          title="Show per-operation results"
                        >
                          {rts.text} {openRights === t.systemKey ? "▴" : "▾"}
                        </button>
                      ) : (
                        <span className="badge" style={{ color: rts.color }}>{rts.text}</span>
                      )}
                    </td>
                    <td className="muted" style={{ maxWidth: 300, whiteSpace: "normal" }}>{detail ?? (t.status === "pending" ? "waiting for a runner to claim it…" : t.status === "running" ? "testing…" : "")}</td>
                    <td>
                      <button onClick={() => retest(t.systemKey)} disabled={retesting !== null || busy || t.status === "pending" || t.status === "running"}>
                        {retesting === t.systemKey ? "Queuing…" : "Retest"}
                      </button>
                    </td>
                  </tr>
                  {hasRights && openRights === t.systemKey && (
                    <tr>
                      <td colSpan={8} style={{ background: "var(--panel, transparent)" }}>
                        <table style={{ margin: "0.3rem 0 0.3rem 1rem", width: "auto" }}>
                          <tbody>
                            {(t.rights ?? []).map((r) => {
                              // Extra Access rows (surplus=true) are the OPPOSITE finding from a missing
                              // optional permission — the credential HAS this and we never use it — so
                              // they get their own mark/chip, never the "○ (optional)" missing styling.
                              // An escalation risk (e.g. can self-assign Global Admin) is a stronger
                              // warning; a benign unused grant is muted.
                              if (r.surplus) {
                                const mark = r.escalation ? "⚠" : "＋";
                                const color = r.escalation ? "#b45309" : "var(--muted)";
                                return (
                                  <tr key={r.op}>
                                    <td style={{ paddingRight: "0.8rem" }}>
                                      <span style={{ color }}>{mark}</span> {r.op}
                                      <span
                                        className={r.escalation ? undefined : "muted"}
                                        style={{ fontSize: 11, marginLeft: 6, color: r.escalation ? color : undefined, fontWeight: r.escalation ? 600 : undefined }}
                                      >
                                        {r.escalation ? "Extra Access — risk" : "Extra Access · unused"}
                                      </span>
                                    </td>
                                    <td className="muted" style={{ whiteSpace: "normal" }}>{r.detail}</td>
                                  </tr>
                                );
                              }
                              // A missing optional permission is amber "○" (a note), not red "✗" — it
                              // does not fail the test, so it must not read like a failure.
                              const optMiss = r.optional && r.ok === false;
                              const mark = r.ok === true ? "✓" : optMiss ? "○" : r.ok === false ? "✗" : "?";
                              const color = r.ok === true ? "#15803d" : optMiss ? "#92400e" : r.ok === false ? "#b91c1c" : "#92400e";
                              return (
                                <tr key={r.op}>
                                  <td style={{ paddingRight: "0.8rem" }}>
                                    <span style={{ color }}>{mark}</span> {r.op}
                                    {r.optional && <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>(optional)</span>}
                                  </td>
                                  <td className="muted" style={{ whiteSpace: "normal" }}>{r.detail}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
