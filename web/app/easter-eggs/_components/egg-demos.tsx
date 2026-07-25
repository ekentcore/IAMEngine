"use client";

// One demo per live easter egg, keyed by catalog slug — clicking a card on /easter-eggs plays it.
// Two shapes:
//   takeover — mounts the egg's REAL full-screen show (star wars, pirate, matrix, wargames,
//              jurassic) fed with staged sample data; click or Esc returns to the catalog.
//   inline   — plays inside the demo modal: real skins (ModeSkin + the exported egg CSS) over
//              staged sample markup carrying the same class hooks the real pages use.
// Demos never touch real state: no cookies, no localStorage, no cases. Coverage is enforced by
// lib/eggs/demo-coverage.test.ts (every live egg has a demo).
import { useEffect, useState } from "react";
import { ModeSkin } from "@/app/_components/eggs/mode-egg";
import { OccasionBanner } from "@/app/_components/eggs/occasion-banner";
import { fireConfetti } from "@/app/_components/eggs/confetti";
import { EggToast } from "@/app/_components/eggs/egg-toast";
import { CircuitRow } from "@/app/_components/eggs/date-simulator";
import { JurassicShow } from "@/app/_components/eggs/jurassic-egg";
import { StarWarsShow } from "@/app/changelog/_components/starwars-egg";
import { PirateShow } from "@/app/changelog/_components/pirate-egg";
import { MatrixShow } from "@/app/agents/_components/matrix-egg";
import { WarGamesShow } from "@/app/cases/_components/wargames-egg";
import { CASE_EGG_SKINS } from "@/app/cases/_components/case-eggs";
import { GODFATHER_CSS, GODFATHER_HINT } from "@/app/runs/_components/godfather-egg";
import type { ChangelogEntry } from "@/lib/changelog/format";

export type EggDemo = {
  kind: "takeover" | "inline";
  render: (onClose: () => void) => React.ReactNode;
  /** Shown under an inline demo — caveats like "the 📅 simulator is the full preview". */
  note?: string;
};

const MONO = `ui-monospace, "SF Mono", Menlo, Consolas, monospace`;

// ---- staged sample data (clearly fake: demo- ids, DEMO names) -------------------------------

const SAMPLE_ENTRIES: ChangelogEntry[] = [
  {
    id: "demo-onboarding",
    date: "2026-07-24",
    title: "Onboarding wizard learns to fly",
    items: ["New-user cases now plan themselves from the intake form.", "The runner fleet picks up jobs in under a second."],
  },
  {
    id: "demo-offboarding",
    date: "2026-07-23",
    title: "Offboarding sweep tightened",
    items: ["Admin -a accounts are swept alongside the primary.", "Mailboxes convert to shared before the license drops."],
  },
  {
    id: "demo-fleet",
    date: "2026-07-22",
    title: "Fleet setup, but faster",
    items: ["Connection tests sweep all clients automatically."],
  },
];

const SAMPLE_CASES = [
  { label: "IAM0004821 — Jane Doe @ Acme Corp", action: "onboard", status: "running" },
  { label: "IAM0004820 — Sam Roe @ Globex", action: "offboard", status: "waiting_approval" },
  { label: "IAM0004819 — Pat Lee @ Initech", action: "onboard", status: "done" },
];

function sampleAgents(now: number) {
  const online = new Date(now - 5_000).toISOString();
  const offline = new Date(now - 3_600_000).toISOString();
  return [
    { name: "CORE-CCE-DC01", lastSeenAt: online },
    { name: "ACME-RUNNER-01", lastSeenAt: online },
    { name: "GLOBEX-DC02", lastSeenAt: offline },
    { name: "INITECH-AGENT", lastSeenAt: online },
    { name: "CLOUD-CENTRAL", lastSeenAt: online },
  ];
}

// ---- small shared pieces ---------------------------------------------------------------------

