"use client";

// The case-detail easter-egg pack — five typed-word "mode" eggs riding egg-only class hooks in
// RunReportView (inert while off, godfather pattern; see /easter-eggs for the field guide):
//   hal               → needs-approval badges become HAL 9000 ("I'm sorry, Dave.")
//   terminator        → completed destructive/disable steps get the T-800 readout (offboards only)
//   officespace       → the Printers manual step gets the parking-lot send-off (PC LOAD LETTER)
//   groundhog         → auto-retry notes wake up at 6:00 on repeat ("Day <attempt>")
//   missionimpossible → arms the password reveal: the card burns after "I saved it"
//   holdmusic         → waiting steps go on hold, with a soft synth loop until you exit
// All exit with Esc or by typing the word again. Everything here is cosmetic.
// The namespace import keeps the module loadable under the node test runner (classic JSX
// transform), which imports CASE_EGG_SKINS — module-scope JSX — via demo-coverage.test.ts.
import * as React from "react";
import { ModeEgg, ModeSkin } from "@/app/_components/eggs/mode-egg";
import { useTypedWord } from "@/app/_components/eggs/use-typed-word";
import { startEggLoop } from "@/app/_components/eggs/egg-audio";
import { EGG_SOUNDS } from "@/lib/eggs/sounds";

const MONO = `ui-monospace, "SF Mono", Menlo, Consolas, monospace`;

// The badges/notes set colors inline, so overrides need stylesheet !important (same reasoning as
// the godfather egg). Animations sit behind prefers-reduced-motion.
const HAL_CSS = `
body.hal-mode .hal-gate {
  background: #000 !important;
  color: #e7e5e4 !important;
  border-color: #dd0000 !important;
}
body.hal-mode .hal-gate::before {
  content: "●";
  color: #dd0000;
  margin-right: 5px;
  text-shadow: 0 0 5px #f00, 0 0 12px #f00, 0 0 22px rgba(255,0,0,0.55);
}
@media (prefers-reduced-motion: no-preference) {
  body.hal-mode .hal-gate::before { animation: hal-pulse 2.4s ease-in-out infinite; }
  @keyframes hal-pulse { 0%, 100% { opacity: 0.55 } 50% { opacity: 1 } }
}
body.hal-mode .hal-gate::after { content: " — I’m sorry, Dave. I’m afraid I can’t do that."; font-style: italic; }
.hal-hint span {
  display: inline-block; background: #000; color: #e7e5e4; border: 1px solid #dd0000;
  border-radius: 999px; padding: 4px 14px; font-size: 12.5px;
}
`;

const T800_CSS = `
body.t800-mode .t800-done {
  background: #1a0000 !important;
  background-image: repeating-linear-gradient(0deg, rgba(255,0,0,0.07) 0 1px, transparent 1px 3px) !important;
  color: #ff5a5a !important;
  font-family: ${MONO} !important;
  text-shadow: 0 0 4px rgba(255, 40, 40, 0.7);
  border-radius: 4px;
}
body.t800-mode .t800-done .note, body.t800-mode .t800-done a { color: #ff9d9d !important; }
body.t800-mode .t800-done .badge { background: #1a0000 !important; color: #ff5a5a !important; border-color: #ff5a5a !important; }
body.t800-mode .t800-done::after {
  content: "TARGET: DEPROVISIONED";
  float: right;
  font-size: 11px;
  letter-spacing: 0.18em;
  border: 1px solid #ff5a5a;
  padding: 1px 6px;
  margin-left: 8px;
}
body.t800-mode h1::after { content: " 🤖"; }
.t800-hint span {
  display: inline-block; background: #1a0000; color: #ff5a5a; border: 1px solid #ff5a5a;
  border-radius: 999px; padding: 4px 14px; font-size: 12.5px; font-family: ${MONO}; letter-spacing: 0.06em;
}
`;

