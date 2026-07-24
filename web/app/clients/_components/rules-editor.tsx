"use client";

// No-code editor for a client's v2.1 rules: personas (titles + match), and per-system GROUP,
// OU, and ATTRIBUTE rules for "Everyone" (globals) and each persona. Loads from and PUTs back to
// /api/clients/:slug/rules; the whole personas+globals objects round-trip so a save never drops
// sibling rules. Conditions are built with <ConditionBuilder> (emits the planner's grammar).
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Fragment, Persona, GroupEntry, AttrValue } from "@/lib/clients/rules";
import { byPersonaSystemKeys, personaHasSystem, withPersonaSystem } from "@/lib/clients/persona-systems";
import { ConditionBuilder, TagList, AD_ATTRIBUTES, VARS } from "./condition-builder";
import { OuTreePicker } from "./ad-pickers";
import { NlRuleBox, type AppliedRule, type AppliedPersona } from "./nl-rule-box";

type Personas = Record<string, Persona>;
type Globals = Record<string, Fragment>;
type OuRow = { path: string; when?: string };

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v ?? null));

export function RulesEditor({ slug, open, onClose }: { slug: string | null; open: boolean; onClose: () => void }) {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [personas, setPersonas] = useState<Personas>({});
  const [globals, setGlobals] = useState<Globals>({});
  const [globalsOffboard, setGlobalsOffboard] = useState<Globals>({});
  const [action, setAction] = useState<"onboard" | "offboard">("onboard");
  const [systemKeys, setSystemKeys] = useState<string[]>([]);
  const [adObjects, setAdObjects] = useState<{ ous: string[]; groups: string[]; discoveredAt?: string }>({ ous: [], groups: [] });
  // Per-system config.onboard.ou — the OU the runner actually uses. Drives the shadow warning that an
  // OU set here (a persona/global fragment) is overridden by the system's own base OU at plan time.
  const [systemOnboardOu, setSystemOnboardOu] = useState<Record<string, string>>({});
  // Per-system inclusion lane (never | always | on_request | by_persona). Drives the "by persona"
  // badge + the per-persona membership checklist (FR #0000022).
  const [systemLanes, setSystemLanes] = useState<Record<string, { onboard: string; offboard: string }>>({});
  const [cloudGroups, setCloudGroups] = useState<{ name: string; type?: string }[]>([]);
  const [cloudBusy, setCloudBusy] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [scope, setScope] = useState<string>("globals"); // "globals" | persona name
  const [activeSystem, setActiveSystem] = useState<string>("");

  const pollCancelled = useRef(false);
  useEffect(() => {
    if (open) { pollCancelled.current = false; ref.current?.showModal(); }
    else { pollCancelled.current = true; ref.current?.close(); }
  }, [open]);

  useEffect(() => {
    if (!open || !slug) return;
    setLoading(true); setError(null);
    fetch(`/api/clients/${slug}/rules`)
      .then((r) => r.json())
      .then((d) => {
        const g = (d.globals ?? {}) as Globals;
        const p = (d.personas ?? {}) as Personas;
        const keys = (d.systemKeys ?? []) as string[];
        const ad = (d.adObjects ?? {}) as { ous?: string[]; groups?: string[]; discoveredAt?: string };
        const cg = (d.cloudGroups ?? {}) as { groups?: { name: string; type?: string }[] };
        setGlobals(g); setGlobalsOffboard((d.globalsOffboard ?? {}) as Globals); setPersonas(p); setSystemKeys(keys);
        setAdObjects({ ous: ad.ous ?? [], groups: ad.groups ?? [], discoveredAt: ad.discoveredAt });
        setSystemOnboardOu((d.systemOnboardOu ?? {}) as Record<string, string>);
        setSystemLanes((d.systemLanes ?? {}) as Record<string, { onboard: string; offboard: string }>);
        setCloudGroups(Array.isArray(cg.groups) ? cg.groups.filter((x) => x && typeof x.name === "string") : []);
        setScope("globals");
        setActiveSystem(Object.keys(g)[0] ?? keys[0] ?? "active-directory");
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [open, slug]);

  // Fragments for the current scope + action (onboard vs offboard live in separate columns/keys).
  const personaSysKey = action === "onboard" ? "systems" : "offboardSystems";
  const scopeFragments: Record<string, Fragment> = scope === "globals"
    ? (action === "onboard" ? globals : globalsOffboard)
    : (personas[scope]?.[personaSysKey] ?? {});
  const systems = [...new Set([...systemKeys, ...Object.keys(scopeFragments)])].sort();
  const fragment: Fragment = scopeFragments[activeSystem] ?? {};

  // FR #22: the systems in "by persona" mode for the current lane — inclusion is decided by whether
  // the selected persona lists the system. The checklist below toggles that membership directly.
  const byPersonaSystems = byPersonaSystemKeys(systemKeys, systemLanes, action);
  function togglePersonaSystem(key: string, on: boolean) {
    if (scope === "globals") return;
    setPersonas({ ...personas, [scope]: withPersonaSystem(personas[scope], key, on, action) });
  }

  function setFragmentFor(sys: string, frag: Fragment) {
    if (scope === "globals") {
      if (action === "onboard") setGlobals({ ...globals, [sys]: frag });
      else setGlobalsOffboard({ ...globalsOffboard, [sys]: frag });
    } else {
      const persona = personas[scope] ?? {};
      setPersonas({ ...personas, [scope]: { ...persona, [personaSysKey]: { ...(persona[personaSysKey] ?? {}), [sys]: frag } } });
    }
  }
  function setFragment(frag: Fragment) { setFragmentFor(activeSystem, frag); }

  function addPersona() {
    const name = prompt("New persona / role name (e.g. Field Services)")?.trim();
    if (!name) return;
    if (personas[name]) { setScope(name); return; }
    setPersonas({ ...personas, [name]: { systems: {} } });
    setScope(name);
  }
  function deletePersona(name: string) {
    if (!confirm(`Delete persona "${name}" and all its rules?`)) return;
    const next = { ...personas }; delete next[name];
    setPersonas(next);
    setScope("globals");
  }
  function renamePersona(oldName: string, newName: string): boolean {
    const nn = newName.trim();
    if (!nn || nn === oldName || personas[nn]) return false; // empty/unchanged/collision — caller reverts the input
    const next: Personas = {};
    for (const [k, v] of Object.entries(personas)) next[k === oldName ? nn : k] = v;
    setPersonas(next);
    setScope(nn);
    return true;
  }
  function setPersonaField(name: string, patch: Partial<Persona>) {
    setPersonas({ ...personas, [name]: { ...personas[name], ...patch } });
  }

  // Apply an LLM-drafted persona to the CURRENT persona scope — set its match + titles, and (if the
  // draft named groups) add them to the active system's onboard fragment. One functional update so
  // the match/titles and the groups can't clobber each other.
  function applyPersona(p: AppliedPersona) {
    setPersonas((prev) => {
      const cur = prev[scope] ?? { systems: {} };
      let systems = cur.systems ?? {};
      if (p.groups.length && activeSystem) {
        const frag = (systems[activeSystem] ?? {}) as Fragment;
        const existing = Array.isArray(frag.groups) ? frag.groups : [];
        systems = { ...systems, [activeSystem]: { ...frag, groups: [...existing, ...p.groups] } };
      }
      return { ...prev, [scope]: { ...cur, match: p.match || undefined, titles: p.titles, systems } };
    });
  }

  async function save() {
    if (!slug) return;
    setSaving(true); setError(null);
    try {
      const res = await fetch(`/api/clients/${slug}/rules`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personas, globals, globalsOffboard }),
      });
      if (!res.ok) { setError((await res.json().catch(() => null))?.error ?? `Save failed (${res.status})`); return; }
      router.refresh();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function refreshAd() {
    if (!slug) return;
    setDiscovering(true); setError(null);
    try {
      const res = await fetch(`/api/clients/${slug}/ad-objects`, { method: "POST" });
      if (!res.ok) { setError((await res.json().catch(() => null))?.error ?? `Refresh failed (${res.status})`); setDiscovering(false); return; }
      // Poll for the agent to report back (it discovers on its next heartbeat), then update the
      // pickers live — no need to re-open the editor.
      const before = adObjects.discoveredAt;
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 4000));
        if (pollCancelled.current) return; // dialog closed mid-poll — stop fetching/setState
        const d = await fetch(`/api/clients/${slug}/rules`).then((r) => r.json()).catch(() => null);
        if (pollCancelled.current) return;
        const ad = d?.adObjects as { ous?: string[]; groups?: string[]; discoveredAt?: string } | undefined;
        if (ad?.discoveredAt && ad.discoveredAt !== before) {
          setAdObjects({ ous: ad.ous ?? [], groups: ad.groups ?? [], discoveredAt: ad.discoveredAt });
          setDiscovering(false);
          return;
        }
      }
      setError("Requested, but the agent hasn't reported yet — is the client's on-prem runner online and up to date?");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDiscovering(false);
    }
  }

  function addSystem() {
    const key = prompt("System key (e.g. active-directory, m365)")?.trim();
    if (!key) return;
    setFragmentFor(key, scopeFragments[key] ?? {});
    setActiveSystem(key);
  }

  // FR #32 — drop a system's fragment from the current scope. Saves always PUT the whole
  // globals/personas objects back, so without this an added key (even an empty `{}`) persists
  // forever. In a persona scope this is exactly the FR #22 checklist un-check (withPersonaSystem
  // with `on: false`), so by-persona membership and rule fragments stay in lockstep.
  function removeSystem(sys: string) {
    if (scope === "globals") {
      if (action === "onboard") { const next = { ...globals }; delete next[sys]; setGlobals(next); }
      else { const next = { ...globalsOffboard }; delete next[sys]; setGlobalsOffboard(next); }
    } else {
      setPersonas({ ...personas, [scope]: withPersonaSystem(personas[scope], sys, false, action) });
    }
    if (activeSystem === sys) setActiveSystem(systems.find((s) => s !== sys) ?? "");
  }

  return (
    <dialog ref={ref} onClose={onClose} style={{ width: 860, maxWidth: "94vw" }}>
      <div className="row-between">
        <h2>Roles &amp; rules</h2>
        <button onClick={onClose} aria-label="Close">×</button>
      </div>

      {/* Object pickers: discovered AD + cloud (Entra) groups feed the OU + group autocompletes below. */}
      <div className="toolbar" style={{ gap: 8, marginBottom: 4 }}>
        <button onClick={refreshAd} disabled={discovering} title="Have the client's on-prem agent read OUs + groups from the DC">
          {discovering ? "Requesting…" : "⟳ Refresh AD objects from DC"}
        </button>
        <button
          onClick={async () => {
            setCloudBusy(true);
            try { await fetch(`/api/clients/${slug}/cloud-groups`, { method: "POST" }); } finally { setCloudBusy(false); }
          }}
          disabled={cloudBusy}
          title="Have the central runner read this tenant's groups (DLs/Security/365) via the m365 secret"
        >
          {cloudBusy ? "Requesting…" : "⟳ Refresh cloud groups"}
        </button>
        <span className="note">
          {adObjects.discoveredAt ? `${adObjects.ous.length} OUs · ${adObjects.groups.length} AD groups` : "No AD objects yet"}
          {cloudGroups.length > 0 ? ` · ${cloudGroups.length} cloud groups (DL/Security/365)` : ""}
          {" — "}group fields autocomplete from these; queue a refresh then reopen to load new ones.
        </span>
      </div>

      {loading ? (
        <p className="note"><span className="spinner" /> Loading…</p>
      ) : (
        <>
          {/* Onboard vs offboard rule set */}
          <div className="toolbar" style={{ gap: 4, marginBottom: 8 }}>
            <button className={action === "onboard" ? "primary" : ""} onClick={() => setAction("onboard")}>Onboarding rules</button>
            <button className={action === "offboard" ? "primary" : ""} onClick={() => { setAction("offboard"); setScope("globals"); }}>Offboarding rules</button>
            <span className="note" style={{ marginLeft: 6 }}>
              {action === "onboard" ? "What a new user gets: add groups, place OU, set attributes." : "What happens on offboard: remove groups, move OU, set attributes."}
            </span>
          </div>
          {/* Scope tabs. Offboard is Everyone-only: an offboard ticket carries no role, so a persona
              can't be selected at plan time — per-persona offboard rules would silently never fire. */}
          <div className="toolbar" style={{ flexWrap: "wrap", gap: 4, borderBottom: "1px solid var(--line)", paddingBottom: 8 }}>
            <button className={scope === "globals" ? "primary" : ""} onClick={() => setScope("globals")}>Everyone</button>
            {action === "onboard" && Object.keys(personas).map((name) => (
              <button key={name} className={scope === name ? "primary" : ""} onClick={() => setScope(name)}>{name}</button>
            ))}
            {action === "onboard" && <button onClick={addPersona} title="Add a persona/role">+ persona</button>}
            {action === "offboard" && <span className="note" style={{ alignSelf: "center" }}>Offboard rules apply to everyone (offboard tickets carry no role to match a persona).</span>}
          </div>

          {/* Persona header (name / titles / match / delete) */}
          {scope !== "globals" && personas[scope] && (
            <div style={{ margin: "0.75rem 0", padding: "0.5rem 0.75rem", background: "var(--bg-soft)", borderRadius: 4 }}>
              <div className="row-between">
                <div style={{ flex: 1 }}>
                  <label>Persona name</label>
                  <input defaultValue={scope} key={scope} onBlur={(e) => { if (!renamePersona(scope, e.target.value)) e.target.value = scope; }} className="inline" style={{ width: 220 }} />
                </div>
                <button onClick={() => deletePersona(scope)} style={{ color: "#b3261e", alignSelf: "flex-end" }}>Delete persona</button>
              </div>
              <label style={{ marginTop: 8 }}>Selectable job titles</label>
              <TagList items={personas[scope].titles ?? []} onChange={(t) => setPersonaField(scope, { titles: t })} placeholder="add a title…" />
              <label style={{ marginTop: 8 }}>Auto-select this persona when… <span className="note">(optional — leave blank to pick by role name)</span></label>
              <ConditionBuilder value={personas[scope].match ?? ""} onChange={(m) => setPersonaField(scope, { match: m || undefined })} />
              {slug && <NlRuleBox slug={slug} kind="persona" action={action} systemKey={activeSystem} groupOptions={[...new Set([...adObjects.groups, ...cloudGroups.map((g) => g.name)])]} onApplyPersona={applyPersona} />}
            </div>
          )}

          {/* FR #22 — per-persona membership for "by persona" systems. These systems (their lane is set
              to "by persona" in Edit systems) run for a hire ONLY when the selected persona is checked
              here. Independent of any group/OU/attribute — a checked system with no fragment still runs. */}
          {scope !== "globals" && personas[scope] && byPersonaSystems.length > 0 && (
            <div style={{ margin: "0 0 8px", padding: "0.5rem 0.75rem", background: "var(--bg-soft)", border: "1px solid var(--line)", borderRadius: 4 }}>
              <label style={{ display: "block", marginBottom: 4 }}>
                Systems this persona receives{" "}
                <span className="note">(“by persona” systems run only for the personas checked here — no group/OU needed)</span>
              </label>
              <div className="toolbar" style={{ flexWrap: "wrap", gap: 12 }}>
                {byPersonaSystems.map((key) => (
                  <label key={key} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <input type="checkbox" checked={personaHasSystem(personas[scope], key, action)} onChange={(e) => togglePersonaSystem(key, e.target.checked)} />
                    {key}
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* System selector */}
          <div className="toolbar" style={{ flexWrap: "wrap", gap: 4, marginTop: 8 }}>
            <span className="note">System:</span>
            {systems.map((sys) => {
              const byPersona = systemLanes[sys]?.onboard === "by_persona" || systemLanes[sys]?.offboard === "by_persona";
              // Only a system whose key actually exists in this scope's fragment map can be removed —
              // one listed purely via systemKeys has nothing here to delete.
              const removable = Object.prototype.hasOwnProperty.call(scopeFragments, sys);
              return (
                <span key={sys} style={{ display: "inline-flex", alignItems: "center" }}>
                  <button className={activeSystem === sys ? "primary" : ""} onClick={() => setActiveSystem(sys)}
                    title={byPersona ? "In 'by persona' mode — runs only for personas that include it (set membership per persona above)" : undefined}>
                    {sys}{byPersona ? <span style={{ marginLeft: 4, fontSize: 10, color: "#7c3aed" }}>•persona</span> : null}
                  </button>
                  {removable && (
                    <button onClick={() => removeSystem(sys)} aria-label={`Remove ${sys} from this scope`}
                      title={`Remove ${sys}'s rules from ${scope === "globals" ? "Everyone" : `the "${scope}" persona`} (${action})`}
                      style={{ color: "#b3261e", padding: "0 4px", marginLeft: 2 }}>×</button>
                  )}
                </span>
              );
            })}
            <button onClick={addSystem} className="note">+ system</button>
          </div>

          {activeSystem ? (
            <FragmentEditor key={`${scope}|${action}|${activeSystem}`} frag={fragment} onChange={setFragment} ous={adObjects.ous} groupOptions={[...new Set([...adObjects.groups, ...cloudGroups.map((g) => g.name)])]} action={action} slug={slug ?? ""} systemKey={activeSystem} shadowOu={action === "onboard" ? (systemOnboardOu[activeSystem] ?? "") : ""} />
          ) : (
            <p className="note" style={{ marginTop: 12 }}>Add a system to start adding rules.</p>
          )}

          {error && <p className="note danger" style={{ marginTop: 8 }}>{error}</p>}
          <div className="dialog-actions" style={{ marginTop: 12 }}>
            <button onClick={onClose} disabled={saving}>Cancel</button>
            <button className="primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save rules"}</button>
          </div>
        </>
      )}
    </dialog>
  );
}

// ---- one system's fragment: GROUP rules, OU rules, ATTRIBUTES ----
function FragmentEditor({ frag, onChange, ous, groupOptions, action, slug, systemKey, shadowOu }: { frag: Fragment; onChange: (f: Fragment) => void; ous: string[]; groupOptions: string[]; action: "onboard" | "offboard"; slug: string; systemKey: string; shadowOu?: string }) {
  const [ouPick, setOuPick] = useState<number | null>(null);
  const off = action === "offboard";
  const L = {
    groups: off ? "Groups to remove" : "Groups",
    always: off ? "Always remove from" : "Always add",
    thenGroups: off ? "…then remove from groups" : "…then add to groups",
    ou: off ? "Move to OU" : "OU placement",
  };
  const groups = Array.isArray(frag.groups) ? frag.groups : [];
  const always = groups.filter((g): g is string => typeof g === "string");
  const conditional = groups.filter((g): g is { groups: string[]; when?: string } => !!g && typeof g === "object");
  const setGroups = (a: string[], c: { groups: string[]; when?: string }[]) => {
    const next: GroupEntry[] = [...a, ...c];
    onChange({ ...frag, groups: next.length ? next : undefined });
  };

  const ouRaw = frag.ou;
  const ouRows: OuRow[] = ouRaw === undefined ? [] : typeof ouRaw === "string" ? [{ path: ouRaw }] : (ouRaw as OuRow[]);
  const setOu = (rows: OuRow[]) => {
    let next: Fragment["ou"];
    if (rows.length === 0) next = undefined;
    else if (rows.length === 1 && !rows[0].when) next = rows[0].path;
    else next = rows;
    onChange({ ...frag, ou: next });
  };

  const attrs = (frag.attributes && typeof frag.attributes === "object" ? frag.attributes : {}) as Record<string, AttrValue>;
  const setAttrs = (next: Record<string, AttrValue>) => onChange({ ...frag, attributes: Object.keys(next).length ? next : undefined });

  // Apply an LLM-drafted rule into this fragment — same shapes a hand-added rule produces.
  const applyRule = (r: AppliedRule) => {
    if (r.type === "group") setGroups(always, [...conditional, { groups: r.groups, when: r.condition || undefined }]);
    else if (r.type === "ou") setOu([...ouRows, { path: r.path, when: r.condition || undefined }]);
    else setAttrs({ ...attrs, [r.name]: r.condition ? [{ value: r.value, when: r.condition }] : r.value });
  };

  return (
    <div style={{ marginTop: 10, display: "grid", gap: 16 }}>
      {slug && <NlRuleBox slug={slug} kind="rule" action={action} systemKey={systemKey} groupOptions={groupOptions} onApplyRule={applyRule} />}
      {/* GROUPS */}
      <section>
        <h3 style={{ margin: "0 0 4px" }}>{L.groups}</h3>
        <label>{L.always}</label>
        <TagList items={always} onChange={(a) => setGroups(a, conditional)} placeholder="group name…" options={groupOptions} />
        <label style={{ marginTop: 8 }}>Conditional rules</label>
        {conditional.length === 0 && <p className="note">No conditional group rules.</p>}
        {conditional.map((rule, i) => (
          <div key={i} style={{ border: "1px solid var(--line)", borderRadius: 4, padding: 8, marginBottom: 6 }}>
            <div className="row-between">
              <span className="note">If…</span>
              <button onClick={() => setGroups(always, conditional.filter((_, j) => j !== i))} style={{ color: "#b3261e" }}>Delete rule</button>
            </div>
            <ConditionBuilder value={rule.when ?? ""} onChange={(w) => setGroups(always, conditional.map((r, j) => (j === i ? { ...r, when: w || undefined } : r)))} />
            <label style={{ marginTop: 6 }}>{L.thenGroups}</label>
            <TagList items={rule.groups ?? []} onChange={(gs) => setGroups(always, conditional.map((r, j) => (j === i ? { ...r, groups: gs } : r)))} placeholder="group name…" options={groupOptions} />
          </div>
        ))}
        <button onClick={() => setGroups(always, [...conditional, { groups: [], when: "" }])}>+ Add group rule</button>
      </section>

      {/* OU */}
      <section>
        <h3 style={{ margin: "0 0 4px" }}>{L.ou} <span className="note">(first matching rule wins; a rule with no condition is the default)</span></h3>
        {shadowOu && (
          <p className="note" style={{ background: "var(--warn-bg)", border: "1px solid var(--warn-fg)", color: "var(--warn-fg)", borderRadius: 4, padding: "4px 8px", marginBottom: 6 }}>
            ⚠ The base OU set in <strong>Edit systems</strong> (<code style={{ fontSize: 11 }}>{shadowOu}</code>) overrides any OU rule here — the system’s own config wins at plan time. To change where accounts are created, edit it there.
          </p>
        )}
        {ouRows.length === 0 && <p className="note">No OU rule (uses the system default).</p>}
        {ouRows.map((row, i) => (
          <div key={i} style={{ border: "1px solid var(--line)", borderRadius: 4, padding: 8, marginBottom: 6 }}>
            <div className="row-between">
              <input className="inline" style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }} placeholder="OU=Users,OU=…,DC=…" value={row.path}
                onChange={(e) => setOu(ouRows.map((r, j) => (j === i ? { ...r, path: e.target.value } : r)))} spellCheck={false} />
              {ous.length > 0 && (
                <button type="button" onClick={() => setOuPick(ouPick === i ? null : i)} title="Pick from OUs discovered on the DC" style={{ marginLeft: 6, whiteSpace: "nowrap" }}>
                  {ouPick === i ? "Close" : "📁 Browse"}
                </button>
              )}
              <button onClick={() => setOu(ouRows.filter((_, j) => j !== i))} style={{ color: "#b3261e", marginLeft: 6 }}>×</button>
            </div>
            {ouPick === i && (
              <div style={{ marginTop: 4 }}>
                <OuTreePicker ous={ous} onPick={(dn) => { setOu(ouRows.map((r, j) => (j === i ? { ...r, path: dn } : r))); setOuPick(null); }} />
              </div>
            )}
            <label style={{ marginTop: 6 }}>When <span className="note">(blank = default placement)</span></label>
            <ConditionBuilder value={row.when ?? ""} onChange={(w) => setOu(ouRows.map((r, j) => (j === i ? { ...r, when: w || undefined } : r)))} />
          </div>
        ))}
        <button onClick={() => setOu([...ouRows, { path: "" }])}>+ Add OU rule</button>
      </section>

      {/* ATTRIBUTES */}
      <section>
        <h3 style={{ margin: "0 0 4px" }}>Attributes <span className="note">(use {"{token}"} for values from intake, e.g. {"{title}"}, {"{country.short}"})</span></h3>
        <AttributesEditor attrs={attrs} onChange={setAttrs} />
      </section>
    </div>
  );
}

