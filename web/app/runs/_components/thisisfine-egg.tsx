"use client";

// Typing "thisisfine" on /runs sets the failures gently on fire: failed rows get the ember
// treatment (same inert gf-err hooks as the godfather/womp eggs), a flame line flickers along
// the bottom of the viewport, and the hint dog insists everything is fine. Silent by design —
// the whole joke is the calm. Esc or retyping exits.
// Namespace import: FINE_SKIN holds module-scope JSX and the node test runner (classic JSX
// transform) loads this file via demo-coverage.test.ts — same reasoning as case-eggs.tsx.
import * as React from "react";
import { ModeEgg } from "@/app/_components/eggs/mode-egg";

const FINE_CSS = `
body.fine-mode .gf-err {
  background: linear-gradient(90deg, rgba(234, 88, 12, 0.16), rgba(250, 204, 21, 0.1)) !important;
  border-radius: 4px;
  box-shadow: inset 2px 0 0 #ea580c;
}
body.fine-mode .gf-err::after { content: " 🔥"; }
body.fine-mode::after {
  content: "🔥 🔥 🔥 🔥 🔥 🔥 🔥 🔥 🔥 🔥 🔥 🔥 🔥 🔥 🔥 🔥 🔥 🔥 🔥 🔥";
  position: fixed; bottom: -6px; left: 0; right: 0; text-align: center; font-size: 26px;
  letter-spacing: 0.4em; pointer-events: none; z-index: 9997; white-space: nowrap; overflow: hidden;
}
@media (prefers-reduced-motion: no-preference) {
  body.fine-mode::after { animation: fine-flicker 0.8s ease-in-out infinite alternate; }
  @keyframes fine-flicker { from { transform: translateY(2px) scaleY(0.96); opacity: 0.85; } to { transform: none; opacity: 1; } }
}
.fine-hint span {
  display: inline-block; background: #fff7ed; color: #7c2d12; border: 1px solid #ea580c;
  border-radius: 999px; padding: 4px 14px; font-size: 12.5px;
}
`;

export const FINE_SKIN = {
  bodyClass: "fine-mode",
  css: FINE_CSS,
  hint: <span className="fine-hint"><span>🐶☕ This is fine. — Esc (or type it again) to call the fire department</span></span>,
} as const;

export function ThisIsFineEgg() {
  return <ModeEgg word="thisisfine" {...FINE_SKIN} />;
}
