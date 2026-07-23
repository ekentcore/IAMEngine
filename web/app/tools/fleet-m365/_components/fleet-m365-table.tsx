"use client";

// The Fleet Setup — M365 table. On mount it starts (or rejoins) a fleet connection-test sweep and
// polls the roll-up; each client is one row showing its M365 credential health, with an expandable
// per-system rights breakdown and an in-place fix (Correct permissions / Set up M365 / Adjust). The
// fixes reuse the shared M365SetupButton modal — a single instance, keyed to the selected client, so
// "Correct permissions" opens it preconfigured (keep the secret, pre-check the missing optional roles)
// and every client (even a healthy one) can still be worked through.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { M365SetupButton } from "@/app/clients/_components/m365-setup-button";
import { parseRights, type RightsRow } from "@/lib/jobs/conn-test-logic";
import type { FleetM365Rollup, FleetM365Row, FleetM365Tag } from "@/lib/jobs/fleet-m365-test";

// The filterable states, in the order the chips appear — with a human label. `untested` is offered
// too so an operator can find rows that haven't run yet.
const STATE_FILTERS: { tag: FleetM365Tag; label: string }[] = [
  { tag: "missing_perms", label: "Missing permissions" },
  { tag: "no_creds", label: "Missing credentials" },
  { tag: "over_permissioned", label: "Over-permissioned" },
  { tag: "connection_failed", label: "Connection failed" },
  { tag: "completed", label: "Completed" },
  { tag: "untested", label: "Untested" },
];

function statusBadge(row: FleetM365Row): { text: string; color: string } {
  switch (row.status) {
    case "ok":
      return { text: "✓ healthy", color: "#15803d" };
    case "fail":
      return row.tags.includes("missing_perms")
        ? { text: `✗ missing ${row.missingPerms} perm${row.missingPerms === 1 ? "" : "s"}`, color: "#b91c1c" }
        : { text: "✗ connection failed", color: "#b91c1c" };
    case "unverified":
      return { text: "? unverified", color: "#92400e" };
    case "running":
      return { text: "testing…", color: "#92400e" };
    case "untested":
      return row.tags.includes("no_creds")
        ? { text: "no credential", color: "var(--muted)" }
        : { text: "not tested yet", color: "var(--muted)" };
    default:
      return { text: row.status, color: "var(--muted)" };
  }
}

