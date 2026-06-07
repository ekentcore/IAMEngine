"use client";

// No-code condition builder: edits a condition STRING (e.g. "country.short == IN && employmentType
// == Full-Time") as OR-groups of AND-rows, or as raw text for advanced cases. Emits a grammar the
// planner's evalCondition accepts (see lib/profiles/condition-builder.ts for the parse/serialize).
import { useEffect, useState } from "react";
import { parseCondition, serializeCondition, validateCondition, type ConditionModel, type Term, type TermOp } from "@/lib/profiles/condition-builder";

// Suggested fields (the plan context vars). Free text is allowed too — intake payload fields like
// `avd` pass through — so this is a datalist, not a closed select.
const VARS = [
  "country.short", "country.name", "country.code", "employmentType", "role.name",
  "location.name", "location.city", "location.state", "title", "manager", "startDate", "domain", "upn", "username",
];
const OPS: { v: TermOp; label: string }[] = [
  { v: "==", label: "is" }, { v: "!=", label: "is not" }, { v: "~=", label: "matches (regex)" }, { v: "in", label: "is one of" },
];

const blankTerm = (): Term => ({ var: "", op: "==", value: "" });

export function ConditionBuilder({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  const [raw, setRaw] = useState(() => parseCondition(value) === null); // start raw if it doesn't parse
  const [model, setModel] = useState<ConditionModel>(() => parseCondition(value) ?? [[]]);

  // Re-sync when the parent swaps in a different condition (e.g. switching rule/scope), but don't
  // clobber in-progress edits (our serialization already equals the incoming value).
  useEffect(() => {
    if (serializeCondition(model) !== (value ?? "")) {
      const p = parseCondition(value);
      if (p) setModel(p);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function update(next: ConditionModel) {
    setModel(next);
    onChange(serializeCondition(next));
  }
  const setTerm = (gi: number, ti: number, patch: Partial<Term>) =>
    update(model.map((g, i) => (i !== gi ? g : g.map((t, j) => (j !== ti ? t : { ...t, ...patch })))));
  const addAnd = (gi: number) => update(model.map((g, i) => (i !== gi ? g : [...g, blankTerm()])));
  const removeTerm = (gi: number, ti: number) => {
    const next = model.map((g, i) => (i !== gi ? g : g.filter((_, j) => j !== ti))).filter((g) => g.length > 0);
    update(next.length ? next : [[]]);
  };
  const addOr = () => update([...model, [blankTerm()]]);

  const rawValidation = validateCondition(value);

  if (raw) {
    return (
      <div>
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={2}
          spellCheck={false}
          placeholder="e.g. country.short == IN  (blank = always)"
          style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }}
        />
        <div className="toolbar" style={{ marginTop: 2 }}>
          {!rawValidation.ok && <span className="note danger">{rawValidation.error}</span>}
          {rawValidation.ok && value.trim() && <span className="note" style={{ color: "#2e7d32" }}>✓ valid</span>}
          {rawValidation.ok && !value.trim() && <span className="note">always applies</span>}
          <span className="grow" />
          <button type="button" onClick={() => { if (parseCondition(value)) setRaw(false); }} disabled={!parseCondition(value)} title={parseCondition(value) ? "" : "expression is too complex for the guided builder"}>
            Use builder
          </button>
        </div>
      </div>
    );
  }

  const isAlways = serializeCondition(model).trim() === "";
  return (
    <div style={{ border: "1px solid var(--border, #e2e2e2)", borderRadius: 4, padding: "6px 8px", background: "#fafafa" }}>
      <datalist id="rule-vars">{VARS.map((v) => <option key={v} value={v} />)}</datalist>
      {model.map((group, gi) => (
        <div key={gi}>
          {gi > 0 && <div className="note" style={{ margin: "4px 0", fontWeight: 600, color: "#7b3fa0" }}>OR</div>}
          {group.map((term, ti) => (
            <div key={ti} className="toolbar" style={{ gap: 4, marginBottom: 4, flexWrap: "wrap" }}>
              {ti > 0 && <span className="note" style={{ minWidth: 28 }}>and</span>}
              <input list="rule-vars" className="inline" style={{ width: 150 }} placeholder="field" value={term.var}
                onChange={(e) => setTerm(gi, ti, { var: e.target.value })} spellCheck={false} />
              <select className="inline" value={term.op} onChange={(e) => setTerm(gi, ti, { op: e.target.value as TermOp })}>
                {OPS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
              </select>
              <input className="inline" style={{ width: 150 }} placeholder={term.op === "in" ? "CA, GA, TX" : "value"} value={term.value}
                onChange={(e) => setTerm(gi, ti, { value: e.target.value })} spellCheck={false} />
              <button type="button" title="remove" onClick={() => removeTerm(gi, ti)} style={{ color: "#b3261e" }}>×</button>
            </div>
          ))}
          <button type="button" className="note" onClick={() => addAnd(gi)} style={{ marginLeft: group.length ? 28 : 0 }}>+ and</button>
        </div>
      ))}
      <div className="toolbar" style={{ marginTop: 4 }}>
        <button type="button" onClick={addOr}>+ or</button>
        {isAlways && <span className="note">no condition — always applies</span>}
        <span className="grow" />
        <button type="button" onClick={() => setRaw(true)} className="note">Raw…</button>
      </div>
    </div>
  );
}

// Chip list with an add input — for group names, titles, etc.
export function TagList({ items, onChange, placeholder }: { items: string[]; onChange: (next: string[]) => void; placeholder?: string }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (v && !items.includes(v)) onChange([...items, v]);
    setDraft("");
  };
  return (
    <div className="toolbar" style={{ gap: 4, flexWrap: "wrap" }}>
      {items.map((it) => (
        <span key={it} className="badge" style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
          {it}
          <button type="button" onClick={() => onChange(items.filter((x) => x !== it))} title="remove" style={{ color: "#b3261e", padding: 0, lineHeight: 1 }}>×</button>
        </span>
      ))}
      <input
        className="inline"
        style={{ width: 160 }}
        value={draft}
        placeholder={placeholder ?? "add…"}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
        onBlur={add}
        spellCheck={false}
      />
    </div>
  );
}