// An attribute's value is either a Variable (a field from the ServiceNow intake, stored as `{token}`)
// or Static text the operator types. A bare "{token}" reads back as Variable with that field selected;
// anything else is Static — which also covers templates like "{first}.{last}" (edit them as free text).
function AttrValueInput({ value, onChange, width = 200 }: { value: string; onChange: (v: string) => void; width?: number }) {
  const bareToken = (s: string) => { const m = /^\{([^}]+)\}$/.exec(s.trim()); return m ? m[1] : null; };
  const [mode, setMode] = useState<"variable" | "static">(bareToken(value) ? "variable" : "static");
  const token = bareToken(value) ?? "";
  // Keep an unknown token (one not in the suggested list) selectable so it isn't silently dropped.
  const opts = token && !VARS.includes(token) ? [token, ...VARS] : VARS;
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
      <select className="inline" style={{ width: 88 }} value={mode}
        title="Variable = a field from the ServiceNow intake (inserted as {token}); Static = a fixed value you type"
        onChange={(e) => {
          const m = e.target.value as "variable" | "static";
          setMode(m);
          // Seed a default field when switching to Variable from non-token text (so the dropdown has a value).
          if (m === "variable" && !bareToken(value)) onChange(`{${VARS[0]}}`);
        }}>
        <option value="variable">Variable</option>
        <option value="static">Static</option>
      </select>
      {mode === "variable" ? (
        <select className="inline" style={{ width }} value={token} onChange={(e) => onChange(`{${e.target.value}}`)}>
          {opts.map((o) => <option key={o} value={o}>{`{${o}}`}</option>)}
        </select>
      ) : (
        <input className="inline" style={{ width }} value={value} placeholder="type a value" onChange={(e) => onChange(e.target.value)} spellCheck={false} />
      )}
    </span>
  );
}