export function FleetM365Table({ initial }: { initial: FleetM365Rollup }) {
  const [rollup, setRollup] = useState<FleetM365Rollup>(initial);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedStates, setSelectedStates] = useState<Set<FleetM365Tag>>(new Set());
  const [openRights, setOpenRights] = useState<string | null>(null);
  const [retesting, setRetesting] = useState<string | null>(null);
  const [selfGranting, setSelfGranting] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedOnMount = useRef(false);

  // The single reused setup modal, targeted at the selected row and opened via a signal counter.
  const [target, setTarget] = useState<{ slug: string; presetOptionalRoles?: string[]; presetForceRotate?: boolean } | null>(null);
  const [openSignal, setOpenSignal] = useState(0);

  const rows = rollup.rows;

  // When a fix finishes, M365SetupButton calls router.refresh(), which re-runs the server page and
  // hands us a fresh `initial`. Sync it in so the table reflects the corrected client without a manual
  // reload. `initial` only changes identity on a server re-render (refresh / navigation), so this
  // can't loop against our own polling setState.
  useEffect(() => { setRollup(initial); }, [initial]);

  const load = useCallback(async (): Promise<FleetM365Rollup | null> => {
    try {
      const r = await fetch("/api/tools/fleet-m365", { cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error ?? `failed (${r.status})`); return null; }
      setRollup(d);
      return d;
    } catch (e) { setError((e as Error).message); return null; }
  }, []);

  const start = useCallback(async () => {
    setStarting(true); setError(null);
    try {
      const r = await fetch("/api/tools/fleet-m365", { method: "POST" });
      const d = await r.json().catch(() => ({}));
      // 409 = a sweep is already running (started elsewhere / a reload) — not an error, just rejoin it.
      if (!r.ok && r.status !== 409) { setError(d.reason ?? d.error ?? `failed (${r.status})`); return; }
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setStarting(false); }
  }, [load]);

  // On mount: rejoin a running sweep; otherwise only kick one off the FIRST time (no sweep has ever
  // run). Results are stored durably in ConnectionTest, so returning to the page shows the last scan
  // instantly and does NOT re-test everything — the operator retests on demand ("Retest all" / a row's
  // "Retest").
  useEffect(() => {
    if (startedOnMount.current) return;
    startedOnMount.current = true;
    if (rollup.run?.status === "running") void load();
    else if (!rollup.run) void start();
  }, [rollup.run, load, start]);

  // Poll while the sweep is running OR any row is still settling (covers per-row / retest-all too).
  useEffect(() => {
    const unsettled = rollup.run?.status === "running" || rows.some((r) => r.status === "running");
    if (timer.current) clearTimeout(timer.current);
    if (unsettled) timer.current = setTimeout(() => void load(), 3000);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [rollup, rows, load]);

  // Precompute a per-row search haystack once (name / CORE id / domain-ish / systems), like the
  // clients explorer — filtering is then synchronous per keystroke.
  const haystacks = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) m.set(r.slug, [r.name, r.coreId, r.slug, r.systems.join(" ")].join(" ").toLowerCase());
    return m;
  }, [rows]);

  const counts = useMemo(() => {
    const c = new Map<FleetM365Tag, number>();
    for (const f of STATE_FILTERS) c.set(f.tag, rows.filter((r) => r.tags.includes(f.tag)).length);
    return c;
  }, [rows]);

  const terms = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query]);
  const visible = useMemo(() => {
    return rows.filter((r) => {
      const hay = haystacks.get(r.slug) ?? "";
      if (terms.length && !terms.every((t) => hay.includes(t))) return false;
      if (selectedStates.size && ![...selectedStates].some((s) => r.tags.includes(s))) return false;
      return true;
    });
  }, [rows, haystacks, terms, selectedStates]);

  function toggleState(tag: FleetM365Tag) {
    setSelectedStates((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag); else next.add(tag);
      return next;
    });
  }

  // Open the setup modal for a row. Correct = keep the secret, pre-check exactly the missing optional
  // roles. Setup / Adjust = the modal's own defaults (all optional on, no rotate).
  function openFix(row: FleetM365Row) {
    if (row.action === "correct") {
      setTarget({ slug: row.slug, presetForceRotate: false, presetOptionalRoles: row.missingOptionalRoles });
    } else {
      setTarget({ slug: row.slug });
    }
    setOpenSignal((n) => n + 1);
  }

  function actionLabel(row: FleetM365Row): string {
    if (row.action === "setup") return "Set up M365";
    if (row.action === "correct") return "Correct permissions";
    return "Adjust";
  }

  // Retest just this client's M365 systems. It goes pending → running, and the poll loop (which runs
  // while any row is running) picks up the settled result.
  async function retestRow(row: FleetM365Row) {
    setRetesting(row.slug); setError(null);
    try {
      const r = await fetch("/api/tools/fleet-m365", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: row.slug }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.reason ?? d.error ?? `failed (${r.status})`); return; }
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setRetesting(null); }
  }

  // Self-grant: use the client's own AppRoleAssignment.ReadWrite.All to assign the missing Graph roles
  // (no Global Admin). On success, retest the row so its state re-verifies. Surplus roles are left
  // marked — this only adds.
  async function selfGrant(row: FleetM365Row) {
    setSelfGranting(row.slug); setError(null); setFlash(null);
    try {
      const r = await fetch("/api/tools/fleet-m365", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: row.slug, selfGrant: true, optionalRoles: row.missingOptionalRoles }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(`${row.name}: ${d.reason ?? d.error ?? `failed (${r.status})`}`); return; }
      const n = d.granted?.length ?? 0;
      const failed = d.failed?.length ?? 0;
      setFlash(`${row.name}: granted ${n} permission${n === 1 ? "" : "s"}${failed ? `, ${failed} failed — check the run log` : ""}. Retesting…`);
      await retestRow(row); // re-verify against the tenant
    } catch (e) { setError((e as Error).message); }
    finally { setSelfGranting(null); }
  }

  const running = rollup.run?.status === "running";

  // Stop a stuck/unwanted sweep: cancel the run (deletes its still-pending tests) so the top button
  // frees immediately instead of waiting out the stale timeout.
  async function stop() {
    setStarting(true); setError(null);
    try {
      await fetch("/api/tools/fleet-m365", { method: "DELETE" });
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setStarting(false); }
  }

  return (
    <div style={{ marginTop: "0.6rem" }}>
      <div className="toolbar">
        <button className="primary" onClick={() => void start()} disabled={starting || running}>
          {starting ? "Starting…" : running ? "Testing…" : "Retest all"}
        </button>
        {running && (
          <button onClick={() => void stop()} disabled={starting} title="Stop the current sweep (frees the button; per-client Retest still works)">
            Stop
          </button>
        )}
        <span className="note">
          {running
            ? `Testing ${rollup.run?.clients ?? 0} clients… results fill in below.`
            : rollup.run
            ? `Last swept ${rollup.run.clients} client${rollup.run.clients === 1 ? "" : "s"}.`
            : "No sweep has run yet."}
        </span>
        <span className="grow" />
        <span className="note result-count">{visible.length} of {rows.length}</span>
      </div>

      {error && <p className="note danger">{error}</p>}
      {flash && <p className="note" style={{ color: "#15803d" }}>{flash}</p>}

      <div className="filters" style={{ marginTop: "0.5rem" }}>
        <div className="search-field">
          <span className="search-icon" aria-hidden>⌕</span>
          <input
            className="search"
            placeholder="Search name, CORE id, system…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
          {query && <button type="button" className="search-clear" aria-label="Clear search" onClick={() => setQuery("")}>×</button>}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {STATE_FILTERS.map((f) => {
            const on = selectedStates.has(f.tag);
            const n = counts.get(f.tag) ?? 0;
            return (
              <button
                key={f.tag}
                type="button"
                className={`badge${on ? " active" : ""}`}
                style={{ cursor: "pointer", opacity: n === 0 && !on ? 0.5 : 1 }}
                aria-pressed={on}
                onClick={() => toggleState(f.tag)}
                title={`${f.label} — ${n}`}
              >
                {f.label} ({n})
              </button>
            );
          })}
          {selectedStates.size > 0 && (
            <button type="button" className="linklike" onClick={() => setSelectedStates(new Set())}>clear</button>
          )}
        </div>
      </div>

      <div className="table-scroll">
        <table className="data-table" style={{ marginTop: "0.6rem" }}>
          <thead>
            <tr>
              <th>Client</th>
              <th>Systems</th>
              <th>Status</th>
              <th>Rights</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr><td colSpan={5}><div className="empty-state">No clients match.{(query || selectedStates.size) ? <> <button type="button" className="linklike" onClick={() => { setQuery(""); setSelectedStates(new Set()); }}>Clear filters</button></> : null}</div></td></tr>
            )}
            {visible.map((row) => {
              const sb = statusBadge(row);
              const canExpand = row.missingPerms > 0 || row.surplus > 0;
              const rightsText = row.surplus > 0
                ? `Extra access: ${row.surplus}${row.escalation > 0 ? ` (${row.escalation} risky)` : ""}`
                : row.missingPerms > 0
                ? `missing ${row.missingPerms}`
                : row.status === "ok"
                ? "ok"
                : "—";
              return (
                <Fragment key={row.slug}>
                  <tr>
                    <td>
                      <a href={`/clients/${row.slug}`}>{row.name}</a>
                      <div className="note mono" style={{ fontSize: 11 }}>{row.coreId}</div>
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>{row.systems.join(", ")}</td>
                    <td><span className="badge" style={{ color: sb.color }}>{sb.text}</span></td>
                    <td>
                      {canExpand ? (
                        <button
                          className="linklike"
                          style={{ color: row.surplus > 0 && row.missingPerms === 0 ? "#b45309" : row.missingPerms > 0 ? "#b91c1c" : "#15803d", background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit" }}
                          onClick={() => setOpenRights(openRights === row.slug ? null : row.slug)}
                        >
                          {rightsText} {openRights === row.slug ? "▴" : "▾"}
                        </button>
                      ) : (
                        <span className="muted" style={{ fontSize: 12 }}>{rightsText}</span>
                      )}
                    </td>
                    <td className="row-actions">
                      {(() => {
                        // Before a result exists we don't yet know whether this client needs a
                        // correction — so the action is disabled and says so. no_creds is the
                        // exception: no credential is a known state regardless of testing, so its
                        // "Set up M365" stays active. A row mid-test shows a disabled "Testing…".
                        const untested = row.tags.includes("untested");
                        const testingNow = row.status === "running" || retesting === row.slug;
                        if (selfGranting === row.slug) return <button disabled>Granting…</button>;
                        if (testingNow) return <button disabled>Testing…</button>;
                        if (untested) return <button disabled title="Run the connection test first to see what this client needs">Not tested yet</button>;
                        // A client that holds AppRoleAssignment.ReadWrite.All AND is missing anything —
                        // a required OR an optional permission — can grant its own gaps with no Global
                        // Admin. Show the self-grant button regardless of the primary action: a client
                        // whose required perms are all covered but that's short some optional caps still
                        // gets a way to top them up. Label reflects whether required perms are at stake.
                        if (row.canSelfGrant) {
                          return (
                            <button
                              className="primary"
                              onClick={() => void selfGrant(row)}
                              title="Grant the missing permissions (required + optional) using the app's own AppRoleAssignment.ReadWrite.All — no Global Admin sign-in. Surplus roles stay flagged, not removed."
                            >
                              {row.missingPerms > 0 ? "Correct permissions" : "Grant missing permissions"}
                            </button>
                          );
                        }
                        return (
                          <button
                            className={row.action === "none" ? undefined : "primary"}
                            onClick={() => openFix(row)}
                            title={row.action === "correct" ? "Reconcile the missing permissions, keeping the existing secret" : row.action === "setup" ? "Provision this client's M365 app registration + credential" : "Open the setup modal to adjust permissions"}
                          >
                            {actionLabel(row)}
                          </button>
                        );
                      })()}
                      {/* Retest just this client. Hidden for no_creds (nothing wired to test). */}
                      {!row.tags.includes("no_creds") && (
                        <button
                          className="btn-quiet"
                          style={{ marginLeft: 6 }}
                          onClick={() => void retestRow(row)}
                          // Enabled even when the row shows "testing" — a test stuck pending (no runner
                          // yet) must still be re-kickable. Only blocked while THIS row's retest is in
                          // flight.
                          disabled={retesting === row.slug}
                          title="Re-run the connection test for this client"
                        >
                          {retesting === row.slug ? "Retesting…" : "Retest"}
                        </button>
                      )}
                    </td>
                  </tr>
                  {canExpand && openRights === row.slug && <RightsDetail slug={row.slug} />}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Single reused setup modal, remounted per target so each open starts from that client's own
          state, then reopened via the signal for the same client. */}
      {target && (
        <M365SetupButton
          key={target.slug}
          slug={target.slug}
          hideTrigger
          openSignal={openSignal}
          presetOptionalRoles={target.presetOptionalRoles}
          presetForceRotate={target.presetForceRotate}
        />
      )}
    </div>
  );
}

// Per-client rights breakdown, fetched on expand from the same per-client conn-test endpoint the
// client page uses — so the fleet table shows the exact per-operation detail without duplicating it.
// Group systems whose rights are identical (m365 + entra share one app registration) so the expanded
// list shows each distinct permission set once, labelled with every system it covers. Order is
// preserved by first appearance.
function dedupeRightsBySystem(tests: { systemKey: string; rights: RightsRow[] | null }[]): { systemKeys: string[]; rights: RightsRow[] | null }[] {
  const groups: { key: string; systemKeys: string[]; rights: RightsRow[] | null }[] = [];
  for (const t of tests) {
    const fp = JSON.stringify((t.rights ?? []).map((r) => [r.op, r.ok, r.optional ?? false, r.surplus ?? false, r.escalation ?? false]));
    const existing = groups.find((g) => g.key === fp);
    if (existing) existing.systemKeys.push(t.systemKey);
    else groups.push({ key: fp, systemKeys: [t.systemKey], rights: t.rights });
  }
  return groups.map(({ systemKeys, rights }) => ({ systemKeys, rights }));
}

function RightsDetail({ slug }: { slug: string }) {
  const [tests, setTests] = useState<{ systemKey: string; rights: RightsRow[] | null }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await fetch(`/api/clients/${slug}/conn-test`, { cache: "no-store" });
        const d = await r.json().catch(() => ({}));
        if (!live) return;
        if (!r.ok) { setError(d.error ?? `failed (${r.status})`); return; }
        const m365 = (d.tests ?? []).filter((t: { systemKey: string }) => ["m365", "entra", "exchange"].includes(t.systemKey));
        setTests(m365.map((t: { systemKey: string; rights: unknown }) => ({ systemKey: t.systemKey, rights: parseRights(t.rights) })));
      } catch (e) { if (live) setError((e as Error).message); }
    })();
    return () => { live = false; };
  }, [slug]);

  return (
    <tr>
      <td colSpan={5} style={{ background: "var(--bg-soft)" }}>
        {error && <p className="note danger" style={{ margin: "0.3rem 1rem" }}>{error}</p>}
        {!tests && !error && <p className="note" style={{ margin: "0.3rem 1rem" }}><span className="spinner" /> Loading…</p>}
        {/* m365 and entra probe the SAME app registration, so their Graph rights are identical —
            collapse systems that share an identical rights fingerprint into one block (labelled with
            every system it covers, e.g. "m365, entra") instead of listing the same permissions twice.
            exchange has its own (Exchange.ManageAsApp) rights, so it stays separate. */}
        {tests && dedupeRightsBySystem(tests).map((t) => {
          return (
            <div key={t.systemKeys.join("+")} style={{ margin: "0.3rem 0 0.3rem 1rem" }}>
              <div className="note" style={{ fontWeight: 600 }}>{t.systemKeys.join(", ")}</div>
              <table style={{ width: "auto", marginTop: 2 }}>
                <tbody>
                  {(t.rights ?? []).map((r) => {
                    if (r.surplus) {
                      const mark = r.escalation ? "⚠" : "＋";
                      const color = r.escalation ? "#b45309" : "var(--muted)";
                      return (
                        <tr key={r.op}>
                          <td style={{ paddingRight: "0.8rem" }}><span style={{ color }}>{mark}</span> {r.op} <span className="muted" style={{ fontSize: 11 }}>{r.escalation ? "Extra Access — risk" : "Extra Access · unused"}</span></td>
                          <td className="muted" style={{ whiteSpace: "normal" }}>{r.detail}</td>
                        </tr>
                      );
                    }
                    const optMiss = r.optional && r.ok === false;
                    const mark = r.ok === true ? "✓" : optMiss ? "○" : r.ok === false ? "✗" : "?";
                    const color = r.ok === true ? "#15803d" : optMiss ? "#92400e" : r.ok === false ? "#b91c1c" : "#92400e";
                    return (
                      <tr key={r.op}>
                        <td style={{ paddingRight: "0.8rem" }}><span style={{ color }}>{mark}</span> {r.op}{r.optional && <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>(optional)</span>}</td>
                        <td className="muted" style={{ whiteSpace: "normal" }}>{r.detail}</td>
                      </tr>
                    );
                  })}
                  {(t.rights ?? []).length === 0 && <tr><td className="muted">No per-operation detail — retest this client to populate it.</td></tr>}
                </tbody>
              </table>
            </div>
          );
        })}
      </td>
    </tr>
  );
}
