"use client";

// Typing "godfather" (any case) on the run log gives every error line the family treatment:
// cream-on-black Godfather-poster serif (Didot/Bodoni stack — no font file is shipped). Esc or
// typing the word again returns the page to normal. Keystrokes inside inputs/textareas are
// ignored, same as the Konami and starwars eggs. Mounted from the shared RunLogTable so all
// /runs versions (v1/v2/v3) get it.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { advanceGodfather, GODFATHER_LENGTH } from "@/lib/eggs/godfather";

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable;
}

// The poster look is a high-contrast didone; Didot ships on macOS, Bodoni MT on Windows.
const GF_FONT = `Didot, "Bodoni 72", "Bodoni MT", "Playfair Display", "Times New Roman", serif`;

// The message cells set their color inline, so the overrides need !important (a stylesheet
// !important beats a normal inline style). Scoped under body.gf-mode + egg-only classes so
// nothing leaks when the mode is off.
const CSS = `
body.gf-mode .gf-err {
  font-family: ${GF_FONT} !important;
  background: #0c0a09 !important;
  color: #f5ead1 !important;
  font-size: 15px !important;
  line-height: 1.55;
  letter-spacing: 0.02em;
}
body.gf-mode .gf-err a { color: #e7c980 !important; }
body.gf-mode .gf-err .note { color: #cbb98f !important; }
body.gf-mode .gf-err-badge {
  font-family: ${GF_FONT} !important;
  background: #0c0a09 !important;
  color: #f5ead1 !important;
  border: 1px solid #e7c980;
}
body.gf-mode h1 { font-family: ${GF_FONT}; letter-spacing: 0.04em; }
body.gf-mode h1::after { content: " 🎩"; }
.gf-hint {
  position: fixed; bottom: 12px; left: 0; right: 0; text-align: center;
  z-index: 9999; pointer-events: none;
}
.gf-hint span {
  display: inline-block; background: #0c0a09; color: #f5ead1; border: 1px solid #e7c980;
  border-radius: 999px; padding: 4px 14px; font-size: 12.5px; font-family: ${GF_FONT};
}
`;

export function GodfatherEgg() {
  const progress = useRef(0);
  const [active, setActive] = useState(false);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (activeRef.current && e.key === "Escape") {
        setActive(false);
        return;
      }
      if (isTypingTarget(e.target)) return;
      progress.current = advanceGodfather(progress.current, e.key);
      if (progress.current === GODFATHER_LENGTH) {
        progress.current = 0;
        setActive((a) => !a);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!active) return;
    document.body.classList.add("gf-mode");
    return () => document.body.classList.remove("gf-mode");
  }, [active]);

  if (!active) return null;

  return (
    <>
      <style>{CSS}</style>
      {/* Portaled to <body>, same as the starwars overlay: a transformed ancestor would become
          the containing block for position:fixed and pin the hint to the table instead. */}
      {createPortal(
        <div className="gf-hint" role="status">
          <span>Every error is an offer you can’t refuse — Esc (or type it again) to leave the family</span>
        </div>,
        document.body
      )}
    </>
  );
}