/** Frame for staged page markup inside the modal, so samples read as "a slice of the app". */
function Stage({ children, label = "Sample page content" }: { children: React.ReactNode; label?: string }) {
  return (
    <div style={{ border: "1px dashed var(--line)", borderRadius: 8, padding: "0.9rem 1rem", overflow: "hidden" }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--muted)", marginBottom: 8 }}>{label}</div>
      {children}
    </div>
  );
}

function ConfettiToastDemo({ message, sequence }: { message: string; sequence?: string }) {
  const [toast, setToast] = useState(true);
  useEffect(() => {
    fireConfetti();
  }, []);
  return (
    <Stage label="Fires on the real trigger — replayed here">
      {sequence && <p style={{ fontFamily: MONO, fontSize: 15, letterSpacing: "0.2em", margin: "0 0 6px" }}>{sequence}</p>}
      <p className="note" style={{ margin: 0 }}>Confetti bursts over the page and this toast appears:</p>
      <div style={{ marginTop: 8, display: "inline-block", background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 10, padding: "0.6rem 1rem", fontSize: 13 }}>
        {message}
      </div>
      {toast && <EggToast message={message} onDone={() => setToast(false)} />}
    </Stage>
  );
}

// ---- inline demos ----------------------------------------------------------------------------

function BirthdayDemo() {
  return (
    <Stage label="Top-of-page banner, November 14">
      <OccasionBanner banner={{ kind: "birthday", message: "HAPPY BIRTHDAY TO MY CREATOR - EVAN KENT" }} />
    </Stage>
  );
}

function HolidayEveDemo() {
  return (
    <Stage label="Top-of-page banner, the workday before">
      <OccasionBanner banner={{ kind: "holiday-eve", message: "I HOPE YOU HAVE TOMORROW OFF FOR THANKSGIVING" }} />
    </Stage>
  );
}

function GreetingsDemo() {
  return (
    <Stage label="Day-of banners — festive and solemn, stacked when occasions collide">
      <div style={{ display: "grid", gap: 1 }}>
        <OccasionBanner banner={{ kind: "greeting", message: "WISHING YOU A HAPPY AND HEALTHY NEW YEAR", emoji: "🎉" }} />
        <OccasionBanner banner={{ kind: "greeting", message: "REMEMBERING THOSE WHO SERVED THIS MEMORIAL DAY", solemn: true }} />
      </div>
    </Stage>
  );
}

function BulbDemo() {
  const seasons: [string, string][] = [["🎃", "Oct 25–31"], ["🎄", "Dec 20–26"], ["🎆", "Dec 31 – Jan 1"]];
  return (
    <Stage label="The header 💡 feature-request button, by season">
      <div style={{ display: "flex", gap: 18, alignItems: "center" }}>
        {seasons.map(([glyph, when]) => (
          <div key={glyph} style={{ textAlign: "center" }}>
            <button type="button" style={{ padding: "0.15rem 0.4rem", fontSize: 14, lineHeight: 1 }} aria-hidden tabIndex={-1}>{glyph}</button>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>{when}</div>
          </div>
        ))}
      </div>
    </Stage>
  );
}

function ConsoleSignatureDemo() {
  useEffect(() => {
    // The real signature, printed for real — open dev tools to see it land.
    // eslint-disable-next-line no-console
    console.log(
      "%c  iam-engine  %c\n\nCrafted by Evan Kent · 2026.\nDebugging? Check /docs first.\n",
      "background:#1e293b;color:#f59e0b;font-size:16px;font-weight:bold;padding:4px 8px;border-radius:4px",
      ""
    );
  }, []);
  return (
    <Stage label="Printed to the dev-tools console (just did — press F12)">
      <div style={{ background: "#0f172a", borderRadius: 8, padding: "0.9rem 1rem", fontFamily: MONO, fontSize: 13, color: "#cbd5e1" }}>
        <span style={{ background: "#1e293b", color: "#f59e0b", fontWeight: 700, fontSize: 15, padding: "4px 8px", borderRadius: 4 }}>  iam-engine  </span>
        <p style={{ margin: "10px 0 0", whiteSpace: "pre-wrap" }}>{"Crafted by Evan Kent · 2026.\nDebugging? Check /docs first."}</p>
      </div>
    </Stage>
  );
}

