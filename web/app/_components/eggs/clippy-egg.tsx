"use client";

// Typing "clippy" anywhere summons Clipper, a fully original bent-wire office assistant with
// absolutely no living relatives at any large software company. One page-aware line
// (lib/eggs/clippy.ts), one boing (synthesized), dismissed by Esc or a click on the bubble.
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { useTypedWord } from "./use-typed-word";
import { playEggSound } from "./egg-audio";
import { EGG_SOUNDS } from "@/lib/eggs/sounds";
import { clippyLine } from "@/lib/eggs/clippy";

const CSS = `
.clp-wrap {
  position: fixed; right: 22px; bottom: 20px; z-index: 9998; display: flex; align-items: flex-end;
  gap: 10px; cursor: pointer; max-width: min(360px, calc(100vw - 3rem));
}
@media (prefers-reduced-motion: no-preference) {
  .clp-wrap { animation: clp-pop 0.35s cubic-bezier(0.2, 1.6, 0.4, 1); }
  @keyframes clp-pop { from { transform: translateY(30px) scale(0.6); opacity: 0; } to { transform: none; opacity: 1; } }
  .clp-clip { animation: clp-tilt 2.6s ease-in-out infinite; transform-origin: 50% 90%; }
  @keyframes clp-tilt { 0%, 100% { transform: rotate(-6deg); } 50% { transform: rotate(8deg); } }
}
.clp-bubble {
  background: #fffbdd; color: #1f2937; border: 1px solid #d4c88a; border-radius: 10px;
  border-bottom-right-radius: 2px; padding: 0.65rem 0.85rem; font-size: 13.5px; line-height: 1.45;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
}
.clp-bubble .clp-x { display: block; margin-top: 6px; font-size: 11.5px; color: #92702a; }
.clp-clip { font-size: 44px; line-height: 1; filter: drop-shadow(0 3px 4px rgba(0,0,0,0.3)); }
`;

export function ClippyShow({ pathname, onClose }: { pathname: string; onClose: () => void }) {
  useEffect(() => playEggSound(EGG_SOUNDS.boing), []);
  return createPortal(
    <div className="clp-wrap" role="dialog" aria-label="Clipper" onClick={onClose}>
      <style>{CSS}</style>
      <div className="clp-bubble">
        {clippyLine(pathname)}
        <span className="clp-x">Esc or click to send Clipper back to 1997</span>
      </div>
      <span className="clp-clip" aria-hidden>📎</span>
    </div>,
    document.body
  );
}

export function ClippyEgg() {
  const [active, setActive] = useTypedWord("clippy");
  const pathname = usePathname() ?? "/";
  if (!active) return null;
  return <ClippyShow pathname={pathname} onClose={() => setActive(false)} />;
}
