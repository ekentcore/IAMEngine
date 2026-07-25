"use client";

// Typing "womp" on /runs gives every failed row the sad trombone it deserves: a 🎺 lead-in on
// the failure text (riding the same gf-err hooks the godfather egg uses — inert while off) and
// one synthesized wah-wah-wah-waaah as the mode lands. Esc or retyping exits and cuts the tail.
// Namespace import: WOMP_SKIN holds module-scope JSX and the node test runner (classic JSX
// transform) loads this file via demo-coverage.test.ts — same reasoning as case-eggs.tsx.
import * as React from "react";
import { ModeSkin } from "@/app/_components/eggs/mode-egg";
import { useTypedWord } from "@/app/_components/eggs/use-typed-word";
import { playEggSound } from "@/app/_components/eggs/egg-audio";
import { EGG_SOUNDS } from "@/lib/eggs/sounds";

const WOMP_CSS = `
body.womp-mode .gf-err::before { content: "🎺 womp womp — "; font-style: normal; }
body.womp-mode .gf-err { font-style: italic; }
body.womp-mode .gf-err-badge { filter: grayscale(0.55); }
@media (prefers-reduced-motion: no-preference) {
  body.womp-mode .gf-err-badge { animation: womp-sag 2.2s ease-in-out infinite; display: inline-block; }
  @keyframes womp-sag { 0%, 100% { transform: none; } 50% { transform: translateY(2px) rotate(-2deg); } }
}
.womp-hint span {
  display: inline-block; background: #292524; color: #fbbf24; border: 1px solid #78716c;
  border-radius: 999px; padding: 4px 14px; font-size: 12.5px;
}
`;

export const WOMP_SKIN = {
  bodyClass: "womp-mode",
  css: WOMP_CSS,
  hint: <span className="womp-hint"><span>🎺 wah, wah, wah, waaah — Esc (or type it again) to put the trombone away</span></span>,
} as const;

export function WompEgg() {
  const [active] = useTypedWord("womp");
  React.useEffect(() => {
    if (active) return playEggSound(EGG_SOUNDS.trombone);
  }, [active]);
  if (!active) return null;
  return <ModeSkin {...WOMP_SKIN} />;
}