function CreditsDemo() {
  return (
    <Stage label="The unlinked /credits page, live">
      <iframe src="/credits" title="/credits" style={{ width: "100%", height: 300, border: "1px solid var(--line)", borderRadius: 8, background: "#000" }} />
      <p className="note" style={{ margin: "8px 0 0" }}>
        <a href="/credits" target="_blank" rel="noreferrer">Open /credits in a new tab</a>
      </p>
    </Stage>
  );
}

function LogoSpinDemo() {
  return (
    <Stage label="The header brand, right after the 7th click">
      <span style={{ fontWeight: 700, fontSize: 17 }}>
        <span className="egg-spin" style={{ display: "inline-block" }}>Evan&apos;s IAM Engine</span>
      </span>
      <p className="note" style={{ margin: "8px 0 0" }}>Spins once and keeps the new name until the next navigation.</p>
    </Stage>
  );
}

function MilestoneDemo() {
  return (
    <Stage label="A case heading whose number is a multiple of 1000">
      <h2 style={{ margin: 0, fontSize: 18 }}>
        IAM0004000<span title="milestone case" aria-label="milestone case"> ✨</span> — Jane Doe @ Acme Corp
      </h2>
    </Stage>
  );
}

function DateSimulatorDemo() {
  return (
    <Stage label="The strip shown while a simulation is active">
      <div style={{ background: "#4c1d95", color: "#fff", padding: "0.35rem 1rem", display: "flex", alignItems: "center", justifyContent: "center", gap: 12, fontSize: 12, borderRadius: 6 }}>
        <span>📅 Simulated date: <strong>2026-12-25</strong> — easter-egg preview only</span>
        <span style={{ fontSize: 12, padding: "0.15rem 0.6rem", background: "#fff", color: "#4c1d95", borderRadius: 6, fontWeight: 600 }}>Reset</span>
      </div>
    </Stage>
  );
}

function BttfDemo() {
  return (
    <Stage label="The simulated-date strip after typing “bttf”">
      <div style={{ position: "relative", overflow: "hidden", borderRadius: 6 }}>
        <div style={{ background: "linear-gradient(180deg, #292524, #1c1917)", borderBottom: "1px solid #44403c", padding: "0.5rem 1rem", display: "flex", alignItems: "center", justifyContent: "center", gap: 16, flexWrap: "wrap", fontSize: 12 }}>
          <span style={{ fontSize: 14 }} aria-hidden>⚡</span>
          <CircuitRow label="DESTINATION TIME" date="2026-12-25" color="#ff3b30" />
          <CircuitRow label="PRESENT TIME" date="2026-07-24" color="#34d399" />
          <CircuitRow label="LAST TIME DEPARTED" date="2026-07-24" color="#fbbf24" />
          <span style={{ color: "#a8a29e", fontFamily: MONO, fontSize: 10, letterSpacing: "0.1em" }}>88 MPH — Esc to return to 1985</span>
        </div>
        <div aria-hidden style={{ position: "absolute", inset: 0, pointerEvents: "none", background: "#fff", animation: "egg-demo-flux 0.65s ease-out forwards" }}>
          <style>{`@keyframes egg-demo-flux { from { opacity: 1 } to { opacity: 0 } }`}</style>
        </div>
      </div>
    </Stage>
  );
}