const OS_CSS = `
body.os-mode details.os-printer > summary::after {
  content: "PC LOAD LETTER";
  margin-left: 8px;
  font-family: ${MONO};
  font-size: 11px;
  letter-spacing: 0.12em;
  background: #000;
  color: #7CFC00;
  padding: 1px 7px;
  border-radius: 3px;
}
@media (prefers-reduced-motion: no-preference) {
  body.os-mode details.os-printer {
    /* shake in place, then get dragged to the parking lot; fill:both parks it offscreen until Esc */
    animation: os-smash 3.4s ease-in 0.9s both;
  }
  @keyframes os-smash {
    0% { transform: none; opacity: 1; }
    8% { transform: translate(-3px, 1px) rotate(-0.6deg); }
    16% { transform: translate(4px, -1px) rotate(0.7deg); }
    24% { transform: translate(-5px, 2px) rotate(-0.9deg); }
    32% { transform: translate(5px, -2px) rotate(1deg); }
    40% { transform: translate(-4px, 1px) rotate(-0.7deg); }
    48% { transform: translate(3px, 0) rotate(0.5deg); }
    60% { transform: translateX(12vw) rotate(3deg); opacity: 1; }
    100% { transform: translateX(130vw) rotate(22deg); opacity: 0; }
  }
}
.os-hint span {
  display: inline-block; background: #000; color: #7CFC00; border: 1px solid #7CFC00;
  border-radius: 999px; padding: 4px 14px; font-size: 12.5px; font-family: ${MONO};
}
`;

const GH_CSS = `
body.gh-mode .gh-retry .gh-orig { display: none; }
body.gh-mode .gh-retry::before {
  content: "⏰ 6:00 — Day " attr(data-attempt) ", and it’s still Sonny & Cher. Auto-retry will try again… again.";
  display: inline-block;
  background: #000;
  color: #ff2d2d;
  font-family: ${MONO};
  font-size: 12px;
  letter-spacing: 0.08em;
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid #3a3a3a;
}
.gh-hint span {
  display: inline-block; background: #000; color: #ff2d2d; border: 1px solid #3a3a3a;
  border-radius: 999px; padding: 4px 14px; font-size: 12.5px; font-family: ${MONO};
}
`;

const YSWP_CSS = `
body.yswp-mode .yswp-banner {
  background: #1c1917 !important;
  border-color: #a8a29e !important;
  color: #e7e5e4 !important;
}
body.yswp-mode .yswp-banner a { color: #fcd34d; }
body.yswp-mode .yswp-banner::before {
  content: "🧙 YOU SHALL NOT PASS!";
  display: block;
  font-weight: 900;
  font-size: 19px;
  letter-spacing: 0.14em;
  margin-bottom: 4px;
  color: #fff;
  text-shadow: 0 0 8px rgba(252, 211, 77, 0.8);
}
body.yswp-mode .yswp-blocked::before { content: "YOU SHALL NOT PASS — "; font-weight: 800; letter-spacing: 0.06em; }
@media (prefers-reduced-motion: no-preference) {
  body.yswp-mode .yswp-banner, body.yswp-mode .yswp-blocked { animation: yswp-slam 0.55s ease-out 1; }
  /* the pending-reason hook is an inline span — transforms need a box (the banner is already a div) */
  body.yswp-mode .yswp-blocked { display: inline-block; }
  @keyframes yswp-slam {
    0% { transform: none; }
    20% { transform: translate(-4px, 2px); }
    40% { transform: translate(4px, -2px); }
    60% { transform: translate(-3px, 1px); }
    80% { transform: translate(2px, -1px); }
    100% { transform: none; }
  }
}
.yswp-hint span {
  display: inline-block; background: #1c1917; color: #e7e5e4; border: 1px solid #a8a29e;
  border-radius: 999px; padding: 4px 14px; font-size: 12.5px;
}
`;

const MI_CSS = `
.mi-hint span {
  display: inline-block; background: #000; color: #ffb020; border: 1px solid #ffb020;
  border-radius: 999px; padding: 4px 14px; font-size: 12.5px; font-family: ${MONO}; letter-spacing: 0.04em;
}
/* The burn overlay lives inside the reveal card (generate-password-button.tsx renders it when the
   mode is armed). Charring sweeps down over the content; the ember edge is the box-shadow line. */
.mi-burn-note { color: #b45309; font-family: ${MONO}; font-size: 12px; margin: 0.4rem 0 0; }
.mi-burn-overlay {
  /* negative insets reach past the card's padding + title so the char covers the whole dialog */
  position: absolute; top: -70px; left: -21px; right: -21px; bottom: -18px; border-radius: 10px; pointer-events: none;
  background: linear-gradient(180deg, #0c0a09 0%, #1c1007 70%, rgba(28, 16, 7, 0) 100%);
  box-shadow: 0 6px 14px rgba(255, 120, 0, 0.55);
  clip-path: inset(0 0 100% 0);
}
@media (prefers-reduced-motion: no-preference) {
  .mi-burn-overlay { animation: mi-burn 1.9s ease-in forwards; }
  @keyframes mi-burn { from { clip-path: inset(0 0 100% 0); } to { clip-path: inset(0 0 -6px 0); } }
}
@media (prefers-reduced-motion: reduce) {
  .mi-burn-overlay { clip-path: inset(0 0 -6px 0); }
}
`;

