"use client";

// One "Actions ▾" popover for the case detail header — collapses the row of standalone action
// buttons (link/hard-match, reveal password, schedule, pause, domain, re-plan) behind a single
// trigger, matching the client detail header's menu.
//
// The six action components each own a self-contained dialog (some portaled to <body>, some inline).
// To keep those dialogs alive when the menu closes, the panel is ALWAYS MOUNTED and merely toggles
// its `display` — never conditionally unmounted. So: a portaled dialog (schedule/reveal) renders to
// <body> and is unaffected when the panel hides; an inline dialog (re-plan) is modal + inside the
// wrapper, so a click on it never counts as an outside-click and the menu stays open while it's up.
import { useEffect, useRef, useState } from "react";
import { HardMatchButton } from "./hard-match-button";
import { RevealPasswordButton } from "./reveal-password-button";
import { ScheduleButton } from "./schedule-button";
import { PauseButton } from "./pause-button";
import { CaseDomainSelect } from "./case-domain-select";
import { ReplanButton } from "./replan-button";

type DomainInfo = { options: string[]; defaultDomain: string | null; override: string | null };

type Props = {
  caseId: string;
  action: string;
  started: boolean;
  paused: boolean;
  canSchedule: boolean; // false for completed/failed cases (the API refuses it too)
  scheduledForIso: string | null;
  effectiveDate: string | null;
  showHardMatch: boolean;
  hasInitialPassword: boolean;
  domain: DomainInfo | null; // onboard multi-domain clients only
};

export function CaseActionsMenu(props: Props) {
  const { caseId, action, started, paused, canSchedule, scheduledForIso, effectiveDate, showHardMatch, hasInitialPassword, domain } = props;
  const wrap = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  return (
    <div className="client-actions">
      <div ref={wrap} style={{ position: "relative" }}>
        <button type="button" className="actions-trigger-lg" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {showHardMatch && <span aria-hidden style={{ color: "var(--warn-fg)", marginRight: 4 }}>⚠</span>}
          Actions <span aria-hidden="true">▾</span>
        </button>
        {/* Always mounted — visibility is toggled via display so the children's dialogs survive a close. */}
        <div role="menu" className="actions-menu case-actions-menu" style={{ display: open ? "flex" : "none" }}>
          {showHardMatch && <div className="case-actions-row">                <HardMatchButton caseId={caseId} /></div>}
          {hasInitialPassword && <div className="case-actions-row">           <RevealPasswordButton caseId={caseId} /></div>}
          {canSchedule && <div className="case-actions-row">                  <ScheduleButton caseId={caseId} action={action} scheduledForIso={scheduledForIso} effectiveDate={effectiveDate} /></div>}
          <div className="case-actions-row">                                  <PauseButton caseId={caseId} paused={paused} /></div>
          {action === "onboard" && domain && (
            <div className="case-actions-row"><CaseDomainSelect caseId={caseId} options={domain.options} defaultDomain={domain.defaultDomain} override={domain.override} started={started} /></div>
          )}
          <div className="actions-menu-sep" />
          <div className="case-actions-row">                                  <ReplanButton caseId={caseId} canReplan={true} started={started} /></div>
        </div>
      </div>
    </div>
  );
}