function GodfatherDemo() {
  useEffect(() => {
    document.body.classList.add("gf-mode");
    return () => document.body.classList.remove("gf-mode");
  }, []);
  return (
    <>
      <style>{GODFATHER_CSS}</style>
      <Stage label="Run-log rows on /runs — errors get the family treatment">
        <div style={{ display: "grid", gap: 6, fontSize: 13 }}>
          <div>
            <span className="badge" style={{ marginRight: 8 }}>ok</span>
            <span style={{ color: "var(--muted)" }}>M365 license assigned — E3 seat confirmed.</span>
          </div>
          <div>
            <span className="gf-err-badge" style={{ borderRadius: 6, padding: "1px 7px", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", marginRight: 8 }}>failed</span>
            <span className="gf-err" style={{ padding: "2px 6px", borderRadius: 4 }}>Connect-ExchangeOnline: the mailbox left the meeting and it took the session with it.</span>
          </div>
        </div>
      </Stage>
      <div className="gf-hint" role="status"><span>{GODFATHER_HINT}</span></div>
    </>
  );
}

function HalDemo() {
  return (
    <>
      <ModeSkin {...CASE_EGG_SKINS.hal} />
      <Stage label="A step waiting for approval on a case">
        <div style={{ fontSize: 13 }}>
          Remove all licenses — Entra ID{" "}
          <span className="badge hal-gate" style={{ color: "#b45309", borderColor: "#b45309" }}>needs approval</span>
        </div>
      </Stage>
    </>
  );
}

function TerminatorDemo() {
  return (
    <>
      <ModeSkin {...CASE_EGG_SKINS.terminator} />
      <Stage label="Completed destructive steps on an offboard case">
        <div style={{ display: "grid", gap: 6 }}>
          <details open>
            <summary className="t800-done" style={{ padding: "3px 6px" }}>Disable account — Active Directory <span className="badge">verified</span></summary>
          </details>
          <details open>
            <summary className="t800-done" style={{ padding: "3px 6px" }}>Revoke sessions — Entra ID <span className="badge">verified</span></summary>
          </details>
        </div>
      </Stage>
    </>
  );
}

function OfficeSpaceDemo() {
  return (
    <>
      <ModeSkin {...CASE_EGG_SKINS.officespace} />
      <Stage label="The Printers manual step — watch it go">
        <details open className="os-printer">
          <summary>Assign office printers — manual step</summary>
          <div className="note" style={{ fontSize: 12 }}>Recorded as a checklist item on the case.</div>
        </details>
      </Stage>
    </>
  );
}

function GroundhogDemo() {
  return (
    <>
      <ModeSkin {...CASE_EGG_SKINS.groundhog} />
      <Stage label="A step waiting on auto-retry">
        <div style={{ fontSize: 13 }}>Sync vendor directory — Spanning</div>
        <p className="note gh-retry" data-attempt={4} style={{ marginTop: 4, color: "#8a6d00" }}>
          <span className="gh-orig">Auto-retry 4 of 5 — next attempt in 3m</span>
        </p>
      </Stage>
    </>
  );
}

function GandalfDemo() {
  return (
    <>
      <ModeSkin {...CASE_EGG_SKINS.gandalf} />
      <Stage label="The missing-credentials banner and a blocked step">
        <div className="yswp-banner" style={{ margin: "0 0 0.6rem", padding: "0.5rem 0.7rem", borderRadius: 6, border: "1px solid #fde68a", background: "#fffbeb", color: "#92400e", fontSize: 13 }}>
          Missing credentials: <strong>ad-dc</strong> — steps that need them are blocked.
        </div>
        <div style={{ fontSize: 13 }}>
          Create account — Active Directory{" "}
          <span className="yswp-blocked" style={{ marginLeft: 8, fontSize: 12, color: "#b3261e" }}>blocked: waiting on credential ad-dc</span>
        </div>
      </Stage>
    </>
  );
}

function MissionImpossibleDemo() {
  const [burning, setBurning] = useState(false);
  return (
    <>
      <ModeSkin {...CASE_EGG_SKINS.missionimpossible} />
      <Stage label="The one-time password reveal, with the mode armed">
        <div style={{ position: "relative", overflow: "hidden", border: "1px solid var(--line)", borderRadius: 8, padding: "0.8rem 1rem", maxWidth: 380 }}>
          <div style={{ fontFamily: MONO, fontSize: 15, letterSpacing: "0.06em" }}>Vx7#kq2Lp!9c</div>
          {!burning && <p className="mi-burn-note">🧨 This password will self-destruct when you click &ldquo;I saved it.&rdquo;</p>}
          {burning && <p className="mi-burn-note">Good luck. This message has self-destructed. 💥</p>}
          <div style={{ marginTop: 8 }}>
            <button type="button" className="primary" onClick={() => setBurning(true)} disabled={burning}>I saved it</button>
          </div>
          {burning && <div className="mi-burn-overlay" aria-hidden />}
        </div>
      </Stage>
    </>
  );
}

// ---- the registry ----------------------------------------------------------------------------

export const EGG_DEMOS: Record<string, EggDemo> = {
  "birthday-banner": { kind: "inline", render: () => <BirthdayDemo /> },
  "date-simulator": {
    kind: "inline",
    render: () => <DateSimulatorDemo />,
    note: "This one IS the demo tool — the real 📅 button in the header previews every date-driven egg.",
  },
  "holiday-eve-banner": { kind: "inline", render: () => <HolidayEveDemo /> },
  "holiday-greetings": {
    kind: "inline",
    render: () => <GreetingsDemo />,
    note: "Preview any specific holiday for real with the 📅 date simulator.",
  },
  "holiday-bulb": { kind: "inline", render: () => <BulbDemo /> },
  "new-year-confetti": {
    kind: "inline",
    render: () => <ConfettiToastDemo message="Happy New Year from IAM Engine 🎆 (2027)" />,
    note: "The real one fires once per person per year — this replay doesn't spend it.",
  },
  konami: { kind: "inline", render: () => <ConfettiToastDemo message="IAM Engine — built by Evan Kent, 2026 · see /credits" sequence="↑ ↑ ↓ ↓ ← → ← → B A" /> },
  "console-signature": { kind: "inline", render: () => <ConsoleSignatureDemo /> },
  "credits-page": { kind: "inline", render: () => <CreditsDemo /> },
  "logo-7-click": { kind: "inline", render: () => <LogoSpinDemo /> },
  "milestone-sparkle": { kind: "inline", render: () => <MilestoneDemo /> },
  "starwars-crawl": { kind: "takeover", render: (onClose) => <StarWarsShow entries={SAMPLE_ENTRIES} onClose={onClose} /> },
  "godfather-mode": { kind: "inline", render: () => <GodfatherDemo /> },
  "pirate-battle": { kind: "takeover", render: (onClose) => <PirateShow entries={SAMPLE_ENTRIES} onClose={onClose} /> },
  "matrix-agents": { kind: "takeover", render: (onClose) => <MatrixShow agents={sampleAgents(Date.now())} now={Date.now()} onClose={onClose} /> },
  "hal-approval": { kind: "inline", render: () => <HalDemo /> },
  "mission-impossible-reveal": { kind: "inline", render: () => <MissionImpossibleDemo /> },
  "terminator-offboard": { kind: "inline", render: () => <TerminatorDemo /> },
  "wargames-dashboard": { kind: "takeover", render: (onClose) => <WarGamesShow cases={SAMPLE_CASES} onClose={onClose} /> },
  "jurassic-denied": { kind: "takeover", render: (onClose) => <JurassicShow onClose={onClose} /> },
  "office-space-printer": { kind: "inline", render: () => <OfficeSpaceDemo /> },
  "groundhog-retries": { kind: "inline", render: () => <GroundhogDemo /> },
  "bttf-time-circuits": { kind: "inline", render: () => <BttfDemo /> },
  "gandalf-blocked": { kind: "inline", render: () => <GandalfDemo /> },
};
