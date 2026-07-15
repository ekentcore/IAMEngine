"use client";

// Shared editable preview of runbook sections: reorder / rename / relink / add / remove / promote
// lines, with license & username suggestions. Used by BOTH the paste-a-runbook editor and the
// "Build from systems" preview dialog, so the editing behaviour is identical wherever sections are
// reviewed before saving. Pure UI over a sections array — the caller owns the state and the save.
import { COMMON_LICENSES, COMMON_USERNAME_PATTERNS } from "@/lib/m365/license-catalog";
import { CATALOG, headerToSystemKey } from "@/lib/generator/system-map";

export type Section = { seq: number; systemKey: string | null; title: string; status: string; steps: string[] };

// Compact ▲▼ reorder control used on sections and steps.
export function Arrows({ up, down, disUp, disDown, title }: { up: () => void; down: () => void; disUp: boolean; disDown: boolean; title: string }) {
  const btn: React.CSSProperties = { padding: "0 4px", fontSize: 10, lineHeight: 1.1, minWidth: 0 };
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", marginRight: 2 }}>
      <button type="button" style={btn} disabled={disUp} title={`Move ${title} up`} onClick={up}>▲</button>
      <button type="button" style={btn} disabled={disDown} title={`Move ${title} down`} onClick={down}>▼</button>
    </span>
  );
}

