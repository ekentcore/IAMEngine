"use client";

// Plain-English → rule/persona drafter. Type a sentence, the LLM drafts a structured rule (or
// persona); it renders in the SAME editable controls used elsewhere (ConditionBuilder + group
// TagList) so the operator reviews/tweaks, then Adds it to the editor's in-memory rules (the normal
// Save persists). A "Refine" box re-prompts with the current draft + a correction. Degrades to a
// note when AI isn't configured.
import { useState } from "react";
import type { RuleDraft } from "@/lib/rules/nl-rule";
import { ConditionBuilder, TagList } from "./condition-builder";

export type AppliedRule =
  | { type: "group"; condition: string; groups: string[] }
  | { type: "ou"; condition: string; path: string }
  | { type: "attribute"; condition: string; name: string; value: string };
export type AppliedPersona = { name: string; match: string; titles: string[]; groups: string[] };

type Props = {
  slug: string;
  kind: "rule" | "persona";
  action: "onboard" | "offboard";
  systemKey?: string;
  groupOptions: string[];
  onApplyRule?: (r: AppliedRule) => void;
  onApplyPersona?: (p: AppliedPersona) => void;
};

export function NlRuleBox({ slug, kind, action, systemKey, groupOptions, onApplyRule, onApplyPersona }: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noAi, setNoAi] = useState(false);
  const [draft, setDraft] = useState<RuleDraft | null>(null); // last raw draft (sent back on Refine)
  const [correction, setCorrection] = useState("");

  // editable copy of the draft (operator can tweak before Add)
  const [ruleType, setRuleType] = useState<"group" | "ou" | "attribute">("group");
  const [condition, setCondition] = useState("");
  const [groups, setGroups] = useState<string[]>([]);
  const [ouPath, setOuPath] = useState("");
  const [attrName, setAttrName] = useState("");
  const [attrValue, setAttrValue] = useState("");
  const [personaName, setPersonaName] = useState("");
  const [titles, setTitles] = useState<string[]>([]);
  const [unmatched, setUnmatched] = useState<string[]>([]);
  const [explanation, setExplanation] = useState("");

  function load(d: RuleDraft) {
    setDraft(d);
    setNoAi(false);
    setCondition(d.condition);
    setExplanation(d.explanation);
    const um: string[] = [];
    if (d.groups) { setGroups([...d.groups.matched]); um.push(...d.groups.unmatched); }
    if (d.kind === "persona") {
      setPersonaName(d.personaName ?? "New persona");
      setTitles(d.titles ?? []);
    } else {
      setRuleType(d.ruleType === "ou" || d.ruleType === "attribute" ? d.ruleType : "group");
      if (d.ruleType === "ou") { setOuPath(d.ou?.path ?? ""); if (d.ou && !d.ou.matched) um.push(`OU: ${d.ou.path}`); }
      if (d.ruleType === "attribute") { setAttrName(d.attribute?.name ?? ""); setAttrValue(d.attribute?.value ?? ""); }
    }
    setUnmatched(um);
  }

  async function generate(refine = false) {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/clients/${slug}/rules/generate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, kind, action, systemKey, current: refine ? draft : undefined, correction: refine ? correction : undefined }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setError(d.error ?? `failed (${res.status})`); return; }
      if (!d.draft) { setNoAi(true); setDraft(null); return; }
      load(d.draft as RuleDraft);
      setCorrection("");
    } finally {
      setBusy(false);
    }
  }

  function apply() {
    if (kind === "persona") {
      onApplyPersona?.({ name: personaName.trim() || "New persona", match: condition, titles, groups });
    } else if (ruleType === "group") {
      onApplyRule?.({ type: "group", condition, groups });
    } else if (ruleType === "ou") {
      onApplyRule?.({ type: "ou", condition, path: ouPath });
    } else {
      onApplyRule?.({ type: "attribute", condition, name: attrName, value: attrValue });
    }
    // reset for the next one
    setDraft(null); setText(""); setGroups([]); setCondition(""); setOuPath(""); setAttrName(""); setAttrValue(""); setTitles([]); setUnmatched([]);
  }

  const label = kind === "persona" ? "Describe a persona in plain English" : "Describe a rule in plain English";
  if (!open) {
    return <button type="button" onClick={() => setOpen(true)} style={{ fontSize: 12, margin: "2px 0" }}>✨ {label}</button>;
  }

  return (
    <div style={{ border: "1px solid #c7d2fe", background: "#f8f9ff", borderRadius: 6, padding: "0.5rem 0.6rem", margin: "4px 0" }}>
      <div className="toolbar" style={{ justifyContent: "space-between" }}>
        <b style={{ fontSize: 12 }}>✨ {label}</b>
        <button type="button" onClick={() => setOpen(false)} aria-label="Close" style={{ fontSize: 12 }}>×</button>
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} spellCheck
        placeholder={kind === "persona" ? "e.g. anyone with Engineer in their title; add them to Field-Services and place in the Field OU" : "e.g. add Mac users to Mac User - Standard"}
        style={{ width: "100%", fontSize: 12, marginTop: 4 }} />
      <div className="toolbar" style={{ marginTop: 2 }}>
        <button type="button" className="primary" onClick={() => generate(false)} disabled={busy || !text.trim()}>{busy ? "Drafting…" : "Generate"}</button>
        {error && <span className="note danger">{error}</span>}
        {noAi && <span className="note" style={{ color: "#92400e" }}>AI isn&rsquo;t configured — build it by hand below.</span>}
      </div>

      {draft && (
        <div style={{ marginTop: 8, borderTop: "1px solid #e0e7ff", paddingTop: 8 }}>
          {explanation && <p className="note" style={{ marginTop: 0 }}>{explanation}{draft.lowConfidence && <b style={{ color: "#92400e" }}> · low confidence — please review</b>}</p>}
          {unmatched.length > 0 && <p className="note" style={{ color: "#92400e" }}>⚠ Couldn&rsquo;t match to a discovered name: {unmatched.join(", ")} — fix or confirm before adding.</p>}

          {kind === "persona" && (
            <label style={{ fontSize: 12 }}>Persona name<br /><input value={personaName} onChange={(e) => setPersonaName(e.target.value)} style={{ width: 220 }} /></label>
          )}
          {kind === "rule" && (
            <div className="toolbar" style={{ marginBottom: 4 }}>
              <span className="note">Rule type:</span>
              <select value={ruleType} onChange={(e) => setRuleType(e.target.value as "group" | "ou" | "attribute")} className="inline" style={{ fontSize: 12 }}>
                <option value="group">Groups</option><option value="ou">OU</option><option value="attribute">Attribute</option>
              </select>
            </div>
          )}

          <label style={{ fontSize: 12 }}>{kind === "persona" ? "Auto-select when (match)" : "When"}</label>
          <ConditionBuilder value={condition} onChange={setCondition} />

          {(kind === "persona" || ruleType === "group") && (
            <div style={{ marginTop: 6 }}>
              <label style={{ fontSize: 12 }}>{kind === "persona" ? "Groups for this persona" : "Add to groups"}</label>
              <TagList items={groups} onChange={setGroups} placeholder="group name…" options={groupOptions} />
            </div>
          )}
          {kind === "persona" && (
            <div style={{ marginTop: 6 }}>
              <label style={{ fontSize: 12 }}>Selectable job titles</label>
              <TagList items={titles} onChange={setTitles} placeholder="add a title…" />
            </div>
          )}
          {kind === "rule" && ruleType === "ou" && (
            <div style={{ marginTop: 6 }}><label style={{ fontSize: 12 }}>OU</label><br /><input value={ouPath} onChange={(e) => setOuPath(e.target.value)} style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }} /></div>
          )}
          {kind === "rule" && ruleType === "attribute" && (
            <div className="toolbar" style={{ marginTop: 6, gap: 4 }}>
              <input value={attrName} onChange={(e) => setAttrName(e.target.value)} placeholder="attribute" className="inline" style={{ width: 150 }} />
              <span className="note">=</span>
              <input value={attrValue} onChange={(e) => setAttrValue(e.target.value)} placeholder="value or {token}" className="inline" style={{ width: 220 }} />
            </div>
          )}

          <div className="toolbar" style={{ marginTop: 8 }}>
            <button type="button" className="primary" onClick={apply}>{kind === "persona" ? "Add persona" : "Add rule"}</button>
            <input value={correction} onChange={(e) => setCorrection(e.target.value)} placeholder="refine: e.g. only US-based" className="inline" style={{ width: 240, fontSize: 12 }}
              onKeyDown={(e) => { if (e.key === "Enter" && correction.trim()) { e.preventDefault(); generate(true); } }} />
            <button type="button" onClick={() => generate(true)} disabled={busy || !correction.trim()}>{busy ? "…" : "Refine"}</button>
          </div>
        </div>
      )}
    </div>
  );
}
