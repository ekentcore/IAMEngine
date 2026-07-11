"use client";

// No-code condition builder: edits a condition STRING (e.g. "country.short == IN && employmentType
// == Full-Time") as OR-groups of AND-rows, or as raw text for advanced cases. Emits a grammar the
// planner's evalCondition accepts (see lib/profiles/condition-builder.ts for the parse/serialize).
import { useEffect, useMemo, useState } from "react";
import { parseCondition, serializeCondition, validateCondition, type ConditionModel, type Term, type TermOp } from "@/lib/profiles/condition-builder";

// Suggested fields to branch ON (the plan context vars; see lib/profiles/context.ts buildPlanContext).
// Free text is allowed too — intake payload fields like `avd` pass through — so this is a datalist,
// not a closed select.
export const VARS = [
  // identity / role / employment (from the intake)
  "title", "department", "jobTitle", "employmentType", "isRehire", "role.name", "manager", "startDate", "officeLocation",
  // yes/no intake fields — compare with "is" and a Yes/No (or true/false) value, e.g. needsComputer is Yes
  "needsComputer", "clientProvidingAsset", "dockingStation", "keyboardMouse", "monitorStands",
  // location (matched from the office) + country
  "location.name", "location.city", "location.state", "location.zip", "location.timezone",
  "country.short", "country.name", "country.code",
  // identity tokens
  "first", "last", "mobile", "did", "extension", "domain", "upn", "username",
  // free-text needs / hardware / software (match with "matches (regex)", e.g. otherNeeds ~= macbook|apple)
  "otherNeeds", "otherHardware", "otherSoftware", "installedSoftware", "cloudApplications",
  "printers", "monitors", "description",
];

// Intake fields that are yes/no booleans — used to offer Yes/No on the value side.
export const BOOL_VARS = new Set(["needsComputer", "clientProvidingAsset", "dockingStation", "keyboardMouse", "monitorStands", "isRehire"]);

// Common AD / Entra attribute names to SET (the "then set …" side). Free text still allowed — this
// is only autocomplete. A static seed; AD discovery (later) can replace it with the DC's real schema.
export const AD_ATTRIBUTES = [
  "title", "department", "company", "description", "physicalDeliveryOfficeName", "division",
  "streetAddress", "l", "st", "postalCode", "c", "co", "countryCode",
  "telephoneNumber", "mobile", "ipPhone", "facsimileTelephoneNumber", "homePhone", "pager",
  "employeeID", "employeeNumber", "employeeType", "manager", "wWWHomePage", "info",
  ...Array.from({ length: 15 }, (_, i) => `extensionAttribute${i + 1}`),
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
      <datalist id="rule-bool-vals"><option value="Yes" /><option value="No" /></datalist>
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
              <input className="inline" style={{ width: 150 }} list={BOOL_VARS.has(term.var.trim()) ? "rule-bool-vals" : undefined}
                placeholder={term.op === "in" ? "CA, GA, TX" : BOOL_VARS.has(term.var.trim()) ? "Yes / No" : "value"} value={term.value}
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

// Chip list with an add input — for group names, titles, etc. When `options` is given (e.g. the
// groups discovered from the DC), the input shows a click-to-add filtered dropdown; free text is
// still allowed either way.
export function TagList({ items, onChange, placeholder, options }: { items: string[]; onChange: (next: string[]) => void; placeholder?: string; options?: string[] }) {
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const add = (v?: string) => {
    const val = (v ?? draft).trim();
    if (val && !items.includes(val)) onChange([...items, val]);
    setDraft("");
  };
  const matches = options
    ? options.filter((o) => !items.includes(o) && o.toLowerCase().includes(draft.trim().toLowerCase())).slice(0, 14)
    : [];
  const showDrop = focused && !!options && matches.length > 0;
  // Validation: when a picker list is provided AND populated (discovery has run), flag a tag that isn't
  // one of the discovered options. Space/punctuation-insensitive so "Perimeter81 Users" can suggest the
  // real "Perimeter 81 Users" (click to fix) — the same normalization the AD runner uses to auto-recover.
  const norm = (s: string) => s.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const optByNorm = useMemo(() => new Map((options ?? []).map((o) => [norm(o), o])), [options]);
  const canValidate = !!options && options.length > 0;
  return (
    <div style={{ position: "relative" }}>
      <div className="toolbar" style={{ gap: 4, flexWrap: "wrap" }}>
        {items.map((it) => {
          const known = !canValidate || options!.includes(it);
          const suggestion = !known ? optByNorm.get(norm(it)) : undefined;
          const title = known ? undefined
            : suggestion ? `Not an exact match for a discovered group — did you mean “${suggestion}”? Click to use it.`
            : "Not found in the discovered groups — verify the name (Refresh AD / cloud groups above).";
          return (
            <span key={it} className="badge" style={{ display: "inline-flex", gap: 4, alignItems: "center", ...(known ? null : { color: "var(--warn-fg)", background: "var(--warn-bg)" }) }}>
              <span
                title={title}
                onClick={suggestion ? () => onChange(items.map((x) => (x === it ? suggestion : x))) : undefined}
                style={{ cursor: suggestion ? "pointer" : known ? undefined : "help" }}
              >
                {!known && "⚠ "}{it}
              </span>
              <button type="button" onClick={() => onChange(items.filter((x) => x !== it))} title="remove" style={{ color: "#b3261e", padding: 0, lineHeight: 1 }}>×</button>
            </span>
          );
        })}
        <input
          className="inline"
          style={{ width: 180 }}
          value={draft}
          placeholder={placeholder ?? (options ? "search / add…" : "add…")}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => setFocused(true)}
          // With a picker (`options`), blurring after typing a *filter* must not commit that filter
          // text as a literal tag — add only via Enter or a dropdown click. Free-text lists keep
          // blur-to-add.
          onBlur={() => { setFocused(false); if (!options) add(); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          spellCheck={false}
        />
      </div>
      {showDrop && (
        <div style={{ position: "absolute", zIndex: 20, top: "100%", left: 0, minWidth: 260, maxHeight: 220, overflowY: "auto", background: "#fff", border: "1px solid #ccc", borderRadius: 4, boxShadow: "0 2px 8px rgba(0,0,0,0.15)" }}>
          {matches.map((m) => (
            // onMouseDown (not click) so it fires before the input blur, and preventDefault keeps focus
            <div key={m} onMouseDown={(e) => { e.preventDefault(); add(m); }}
              style={{ padding: "3px 8px", cursor: "pointer", fontSize: 13 }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#eef")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "#fff")}>
              {m}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
