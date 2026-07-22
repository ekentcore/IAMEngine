"use client";

// Shared React renderer for a connection/permission preflight result. The four stages are
// drawn the SAME way everywhere they appear — the client page's "Test connections" panel and
// the guided-setup wizard's per-step block — so the two surfaces can't drift. The pure
// text/color logic lives in ./conn-test-badge-logic (unit-testable, no JSX) and is re-exported
// here so consumers have a single import site.
import {
  fieldsBadge,
  accessBadge,
  apiBadge,
  rightsBadge,
  stageDetail,
  hasRights,
  type ConnTest,
  type RightsRow,
} from "@/lib/jobs/conn-test-badge-logic";

export {
  fieldsBadge,
  accessBadge,
  apiBadge,
  rightsBadge,
  stageDetail,
  hasRights,
  type ConnTest,
  type RightsRow,
};

// A single stage badge (inline span, carries its own detail as a tooltip). `kind` selects
// which stage's text/color to draw for this test.
export function StageBadge({ test, kind }: { test: ConnTest; kind: "fields" | "access" | "api" }) {
  const b = kind === "fields" ? fieldsBadge(test) : kind === "access" ? accessBadge(test) : apiBadge(test);
  const title = kind === "fields" ? test.fieldsDetail : kind === "access" ? test.accessDetail : test.detail;
  return <span className="badge" style={{ color: b.color }} title={title ?? undefined}>{b.text}</span>;
}

// The Rights column: a disclosure button when per-operation rows exist (caller owns the
// open/close state so a table can keep one row open at a time), else a plain badge.
export function RightsBadge({ test, open, onToggle }: { test: ConnTest; open: boolean; onToggle: () => void }) {
  const b = rightsBadge(test);
  if (!hasRights(test)) return <span className="badge" style={{ color: b.color }}>{b.text}</span>;
  return (
    <button
      className="linklike"
      style={{ color: b.color, background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit" }}
      onClick={onToggle}
      title="Show per-operation results"
    >
      {b.text} {open ? "▴" : "▾"}
    </button>
  );
}

// The expandable per-operation rights table body. Extra-Access (surplus) rows get their own
// mark/chip — never the "○ (optional)" missing styling, since they're the opposite finding.
export function RightsDetail({ rows }: { rows: RightsRow[] }) {
  return (
    <table style={{ margin: "0.3rem 0 0.3rem 1rem", width: "auto" }}>
      <tbody>
        {rows.map((r) => {
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
          // A missing optional permission is amber "○" (a note), not red "✗" — it does not
          // fail the test, so it must not read like a failure.
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
  );
}
