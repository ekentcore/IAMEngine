"use client";

// Set which M365 license(s) new users get for this client. This edits the m365 system config
// (config.onboard.licenses) — the value the executor actually assigns — NOT the runbook doc. After
// saving, re-plan open cases to apply the change to in-flight ones.
//
// Each selected license is assigned either DIRECT (Set-MgUserLicense, the classic path) or GROUP
// BASED — the user is added to a group that carries the license (Entra group-based licensing, or an
// AD group that syncs up). The group is picked from the client's discovered groups by NAME; the
// runner resolves it live, so there is no stale-GUID failure mode (INC0858242).
import { useState } from "react";
import { useRouter } from "next/navigation";
import { COMMON_LICENSES as COMMON } from "@/lib/m365/license-catalog";
import type { LicenseEntry } from "@/lib/m365/license-config";
import { isGroupBased, licenseEntryName } from "@/lib/m365/license-config";

export type GroupOption = { name: string; source: "entra" | "ad" };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Single-group pick with discovered-group suggestions — the license editor's counterpart of the
// rules editor's TagList, but exactly one group and each suggestion labeled with its source.
function GroupPicker({ value, source, options, onChange }: {
  value: string;
  source: "entra" | "ad";
  options: GroupOption[];
  onChange: (group: string, source: "entra" | "ad") => void;
}) {
  const [focus, setFocus] = useState(false);
  const q = norm(value);
  const matches = (q ? options.filter((o) => norm(o.name).includes(q)) : options).slice(0, 8);
  const known = options.some((o) => norm(o.name) === q);
  return (
    <span style={{ position: "relative", display: "inline-flex", gap: 4, alignItems: "center" }}>
      <input
        value={value}
        placeholder="license group name"
        style={{ fontSize: 12, minWidth: 220 }}
        onChange={(e) => onChange(e.target.value, source)}
        onFocus={() => setFocus(true)}
        onBlur={() => setTimeout(() => setFocus(false), 150)}
      />
      <select value={source} style={{ fontSize: 12, width: "auto" }} title="Where the group lives: Entra (cloud) or on-prem AD"
        onChange={(e) => onChange(value, e.target.value === "ad" ? "ad" : "entra")}>
        <option value="entra">Entra</option>
        <option value="ad">AD</option>
      </select>
      {focus && matches.length > 0 && (
        <ul style={{ position: "absolute", top: "100%", left: 0, zIndex: 10, margin: 0, padding: "2px 0", listStyle: "none", background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 6, minWidth: 260, maxHeight: 180, overflowY: "auto" }}>
          {matches.map((o) => (
            <li key={`${o.source}:${o.name}`}>
              <button type="button" style={{ display: "flex", width: "100%", justifyContent: "space-between", gap: 8, fontSize: 12, border: 0, background: "none", padding: "3px 8px", cursor: "pointer", textAlign: "left" }}
                onMouseDown={(e) => { e.preventDefault(); onChange(o.name, o.source); setFocus(false); }}>
                <span>{o.name}</span>
                <span className="note" style={{ fontSize: 11 }}>{o.source === "ad" ? "AD" : "Entra"}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {value.trim() !== "" && !known && !focus && (
        <span className="note" style={{ fontSize: 11 }} title="Not in the discovered groups — it can still work if the name is right in the tenant.">not in discovered groups</span>
      )}
    </span>
  );
}

export function M365LicenseEditor({ slug, current, groupOptions = [], hasAdSystem = false }: {
  slug: string;
  current: LicenseEntry[];
  groupOptions?: GroupOption[];
  hasAdSystem?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<LicenseEntry[]>(current);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // A client without an AD system has no lane to add an on-prem group — offer Entra groups only.
  const pickerOptions = hasAdSystem ? groupOptions : groupOptions.filter((o) => o.source !== "ad");

  const options = [...new Set([...COMMON, ...current.map(licenseEntryName)])];
  const entryFor = (name: string) => sel.find((e) => licenseEntryName(e) === name);
  const toggle = (name: string) =>
    setSel((s) => (s.some((e) => licenseEntryName(e) === name) ? s.filter((e) => licenseEntryName(e) !== name) : [...s, name]));
  const setMode = (name: string, groupBased: boolean) =>
    setSel((s) => s.map((e) => (licenseEntryName(e) !== name ? e : groupBased ? { name, assignVia: "group" as const, group: "", groupSource: "entra" as const } : name)));
  const setGroup = (name: string, group: string, groupSource: "entra" | "ad") =>
    setSel((s) => s.map((e) => (licenseEntryName(e) === name && isGroupBased(e) ? { ...e, group, groupSource } : e)));
  const addCustom = () => { const t = custom.trim(); if (t && !sel.some((e) => licenseEntryName(e) === t)) { setSel([...sel, t]); } setCustom(""); };

  const describe = (e: LicenseEntry) => (isGroupBased(e) ? `${e.name} (via ${e.groupSource === "ad" ? "AD" : "Entra"} group '${e.group}')` : e);
  const incomplete = sel.filter((e) => isGroupBased(e) && !e.group.trim());

  if (!open) {
    return (
      <div className="note" style={{ marginTop: "0.5rem" }}>
        Onboarding license{current.length === 1 ? "" : "s"}: <b>{current.length ? current.map(describe).join(", ") : "(none set)"}</b>{" "}
        <button style={{ fontSize: 12, marginLeft: 6 }} onClick={() => { setSel(current); setMsg(null); setOpen(true); }}>Change license</button>
      </div>
    );
  }

  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "0.7rem 0.9rem", marginTop: "0.5rem", maxWidth: 560 }}>
      <b style={{ fontSize: 14 }}>M365 onboarding license</b>
      <p className="note" style={{ margin: "0.2rem 0 0.5rem" }}>
        What new users get assigned. This is the executed value (not the runbook doc). Group based = the
        user is added to the group that carries the license, instead of a direct assignment.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {options.map((name) => {
          const entry = entryFor(name);
          const grouped = entry !== undefined && isGroupBased(entry);
          return (
            <div key={name}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, margin: 0, fontSize: 13, color: "var(--fg)" }}>
                <input type="checkbox" style={{ width: "auto" }} checked={entry !== undefined} onChange={() => toggle(name)} />
                {name}
                {entry !== undefined && (
                  <select value={grouped ? "group" : "direct"} style={{ fontSize: 12, width: "auto", marginLeft: 6 }}
                    onChange={(e) => setMode(name, e.target.value === "group")}>
                    <option value="direct">Direct</option>
                    <option value="group">Group based</option>
                  </select>
                )}
              </label>
              {grouped && (
                <div style={{ margin: "3px 0 4px 24px" }}>
                  <GroupPicker value={entry.group} source={entry.groupSource} options={pickerOptions}
                    onChange={(g, src) => setGroup(name, g, src)} />
                  {pickerOptions.length === 0 && (
                    <p className="note" style={{ fontSize: 11, margin: "3px 0 0" }}>
                      No discovered groups yet — run <b>Discover cloud groups</b> on this client to fill the pick list (a typed name still works).
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
        <input value={custom} placeholder="other license name or SKU part number" onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustom(); } }} style={{ fontSize: 12 }} />
        <button style={{ fontSize: 12 }} onClick={addCustom} disabled={!custom.trim()}>Add</button>
      </div>
      {msg && <p className="note" style={{ color: msg.ok ? "#15803d" : "#b91c1c", marginTop: 6 }}>{msg.text}</p>}
      <div className="toolbar" style={{ marginTop: 8 }}>
        <button className="primary" disabled={busy || incomplete.length > 0}
          title={incomplete.length ? `Pick a group for: ${incomplete.map(licenseEntryName).join(", ")}` : undefined}
          onClick={async () => {
          setBusy(true); setMsg(null);
          try {
            const r = await fetch(`/api/clients/${slug}/m365-licenses`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ licenses: sel }) });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) { setMsg({ ok: false, text: d.error ?? `failed (${r.status})` }); return; }
            setMsg({ ok: true, text: "✓ Saved. Re-plan this client's open cases to apply to in-flight onboardings." });
            router.refresh();
          } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
          finally { setBusy(false); }
        }}>{busy ? "Saving…" : "Save license"}</button>
        <button disabled={busy} onClick={() => setOpen(false)}>Close</button>
      </div>
    </div>
  );
}
