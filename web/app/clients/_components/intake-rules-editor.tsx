"use client";

// Per-contact intake rules (FR #0000019). When a listed ServiceNow contact submits an ONBOARD case,
// skip the chosen systems and force the email domain; everyone else gets the client's normal plan.
// "Populate from ServiceNow" pulls the account's customer_contact people (name/email) so an operator
// picks a person instead of hand-typing a sys_id.
import { useEffect, useRef, useState } from "react";

type IntakeRuleContact = { sysId: string; name: string };
type IntakeRule = {
  id: string;
  label: string;
  match: { contacts: IntakeRuleContact[] };
  effects: { skipSystems: string[]; forceDomain: string | null };
};
type SnContact = { sysId: string; name: string; email: string };

const emptyRule = (n: number): IntakeRule => ({
  id: `rule-${Date.now()}-${n}`,
  label: "New rule",
  match: { contacts: [] },
  effects: { skipSystems: [], forceDomain: "" },
});

export function IntakeRulesEditor({ slug, systemKeys }: { slug: string; systemKeys: string[] }) {
  const [rules, setRules] = useState<IntakeRule[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // "Populate from ServiceNow" state: which rule it's populating for, the fetched list, and the
  // loading modal. `dialog` is used the same way as the other modals in this app (ref + showModal/close).
  const [populatingFor, setPopulatingFor] = useState<number | null>(null);
  const [snContacts, setSnContacts] = useState<SnContact[] | null>(null);
  const [snError, setSnError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/clients/${slug}/intake-rules`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (Array.isArray(d?.intakeRules?.rules)) setRules(d.intakeRules.rules);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [slug]);

  useEffect(() => {
    const open = populatingFor !== null;
    if (open && !dialogRef.current?.open) dialogRef.current?.showModal();
    if (!open && dialogRef.current?.open) dialogRef.current?.close();
  }, [populatingFor]);

  function update(i: number, patch: Partial<IntakeRule>) {
    setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  async function populate(i: number) {
    setPopulatingFor(i);
    setSnContacts(null);
    setSnError(null);
    try {
      const r = await fetch(`/api/clients/${slug}/sn-contacts`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setSnError(d?.error ?? `lookup failed (${r.status})`); return; }
      setSnContacts(Array.isArray(d?.contacts) ? d.contacts : []);
    } catch (e) {
      setSnError((e as Error).message);
    }
  }

  function addContact(ruleIndex: number, c: SnContact) {
    const rule = rules[ruleIndex];
    if (!rule || rule.match.contacts.some((x) => x.sysId === c.sysId)) return;
    update(ruleIndex, { match: { contacts: [...rule.match.contacts, { sysId: c.sysId, name: c.name }] } });
  }

  function closePopulate() {
    setPopulatingFor(null);
    setSnContacts(null);
    setSnError(null);
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const payload = {
        rules: rules.map((r) => ({
          ...r,
          effects: { ...r.effects, forceDomain: r.effects.forceDomain?.trim() || null },
        })),
      };
      const r = await fetch(`/api/clients/${slug}/intake-rules`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ ok: false, text: d?.error ?? `save failed (${r.status})` }); return; }
      setMsg({ ok: true, text: "Saved." });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="row-between" style={{ marginTop: "1.5rem", alignItems: "baseline" }}>
        <h2 style={{ margin: 0 }}>Intake rules</h2>
      </div>
      <p className="note">
        When a listed ServiceNow contact submits an onboarding, skip the chosen systems and force the
        email domain below. Everyone else gets the normal plan.
      </p>

      {!loaded ? (
        <p className="note muted">Loading…</p>
      ) : rules.length === 0 ? (
        <p className="note muted">No intake rules yet.</p>
      ) : (
        rules.map((rule, i) => (
          <div key={rule.id} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "0.7rem 0.9rem", marginBottom: 10 }}>
            <div className="toolbar" style={{ justifyContent: "space-between" }}>
              <input
                value={rule.label}
                onChange={(e) => update(i, { label: e.target.value })}
                placeholder="Label"
                style={{ fontWeight: 600, flex: 1, minWidth: 160 }}
              />
              <button className="icon-btn" title="remove rule" style={{ color: "#b3261e" }} onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))}>×</button>
            </div>

            <div style={{ marginTop: 8 }}>
              <div className="note" style={{ fontWeight: 600, marginBottom: 2 }}>Contacts</div>
              <div className="toolbar">
                {rule.match.contacts.length === 0
                  ? <span className="muted">none</span>
                  : rule.match.contacts.map((c) => (
                      <span key={c.sysId} className="badge" style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                        {c.name}
                        <button
                          className="icon-btn"
                          style={{ width: 16, height: 16, color: "#b3261e" }}
                          title="remove contact"
                          onClick={() => update(i, { match: { contacts: rule.match.contacts.filter((x) => x.sysId !== c.sysId) } })}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                <button onClick={() => populate(i)} style={{ fontSize: 12 }}>Populate from ServiceNow</button>
              </div>
            </div>

            <div style={{ marginTop: 8 }}>
              <div className="note" style={{ fontWeight: 600, marginBottom: 2 }}>Skip systems</div>
              <div className="toolbar">
                {systemKeys.length === 0 && <span className="muted">no systems modeled yet</span>}
                {systemKeys.map((k) => (
                  <label key={k} className="note" style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                    <input
                      type="checkbox"
                      checked={rule.effects.skipSystems.includes(k)}
                      onChange={(e) =>
                        update(i, {
                          effects: {
                            ...rule.effects,
                            skipSystems: e.target.checked
                              ? [...rule.effects.skipSystems, k]
                              : rule.effects.skipSystems.filter((s) => s !== k),
                          },
                        })
                      }
                    />
                    {k}
                  </label>
                ))}
              </div>
            </div>

            <div style={{ marginTop: 8 }}>
              <label className="note" style={{ display: "block", fontWeight: 600, marginBottom: 2 }}>Force email domain</label>
              <input
                value={rule.effects.forceDomain ?? ""}
                onChange={(e) => update(i, { effects: { ...rule.effects, forceDomain: e.target.value } })}
                placeholder="e.g. shawmutinfinite.com"
                style={{ width: 260, fontFamily: "var(--mono, monospace)" }}
              />
            </div>
          </div>
        ))
      )}

      <div className="toolbar">
        <button onClick={() => setRules((rs) => [...rs, emptyRule(rs.length)])}>+ Add rule</button>
        <button className="primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
        {msg && <span className="note" style={{ color: msg.ok ? "#15803d" : "#b91c1c" }}>{msg.text}</span>}
      </div>

      <dialog ref={dialogRef} onClose={closePopulate} style={{ width: 420, maxWidth: "95vw" }}>
        <div className="row-between">
          <h2 style={{ margin: 0, fontSize: 16 }}>Populate from ServiceNow</h2>
          <button onClick={closePopulate}>Close</button>
        </div>
        {snContacts === null && !snError && <p className="note">Loading contacts from ServiceNow…</p>}
        {snError && <p className="note danger">{snError}</p>}
        {snContacts && snContacts.length === 0 && <p className="note muted">No contacts found on this account.</p>}
        {snContacts && snContacts.length > 0 && (
          <select
            defaultValue=""
            onChange={(e) => {
              const c = snContacts.find((x) => x.sysId === e.target.value);
              if (c && populatingFor !== null) addContact(populatingFor, c);
              e.target.value = "";
            }}
            style={{ width: "100%" }}
          >
            <option value="" disabled>Add a contact…</option>
            {snContacts.map((c) => (
              <option key={c.sysId} value={c.sysId}>{c.name} — {c.email}</option>
            ))}
          </select>
        )}
        <div className="dialog-actions">
          <button onClick={closePopulate}>Done</button>
        </div>
      </dialog>
    </>
  );
}
