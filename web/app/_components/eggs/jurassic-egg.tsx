"use client";

// Typing "jurassic" anywhere (mounted from the layout, konami pattern) summons Dennis Nedry:
// the wagging-finger "Ah ah ah! You didn't say the magic word!" popup, looping until Esc or a
// click. Pure CSS, no assets, no sound (you're welcome).
import { createPortal } from "react-dom";
import { useTypedWord } from "./use-typed-word";

const CSS = `
.jp-overlay {
  position: fixed; inset: 0; z-index: 9998; background: rgba(1, 6, 12, 0.94); color: #e2e8f0;
  display: grid; place-items: center; cursor: pointer; text-align: center;
}
.jp-card { max-width: min(520px, calc(100vw - 3rem)); }
.jp-finger { font-size: 84px; display: inline-block; transform-origin: 50% 90%; }
@media (prefers-reduced-motion: no-preference) {
  .jp-finger { animation: jp-wag 0.45s ease-in-out infinite alternate; }
  @keyframes jp-wag { from { transform: rotate(-16deg); } to { transform: rotate(16deg); } }
}
.jp-quote { font-size: clamp(20px, 3.4vw, 30px); font-weight: 800; margin: 1rem 0 0.4rem; }
.jp-sub { font-size: 13px; color: #94a3b8; }
`;

/** The Nedry popup itself — mount = show. Click closes; the host (typed-word wrapper or the
 *  /easter-eggs demo) owns Escape. */
export function JurassicShow({ onClose }: { onClose: () => void }) {
  return createPortal(
    <div className="jp-overlay" role="dialog" aria-label="Ah ah ah" onClick={onClose}>
      <style>{CSS}</style>
      <div className="jp-card">
        <span className="jp-finger" aria-hidden>☝️</span>
        <p className="jp-quote">Ah ah ah! You didn&rsquo;t say the magic word!</p>
        <p className="jp-quote" aria-hidden style={{ opacity: 0.55 }}>Ah ah ah! You didn&rsquo;t say the magic word!</p>
        <p className="jp-quote" aria-hidden style={{ opacity: 0.25 }}>Ah ah ah! You didn&rsquo;t say the magic word!</p>
        <p className="jp-sub">Esc or click — please, god damn it, I hate this hacker crap</p>
      </div>
    </div>,
    document.body
  );
}

export function JurassicEgg() {
  const [active, setActive] = useTypedWord("jurassic");
  if (!active) return null;
  return <JurassicShow onClose={() => setActive(false)} />;
}
