"use client";

// Typing "airhorn" on /changelog gives the newest entry the reception every ship deserves:
// a gold SHIPPED banner pumping over it (riding the ah-newest hook in ChangelogView — inert
// while off) and a synthesized triple airhorn blast. Esc or retyping exits and cuts the tail.
// Namespace import: AIRHORN_SKIN holds module-scope JSX and the node test runner (classic JSX
// transform) loads this file via demo-coverage.test.ts — same reasoning as case-eggs.tsx.
import * as React from "react";
import { ModeSkin } from "@/app/_components/eggs/mode-egg";
import { useTypedWord } from "@/app/_components/eggs/use-typed-word";
import { playEggSound } from "@/app/_components/eggs/egg-audio";
import { EGG_SOUNDS } from "@/lib/eggs/sounds";

const AIRHORN_CSS = `
body.airhorn-mode .ah-newest {
  outline: 3px solid #f59e0b;
  outline-offset: 2px;
  position: relative;
}
body.airhorn-mode .ah-newest::before {
  content: "📣 SHIPPED 📣";
  position: absolute; top: -14px; right: 12px;
  background: #f59e0b; color: #451a03; font-weight: 900; letter-spacing: 0.18em;
  font-size: 12px; padding: 2px 10px; border-radius: 999px;
}
@media (prefers-reduced-motion: no-preference) {
  body.airhorn-mode .ah-newest { animation: ah-pump 0.6s ease-in-out 3; }
  @keyframes ah-pump { 0%, 100% { transform: none; } 50% { transform: scale(1.012); } }
}
.ah-hint span {
  display: inline-block; background: #451a03; color: #fbbf24; border: 1px solid #f59e0b;
  border-radius: 999px; padding: 4px 14px; font-size: 12.5px;
}
`;

export const AIRHORN_SKIN = {
  bodyClass: "airhorn-mode",
  css: AIRHORN_CSS,
  hint: <span className="ah-hint"><span>📣 bwaa bwaa bwaaaaa — Esc (or type it again) to holster the airhorn</span></span>,
} as const;

export function AirhornEgg() {
  const [active] = useTypedWord("airhorn");
  React.useEffect(() => {
    if (active) return playEggSound(EGG_SOUNDS.airhorn);
  }, [active]);
  if (!active) return null;
  return <ModeSkin {...AIRHORN_SKIN} />;
}
