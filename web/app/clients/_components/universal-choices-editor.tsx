"use client";

// Map the client's ServiceNow Universal Choices (the picklist entries on its onboarding form) to the
// Microsoft 365 and Google groups a hire who picks one gets. "Sync from ServiceNow" pulls the choices;
// the mapping is typed here, one group per line, and saved per choice. See lib/clients/universal-choices.
import { useEffect, useMemo, useState } from "react";
import { CHOICE_QUESTIONS, canonicalQuestion } from "@/lib/clients/universal-choices";

type Choice = {
  id: string; question: string; label: string; value: string;
  m365Groups: string[]; googleGroups: string[]; syncedAt: string; goneAt: string | null;
};
type Draft = { m365: string; google: string };

const toText = (gs: string[]) => gs.join("\n");
const toList = (t: string) => t.split(/\n/).map((x) => x.trim()).filter(Boolean);
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function UniversalChoicesEditor({ slug }: { slug: string }) {
  const [choices, setChoices] = useState<Choice[]>([]);
  const [linked, setLinked] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState<string | null>(null);   // "sync" or a choice id
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = async () => {
    const d = await fetch(`/api/clients/${slug}/universal-choices`).then((r) => r.json()).catch(() => null);
    if (Array.isArray(d?.choices)) setChoices(d.choices);
    if (typeof d?.linked === "boolean") setLinked(d.linked);
    setLoaded(true);
  };
  useEffect(() => { void load(); }, [slug]); // eslint-disable-line react-hooks/exhaustive-deps

  // Grouped under the nine known questions (in ServiceNow's order), then anything else ServiceNow had.
  const groups = useMemo(() => {
    const m = new Map<string, Choice[]>();
    for (const c of choices) {
      const q = canonicalQuestion(c.question) ?? c.question ?? "(no question)";
      m.set(q, [...(m.get(q) ?? []), c]);
    }
    const known = CHOICE_QUESTIONS.filter((q) => m.has(q));
    const other = [...m.keys()].filter((q) => !CHOICE_QUESTIONS.includes(q)).sort();
    return [...known, ...other].map((q) => ({ question: q, routed: CHOICE_QUESTIONS.includes(q), rows: m.get(q)! }));
  }, [choices]);

  const draftOf = (c: Choice): Draft => drafts[c.id] ?? { m365: toText(c.m365Groups), google: toText(c.googleGroups) };
  const dirty = (c: Choice) => {
    const d = drafts[c.id];
    return !!d && (!same(toList(d.m365), c.m365Groups) || !same(toList(d.google), c.googleGroups));
  };

  const sync = async () => {
    setBusy("sync"); setMsg(null);
    try {
      const r = await fetch(`/api/clients/${slug}/universal-choices`, { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ ok: false, text: d?.error ?? `sync failed (${r.status})` }); return; }
      setMsg({ ok: true, text: `Synced ${d.total} choice(s): ${d.added} new, ${d.updated} changed, ${d.gone} no longer in ServiceNow. Mappings were kept.` });
      await load();
    } finally { setBusy(null); }
  };

  const save = async (c: Choice) => {
    const d = draftOf(c);
    setBusy(c.id); setMsg(null);
    try {
      const r = await fetch(`/api/clients/${slug}/universal-choices/${c.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ m365Groups: toList(d.m365), googleGroups: toList(d.google) }),
      });
      const res = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ ok: false, text: `${c.label}: ${res?.error ?? `save failed (${r.status})`}` }); return; }
      setChoices((cs) => cs.map((x) => (x.id === c.id ? res.choice : x)));
      setDrafts((ds) => { const n = { ...ds }; delete n[c.id]; return n; });
    } finally { setBusy(null); }
  };

  const mappedCount = choices.filter((c) => c.m365Groups.length || c.googleGroups.length).length;

  return (
    <>
      <div className="row-between" style={{ marginTop: "1.5rem", alignItems: "baseline" }} id="universal-choices">
        <h2 style={{ margin: 0 }}>Universal choices</h2>
        <button onClick={sync} disabled={busy !== null || !linked} title={linked ? undefined : "this client isn't linked to a ServiceNow account"}>
          {busy === "sync" ? "Syncing…" : "Sync from ServiceNow"}
        </button>
      </div>
      <p className="note">
        The choices on this client&apos;s ServiceNow onboarding form. Map one to groups and every hire who picks it is added to
        them. Microsoft 365 groups are added by the Microsoft 365 step (distribution lists go through Exchange) and Google
        groups by the Google step. One group per line. A Security Group or Distribution Group choice left unmapped keeps
        being added by its own name, as before.
      </p>
      {msg && <p className="note" style={{ color: msg.ok ? undefined : "#b3261e" }}>{msg.text}</p>}
      {!loaded ? <p className="note muted">Loading…</p>
        : choices.length === 0 ? <p className="note muted">{linked ? "No choices yet. Sync from ServiceNow to pull them." : "This client isn't linked to a ServiceNow account."}</p>
        : (
          <>
            <p className="note muted">{choices.length} choice(s), {mappedCount} mapped.</p>
            {groups.map((g) => {
              const mapped = g.rows.filter((c) => c.m365Groups.length || c.googleGroups.length).length;
              return (
                <details key={g.question} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "0.5rem 0.9rem", marginBottom: 8 }}>
                  <summary style={{ cursor: "pointer" }}>
                    <strong>{g.question}</strong> <span className="muted">· {g.rows.length} choice(s), {mapped} mapped</span>
                    {!g.routed && <span className="muted"> · not a question the onboarding form routes, so these never match a case</span>}
                  </summary>
                  <table style={{ marginTop: 8 }}>
                    <thead><tr><th>Choice</th><th>Microsoft 365 groups</th><th>Google groups</th><th /></tr></thead>
                    <tbody>
                      {g.rows.map((c) => {
                        const d = draftOf(c);
                        const set = (patch: Partial<Draft>) => setDrafts((ds) => ({ ...ds, [c.id]: { ...d, ...patch } }));
                        return (
                          <tr key={c.id}>
                            <td style={{ verticalAlign: "top" }}>
                              {c.label}
                              {c.value && c.value !== c.label && <div className="note muted">{c.value}</div>}
                              {c.goneAt && <div className="note muted">no longer in ServiceNow</div>}
                            </td>
                            <td style={{ verticalAlign: "top" }}><textarea rows={Math.max(2, toList(d.m365).length + 1)} value={d.m365} onChange={(e) => set({ m365: e.target.value })} style={{ width: 240 }} aria-label={`Microsoft 365 groups for ${c.label}`} /></td>
                            <td style={{ verticalAlign: "top" }}><textarea rows={Math.max(2, toList(d.google).length + 1)} value={d.google} onChange={(e) => set({ google: e.target.value })} style={{ width: 240 }} aria-label={`Google groups for ${c.label}`} /></td>
                            <td style={{ verticalAlign: "top" }}>
                              <button onClick={() => save(c)} disabled={!dirty(c) || busy !== null}>{busy === c.id ? "Saving…" : "Save"}</button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </details>
              );
            })}
          </>
        )}
    </>
  );
}
