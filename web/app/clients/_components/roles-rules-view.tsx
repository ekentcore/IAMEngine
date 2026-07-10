"use client";

// Read-only view of a v2.1 client's resolution rules — the "small stuff": every-user (global) groups
// + attributes, each persona's per-system OU / groups / attributes, conditional entries (added only
// when a condition holds, e.g. "RDS-Users when country.short == US && employmentType == Full-Time"),
// and the locations table conditions resolve against. This is the rule SOURCE; the case Playbook
// shows the RESOLVED output for a specific person.
import { useState } from "react";

type GroupEntry = string | { groups?: string[]; when?: string };
type OuEntry = string | Array<{ path?: string; when?: string }>;
type Fragment = { groups?: GroupEntry[]; ou?: OuEntry; attributes?: Record<string, unknown>; licenses?: unknown[] };
type Persona = { label?: string; titles?: string[]; match?: string; systems?: Record<string, Fragment> };

const chipCond = (when?: string) =>
  when ? <code style={{ fontSize: 11, background: "#f3eefa", color: "#7b3fa0", padding: "1px 5px", borderRadius: 3, marginLeft: 6 }}>when {when}</code> : null;

function Groups({ list }: { list?: GroupEntry[] }) {
  if (!list?.length) return <span className="muted">—</span>;
  return (
    <ul style={{ margin: "0.2rem 0", listStyle: "none", paddingLeft: 0 }}>
      {list.map((g, i) =>
        typeof g === "string" ? (
          <li key={i}><span className="badge" style={{ marginRight: 4 }}>{g}</span></li>
        ) : (
          <li key={i} style={{ margin: "0.15rem 0" }}>
            {(g.groups ?? []).map((x) => <span key={x} className="badge" style={{ marginRight: 4, color: "#7b3fa0", borderColor: "#e0cef0" }}>{x}</span>)}
            {chipCond(g.when)}
          </li>
        )
      )}
    </ul>
  );
}

function Ou({ ou }: { ou?: OuEntry }) {
  if (!ou) return <span className="muted">—</span>;
  if (typeof ou === "string") return <code style={{ fontSize: 11 }}>{ou}</code>;
  return (
    <ul style={{ margin: "0.2rem 0" }}>
      {ou.map((o, i) => <li key={i}><code style={{ fontSize: 11 }}>{o.path}</code>{o.when ? chipCond(o.when) : <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>(default)</span>}</li>)}
    </ul>
  );
}

function Attrs({ attrs }: { attrs?: Record<string, unknown> }) {
  const keys = attrs ? Object.keys(attrs) : [];
  if (!keys.length) return null;
  return (
    <table style={{ fontSize: 12, margin: "0.2rem 0" }}>
      <tbody>
        {keys.map((k) => <tr key={k}><td style={{ paddingRight: 12, color: "var(--muted)" }}>{k}</td><td><code style={{ fontSize: 11 }}>{String((attrs as Record<string, unknown>)[k])}</code></td></tr>)}
      </tbody>
    </table>
  );
}

function FragmentView({ frag }: { frag: Fragment }) {
  return (
    <div style={{ marginLeft: "0.8rem" }}>
      {frag.ou !== undefined && <div style={{ marginTop: 4 }}><span className="note">OU:</span> <Ou ou={frag.ou} /></div>}
      {frag.groups && <div style={{ marginTop: 4 }}><span className="note">Groups:</span><Groups list={frag.groups} /></div>}
      {frag.attributes && <div style={{ marginTop: 4 }}><span className="note">Attributes:</span><Attrs attrs={frag.attributes} /></div>}
      {Array.isArray(frag.licenses) && frag.licenses.length > 0 && <div className="note">Licenses: {frag.licenses.map(String).join(", ")}</div>}
    </div>
  );
}

export function RolesRulesView({ personas, globals, locations }: {
  personas: Record<string, Persona> | null;
  globals: Record<string, Fragment> | null;
  locations: Record<string, Record<string, unknown>> | null;
}) {
  const [openP, setOpenP] = useState<Set<string>>(new Set());
  const toggle = (n: string) => setOpenP((s) => { const x = new Set(s); x.has(n) ? x.delete(n) : x.add(n); return x; });
  const personaNames = personas ? Object.keys(personas).sort() : [];
  const globalSystems = globals ? Object.keys(globals) : [];
  const locNames = locations ? Object.keys(locations) : [];

  return (
    <div>
      <p className="note">The rules that resolve a new hire&rsquo;s OU, groups and attributes. <code style={{ fontSize: 11, color: "#7b3fa0" }}>when …</code> entries apply only when the condition holds (department/title/location/employment). The case Playbook shows the resolved result for a specific person.</p>

      {globalSystems.length > 0 && (
        <>
          <h3 style={{ marginBottom: 2 }}>Every user (globals)</h3>
          {globalSystems.map((sys) => (
            <div key={sys} style={{ margin: "0.3rem 0" }}>
              <b>{sys}</b>
              <FragmentView frag={globals![sys]} />
            </div>
          ))}
        </>
      )}

      {personaNames.length > 0 && (
        <>
          <h3 style={{ margin: "0.8rem 0 2px" }}>Personas / roles ({personaNames.length})</h3>
          {personaNames.map((name) => {
            const p = personas![name];
            const isOpen = openP.has(name);
            return (
              <details key={name} open={isOpen} style={{ margin: "0.2rem 0" }}>
                <summary onClick={(e) => { e.preventDefault(); toggle(name); }} style={{ cursor: "pointer" }}>
                  <b>{name}</b>
                  {p.titles?.length ? <span className="note" style={{ marginLeft: 6 }}>titles: {p.titles.join(", ")}</span> : null}
                  {p.match ? chipCond(p.match) : null}
                </summary>
                <div style={{ marginLeft: "0.8rem" }}>
                  {Object.entries(p.systems ?? {}).map(([sys, frag]) => (
                    <div key={sys} style={{ marginTop: 4 }}><b style={{ fontSize: 13 }}>{sys}</b><FragmentView frag={frag} /></div>
                  ))}
                </div>
              </details>
            );
          })}
        </>
      )}

      {locNames.length > 0 && (
        <>
          <h3 style={{ margin: "0.8rem 0 2px" }}>Locations ({locNames.length})</h3>
          <table style={{ fontSize: 12 }}>
            <thead><tr><th style={{ textAlign: "left" }}>Name</th><th style={{ textAlign: "left" }}>Address</th><th style={{ textAlign: "left" }}>City</th><th style={{ textAlign: "left" }}>State</th><th style={{ textAlign: "left" }}>Zip</th><th style={{ textAlign: "left" }}>Timezone</th><th style={{ textAlign: "left" }}>Country</th></tr></thead>
            <tbody>
              {locNames.map((n) => {
                const l = locations![n] as { address?: string; city?: string; state?: string; zip?: string; timezone?: string; country?: { short?: string; name?: string } };
                return <tr key={n}><td><b>{n}</b></td><td>{l.address ?? "—"}</td><td>{l.city ?? "—"}</td><td>{l.state ?? "—"}</td><td>{l.zip ?? "—"}</td><td>{l.timezone ?? "—"}</td><td>{l.country?.short ?? l.country?.name ?? "—"}</td></tr>;
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