const HM_CSS = `
body.hm-mode .hm-wait::after {
  content: " 🎼 Your step is important to us. Please continue to hold.";
  font-style: italic;
  font-size: 12px;
  color: #6d28d9;
}
@media (prefers-reduced-motion: no-preference) {
  body.hm-mode .hm-wait::after { animation: hm-sway 3.2s ease-in-out infinite; display: inline-block; }
  @keyframes hm-sway { 0%, 100% { transform: none; } 50% { transform: translateY(-1px); } }
}
.hm-hint span {
  display: inline-block; background: #f5f3ff; color: #5b21b6; border: 1px solid #8b5cf6;
  border-radius: 999px; padding: 4px 14px; font-size: 12.5px;
}
`;

// Skin data per egg, exported so the /easter-eggs demo modal can replay the exact same look over
// staged sample markup (ModeSkin). CaseEggs below wires each skin to its trigger word.
export const CASE_EGG_SKINS = {
  hal: {
    bodyClass: "hal-mode",
    css: HAL_CSS,
    hint: <span className="hal-hint"><span>This mission is too important for me to allow you to jeopardize it — Esc (or type it again) to disconnect HAL</span></span>,
  },
  terminator: {
    bodyClass: "t800-mode",
    css: T800_CSS,
    hint: <span className="t800-hint"><span>Hasta la vista, baby — Esc (or type it again) to power down the T-800</span></span>,
  },
  officespace: {
    bodyClass: "os-mode",
    css: OS_CSS,
    hint: <span className="os-hint"><span>PC LOAD LETTER?! — Esc (or type it again) to rescue the printer from the field</span></span>,
  },
  groundhog: {
    bodyClass: "gh-mode",
    css: GH_CSS,
    hint: <span className="gh-hint"><span>Okay campers, rise and shine — Esc (or type it again) to make it February 3rd</span></span>,
  },
  gandalf: {
    bodyClass: "yswp-mode",
    css: YSWP_CSS,
    hint: <span className="yswp-hint"><span>The blocked steps shall not pass (until their requirements resolve) — Esc to return to the Shire</span></span>,
  },
  missionimpossible: {
    bodyClass: "mi-mode",
    css: MI_CSS,
    hint: <span className="mi-hint"><span>Your mission, should you choose to accept it: the next password reveal self-destructs on “I saved it” — Esc to stand down</span></span>,
  },
  holdmusic: {
    bodyClass: "hm-mode",
    css: HM_CSS,
    hint: <span className="hm-hint"><span>🎼 You are caller number 3 — Esc (or type it again) to speak to a representative</span></span>,
  },
} as const;

/** The one case egg with a soundtrack: ModeSkin plus the synth hold-music loop, which starts and
 *  stops with the mode (typing the word is the user gesture the audio needs). */
export function HoldMusicEgg() {
  const [active] = useTypedWord("holdmusic");
  React.useEffect(() => {
    if (active) return startEggLoop(EGG_SOUNDS.holdmusic);
  }, [active]);
  if (!active) return null;
  return <ModeSkin {...CASE_EGG_SKINS.holdmusic} />;
}

export function CaseEggs({ offboard }: { offboard: boolean }) {
  return (
    <>
      <ModeEgg word="hal" {...CASE_EGG_SKINS.hal} />
      {offboard && <ModeEgg word="terminator" {...CASE_EGG_SKINS.terminator} />}
      <ModeEgg word="officespace" {...CASE_EGG_SKINS.officespace} />
      <ModeEgg word="groundhog" {...CASE_EGG_SKINS.groundhog} />
      <ModeEgg word="gandalf" {...CASE_EGG_SKINS.gandalf} />
      <ModeEgg word="missionimpossible" {...CASE_EGG_SKINS.missionimpossible} />
      <HoldMusicEgg />
    </>
  );
}