// onChange takes a pure updater so callers whose state is `Section[] | null` can adapt trivially.
export function SectionsEditor({ sections, onChange }: { sections: Section[]; onChange: (updater: (prev: Section[]) => Section[]) => void }) {
  function moveSection(i: number, dir: -1 | 1) {
    onChange((p) => {
      const j = i + dir; if (j < 0 || j >= p.length) return p;
      const next = [...p]; [next[i], next[j]] = [next[j], next[i]];
      return next.map((s, k) => ({ ...s, seq: k }));
    });
  }
  function moveStep(si: number, ti: number, dir: -1 | 1) {
    onChange((p) => {
      const steps = [...p[si].steps]; const tj = ti + dir;
      if (tj < 0 || tj >= steps.length) return p;
      [steps[ti], steps[tj]] = [steps[tj], steps[ti]];
      const next = [...p]; next[si] = { ...next[si], steps };
      return next;
    });
  }
  // Inline edits saved verbatim by the caller (blank steps are dropped server-side).
  function editStep(si: number, ti: number, value: string) {
    onChange((p) => { const steps = [...p[si].steps]; steps[ti] = value; const next = [...p]; next[si] = { ...next[si], steps }; return next; });
  }
  function removeStep(si: number, ti: number) {
    onChange((p) => { const steps = p[si].steps.filter((_, k) => k !== ti); const next = [...p]; next[si] = { ...next[si], steps }; return next; });
  }
  function addStep(si: number) {
    onChange((p) => { const next = [...p]; next[si] = { ...next[si], steps: [...next[si].steps, ""] }; return next; });
  }
  function editTitle(si: number, value: string) {
    onChange((p) => {
      const next = [...p];
      // Retitling re-links: a title that names a known system re-maps the section (fixes a mis-link by
      // typing the right name); an unrecognized title keeps the current link — the system select next
      // to the title is the explicit control either way.
      const mapped = headerToSystemKey(value);
      const systemKey = mapped ?? next[si].systemKey;
      next[si] = { ...next[si], title: value, systemKey, status: systemKey ? "automated" : "unmodeled" };
      return next;
    });
  }
  function setSectionSystem(si: number, key: string) {
    onChange((p) => {
      const next = [...p];
      const systemKey = key === "" ? null : key;
      next[si] = { ...next[si], systemKey, status: systemKey ? "automated" : "unmodeled" };
      return next;
    });
  }
  function removeSection(si: number) {
    onChange((p) => p.filter((_, k) => k !== si).map((s, k) => ({ ...s, seq: k })));
  }
  // Promote a step LINE into its own section, right after the current one. Lines nested UNDER it
  // (greater indent) move along as the new section's steps — this is how a lumped section gets split.
  function promoteStep(si: number, ti: number) {
    onChange((p) => {
      const sec = p[si];
      const line = sec.steps[ti] ?? "";
      const title = line.trim();
      if (!title) return p;
      const indent = line.match(/^ */)?.[0].length ?? 0;
      let end = ti + 1;
      while (end < sec.steps.length && (sec.steps[end].match(/^ */)?.[0].length ?? 0) > indent) end++;
      const children = sec.steps.slice(ti + 1, end).map((s) => s.replace(new RegExp(`^ {0,${indent}}`), ""));
      const remaining = [...sec.steps.slice(0, ti), ...sec.steps.slice(end)];
      const systemKey = headerToSystemKey(title);
      const newSection: Section = { seq: 0, systemKey, title, status: systemKey ? "automated" : "unmodeled", steps: children };
      const next = [...p];
      next[si] = { ...sec, steps: remaining };
      next.splice(si + 1, 0, newSection);
      return next.map((s, k) => ({ ...s, seq: k }));
    });
  }

  return (
    <div>
      {/* Suggestions for license / username lines — free text still allowed. */}
      <datalist id="rb-suggest">
        {[...COMMON_LICENSES, ...COMMON_USERNAME_PATTERNS].map((v) => <option key={v} value={v} />)}
      </datalist>
      {sections.map((s, si) => (
        <div key={si} style={{ margin: "0.4rem 0", paddingLeft: "0.4rem", borderLeft: "2px solid var(--line)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <Arrows up={() => moveSection(si, -1)} down={() => moveSection(si, 1)} disUp={si === 0} disDown={si === sections.length - 1} title="section" />
            <span style={{ fontWeight: 700 }}>{si + 1}.</span>
            <input value={s.title} onChange={(e) => editTitle(si, e.target.value)} aria-label="section title"
              style={{ fontWeight: 700, fontSize: 13, flex: 1, minWidth: 0, maxWidth: 320 }} />
            <select value={s.systemKey ?? ""} onChange={(e) => setSectionSystem(si, e.target.value)} aria-label="linked system"
              title="Which modeled system this section is linked to — drives the automated step and the systems sync on save"
              style={{ fontSize: 11.5, color: s.systemKey ? "#2e7d32" : "var(--muted)", maxWidth: 130 }}>
              <option value="">unmodeled</option>
              {Object.keys(CATALOG).sort().map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <button onClick={() => removeSection(si)} title="remove this whole section" style={{ fontSize: 11, color: "#b91c1c" }}>✕ section</button>
          </div>
          <ul style={{ margin: "0.2rem 0", listStyle: "none", paddingLeft: 0 }}>
            {s.steps.map((st, ti) => (
              <li key={ti} style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: (st.match(/^ */)?.[0].length ?? 0) * 6, marginBottom: 2 }}>
                <Arrows up={() => moveStep(si, ti, -1)} down={() => moveStep(si, ti, 1)} disUp={ti === 0} disDown={ti === s.steps.length - 1} title="step" />
                <input value={st} onChange={(e) => editStep(si, ti, e.target.value)} list="rb-suggest" aria-label="step"
                  style={{ flex: 1, minWidth: 0, fontSize: 12, fontFamily: "monospace" }} />
                <button onClick={() => promoteStep(si, ti)} title="make this line its own section (auto-maps to a system if the name is recognized, e.g. Salesforce, Zoom)" style={{ fontSize: 11, padding: "0 6px", whiteSpace: "nowrap" }}>↥ section</button>
                <button onClick={() => removeStep(si, ti)} title="remove this step" style={{ fontSize: 12, color: "#b91c1c", padding: "0 6px" }}>✕</button>
              </li>
            ))}
            <li style={{ marginTop: 2 }}>
              <button onClick={() => addStep(si)} style={{ fontSize: 12 }}>+ add step</button>
            </li>
          </ul>
        </div>
      ))}
    </div>
  );
}