function AttributesEditor({ attrs, onChange }: { attrs: Record<string, AttrValue>; onChange: (next: Record<string, AttrValue>) => void }) {
  const rename = (oldK: string, newK: string): boolean => {
    const nk = newK.trim();
    if (!nk || nk === oldK || attrs[nk]) return false; // empty/unchanged/collision — caller reverts the input
    const next: Record<string, AttrValue> = {};
    for (const [k, v] of Object.entries(attrs)) next[k === oldK ? nk : k] = v;
    onChange(next);
    return true;
  };
  const setVal = (k: string, v: AttrValue) => onChange({ ...attrs, [k]: v });
  const remove = (k: string) => { const next = { ...attrs }; delete next[k]; onChange(next); };

  return (
    <div>
      <datalist id="ad-attrs">{AD_ATTRIBUTES.map((a) => <option key={a} value={a} />)}</datalist>
      {Object.entries(attrs).map(([k, v]) => {
        const isCond = Array.isArray(v);
        return (
          <div key={k} style={{ border: "1px solid var(--line)", borderRadius: 4, padding: 8, marginBottom: 6 }}>
            <div className="toolbar" style={{ gap: 4 }}>
              <input list="ad-attrs" className="inline" style={{ width: 140 }} defaultValue={k} key={k} onBlur={(e) => { if (!rename(k, e.target.value)) e.target.value = k; }} placeholder="attribute" spellCheck={false} />
              <span className="note">=</span>
              {!isCond && (
                <AttrValueInput value={String(v ?? "")} onChange={(nv) => setVal(k, nv)} />
              )}
              <span className="grow" />
              {!isCond && <button className="note" onClick={() => setVal(k, [{ value: String(v ?? ""), when: "" }])}>make conditional</button>}
              <button onClick={() => remove(k)} style={{ color: "#b3261e" }}>×</button>
            </div>
            {isCond && (
              <div style={{ marginTop: 6 }}>
                {(v as Array<{ value: string | number | boolean; when?: string }>).map((entry, i, arr) => (
                  <div key={i} style={{ borderTop: i ? "1px dashed var(--line)" : undefined, paddingTop: i ? 6 : 0, marginTop: i ? 6 : 0 }}>
                    <div className="toolbar" style={{ gap: 4 }}>
                      <AttrValueInput value={String(entry.value ?? "")}
                        onChange={(nv) => setVal(k, arr.map((x, j) => (j === i ? { ...x, value: nv } : x)))} />
                      <span className="grow" />
                      <button onClick={() => { const left = arr.filter((_, j) => j !== i); if (left.length) setVal(k, left); else remove(k); }} style={{ color: "#b3261e" }} title="remove this value">×</button>
                    </div>
                    <label style={{ marginTop: 4 }}>when <span className="note">(blank = default)</span></label>
                    <ConditionBuilder value={entry.when ?? ""} onChange={(w) => setVal(k, arr.map((x, j) => (j === i ? { ...x, when: w || undefined } : x)))} />
                  </div>
                ))}
                <button onClick={() => setVal(k, [...(v as []), { value: "", when: "" }])} style={{ marginTop: 6 }}>+ value</button>
              </div>
            )}
          </div>
        );
      })}
      <AddAttr onAdd={(name) => { if (name && !attrs[name]) onChange({ ...attrs, [name]: "" }); }} />
    </div>
  );
}

function AddAttr({ onAdd }: { onAdd: (name: string) => void }) {
  const [name, setName] = useState("");
  return (
    <div className="toolbar" style={{ gap: 4 }}>
      <input list="ad-attrs" className="inline" style={{ width: 160 }} value={name} placeholder="new attribute (e.g. department)" onChange={(e) => setName(e.target.value)} spellCheck={false}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onAdd(name.trim()); setName(""); } }} />
      <button onClick={() => { onAdd(name.trim()); setName(""); }}>+ Add attribute</button>
    </div>
  );
}
