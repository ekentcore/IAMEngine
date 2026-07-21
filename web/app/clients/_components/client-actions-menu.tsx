"use client";

// One "Actions ▾" popover for the client detail header — collapses the row of standalone action
// buttons (name update, re-plan, edit systems, M365 setup, change/move) behind a single trigger so
// the header reads clean. Self-contained: owns the dropdown open/close + click-away, runs the two
// in-place fetch actions (name update, re-plan) itself, and drives the three modal actions through
// their now-controllable components (kept mounted below the trigger so their status stays visible).
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { SystemsEditor } from "./systems-editor";
import { M365SetupButton } from "./m365-setup-button";
import { ChangeCaseDialog } from "./change-case-dialog";
import { GuidedApiSetup } from "./guided-api-setup";
import { API_SETUP_CATALOG } from "@/lib/secrets/api-setup-catalog";

type Props = {
  slug: string;
  personas: string[];
  locations: string[];
  knownGroups: { name: string; type?: string }[];
  ous: string[];
  systemKeys: string[];
  guidedSetupHref: string | null;
};

export function ClientActionsMenu({ slug, personas, locations, knownGroups, ous, systemKeys, guidedSetupHref }: Props) {
  const router = useRouter();
  const wrap = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  // Catalog systems this client actually has — each gets its own "Setup <label> API" item + modal.
  const guidedEntries = API_SETUP_CATALOG.filter((e) => systemKeys.includes(e.systemKey));
  const showM365 = systemKeys.some((k) => k === "m365" || k === "entra" || k === "exchange");

  // In-place actions run straight from the menu; their result persists in a note below the trigger.
  const [nameBusy, setNameBusy] = useState(false);
  const [replanBusy, setReplanBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  // Modal actions. Systems + Change are controlled open; M365 owns its own dialog lifecycle (it must
  // stay open through a long-running setup), so the menu just pings an incrementing open signal.
  const [systemsOpen, setSystemsOpen] = useState(false);
  const [m365Signal, setM365Signal] = useState(0);
  const [changeOpen, setChangeOpen] = useState(false);
  // One open-signal per guided-setup entry, keyed by systemKey — mirrors m365Signal so each system's
  // modal opens independently of the others.
  const [guidedSignals, setGuidedSignals] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  async function runNameUpdate() {
    setNameBusy(true); setResult(null);
    try {
      const r = await fetch(`/api/clients/${slug}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "refresh-name" }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setResult({ ok: false, text: d.error ?? `Name update failed (${r.status})` }); return; }
      setResult({ ok: true, text: d.changed ? `Updated to “${d.name}” (was “${d.previous}”)` : `Name already up to date (“${d.name}”)` });
      if (d.changed) router.refresh();
    } catch (e) { setResult({ ok: false, text: (e as Error).message }); }
    finally { setNameBusy(false); }
  }

  async function runReplan() {
    setReplanBusy(true); setResult(null);
    try {
      const r = await fetch(`/api/clients/${slug}/replan-cases`, { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setResult({ ok: false, text: d.error ?? `Re-plan failed (${r.status})` }); return; }
      setResult({ ok: true, text: d.total === 0 ? "No open cases to re-plan." : `Re-planned ${d.total} case${d.total > 1 ? "s" : ""}${d.incremental ? ` (${d.incremental} incremental)` : ""}${d.errors?.length ? ` — ${d.errors[0]}` : ""}.` });
      router.refresh();
    } catch (e) { setResult({ ok: false, text: (e as Error).message }); }
    finally { setReplanBusy(false); }
  }

  const busy = nameBusy || replanBusy;

  return (
    <div className="client-actions">
      <div ref={wrap} style={{ position: "relative" }}>
        <button type="button" className="actions-trigger-lg" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          Actions <span aria-hidden="true">▾</span>
        </button>
        {open && (
          <div role="menu" className="actions-menu">
            <button role="menuitem" disabled={busy} onClick={runNameUpdate}
              title="Pull the latest name from ServiceNow (for a renamed account) — updates only the name">
              {nameBusy ? "Checking ServiceNow…" : "Name update"}
            </button>
            <button role="menuitem" disabled={busy} onClick={runReplan}
              title="Re-plan this client's open cases against the current systems (started cases keep their finished steps)">
              {replanBusy ? "Re-planning…" : "Re-plan open cases"}
            </button>
            <div className="actions-menu-sep" />
            <button role="menuitem" onClick={() => { setOpen(false); setSystemsOpen(true); }}>Edit systems</button>
            <button role="menuitem" onClick={() => { setOpen(false); setChangeOpen(true); }}>Change / move user</button>
            {showM365 && (
              <button role="menuitem" onClick={() => { setOpen(false); setM365Signal((n) => n + 1); }}
                title="Automatically create + configure this client's iam-engine M365 app registration and vault the credential">
                Set up M365 automatically
              </button>
            )}
            {guidedEntries.map((entry) => (
              <button key={entry.systemKey} role="menuitem"
                onClick={() => { setOpen(false); setGuidedSignals((prev) => ({ ...prev, [entry.systemKey]: (prev[entry.systemKey] ?? 0) + 1 })); }}
                title={`Guided setup for the ${entry.label} API credential`}>
                Setup {entry.label} API
              </button>
            ))}
            {guidedSetupHref && (
              <>
                <div className="actions-menu-sep" />
                <a role="menuitem" href={guidedSetupHref} className="actions-menu-link">Guided setup →</a>
              </>
            )}
          </div>
        )}
      </div>

      {/* Persistent result note + always-mounted dialogs, kept outside the popover so the in-place
          results survive the menu closing and each dialog owns its own lifecycle. M365 shows its live
          step tracker in its own centered modal. */}
      {result && (
        <span className="note client-actions-result" style={{ color: result.ok ? "#15803d" : "#b91c1c" }}>
          {result.text}
        </span>
      )}
      {showM365 && <M365SetupButton slug={slug} openSignal={m365Signal} hideTrigger />}
      {guidedEntries.map((entry) => (
        <GuidedApiSetup key={entry.systemKey} slug={slug} entry={entry} openSignal={guidedSignals[entry.systemKey] ?? 0} hideTrigger />
      ))}
      <SystemsEditor slug={systemsOpen ? slug : null} open={systemsOpen} onClose={() => setSystemsOpen(false)} />
      <ChangeCaseDialog slug={slug} personas={personas} locations={locations} knownGroups={knownGroups} ous={ous}
        open={changeOpen} onClose={() => setChangeOpen(false)} />
    </div>
  );
}
