"use client";

// Typing "mario" anywhere drops a ? block from the sky. Bonk it: a coin pops with the classic
// two-note chirp (synthesized — lib/eggs/sounds.ts) and the counter climbs. Click outside or
// Esc to close. Each bonk is a click, so autoplay policy is always satisfied.
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTypedWord } from "./use-typed-word";
import { playEggSound } from "./egg-audio";
import { EGG_SOUNDS } from "@/lib/eggs/sounds";

const CSS = `
.mar-overlay {
  position: fixed; inset: 0; z-index: 9998; background: rgba(8, 12, 36, 0.86);
  display: grid; place-items: center; cursor: pointer; text-align: center; color: #e2e8f0;
}
.mar-stage { position: relative; padding: 90px 40px 0; cursor: default; }
.mar-block {
  width: 92px; height: 92px; border: none; cursor: pointer; border-radius: 8px;
  background: linear-gradient(180deg, #fbbf24, #d97706);
  box-shadow: inset -6px -8px 0 rgba(0,0,0,0.28), inset 6px 6px 0 rgba(255,255,255,0.35);
  color: #7c2d12; font-size: 44px; font-weight: 900; font-family: ui-monospace, Menlo, monospace;
}
@media (prefers-reduced-motion: no-preference) {
  .mar-block:not(:disabled) { animation: mar-drop 0.5s ease-out; }
  .mar-block.mar-bonk { animation: mar-bump 0.25s ease-out; }
  @keyframes mar-drop { from { transform: translateY(-40vh); } to { transform: none; } }
  @keyframes mar-bump { 30% { transform: translateY(-14px); } 100% { transform: none; } }
}
.mar-coin {
  position: absolute; left: 50%; top: 60px; font-size: 34px; pointer-events: none;
  animation: mar-coin 0.7s ease-out forwards;
}
@keyframes mar-coin { from { transform: translate(-50%, 0); opacity: 1; } to { transform: translate(-50%, -110px); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .mar-coin { animation-duration: 0.01s; } }
.mar-count { margin-top: 18px; font-family: ui-monospace, Menlo, monospace; font-size: 18px; font-weight: 700; }
.mar-sub { font-size: 13px; color: #94a3b8; margin-top: 10px; }
`;

export function MarioShow({ onClose }: { onClose: () => void }) {
  const [coins, setCoins] = useState<number[]>([]);
  const total = useRef(0);
  const nextId = useRef(0);

  function bonk(e: React.MouseEvent<HTMLButtonElement>) {
    e.stopPropagation();
    playEggSound(EGG_SOUNDS.coin);
    total.current += 1;
    const id = nextId.current++;
    setCoins((c) => [...c, id]);
    setTimeout(() => setCoins((c) => c.filter((x) => x !== id)), 750);
    const el = e.currentTarget;
    el.classList.remove("mar-bonk");
    // Restart the bump animation even on rapid-fire clicks.
    void el.offsetWidth;
    el.classList.add("mar-bonk");
  }

  return createPortal(
    <div className="mar-overlay" role="dialog" aria-label="Coin block" onClick={onClose}>
      <style>{CSS}</style>
      <div className="mar-stage" onClick={(e) => e.stopPropagation()}>
        {coins.map((id) => (
          <span key={id} className="mar-coin" aria-hidden>🪙</span>
        ))}
        <button type="button" className="mar-block" onClick={bonk} aria-label="Bonk the block">?</button>
        <div className="mar-count" aria-live="polite">🪙 × {total.current}</div>
        <p className="mar-sub">It&rsquo;s-a me, provisioning! — Esc or click away when the coins stop being funny</p>
      </div>
    </div>,
    document.body
  );
}

export function MarioEgg() {
  const [active, setActive] = useTypedWord("mario");
  if (!active) return null;
  return <MarioShow onClose={() => setActive(false)} />;
}
