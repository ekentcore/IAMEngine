"use client";

// Typing "rickroll" anywhere gets you got. Parody lyrics rewritten for IAM, a tireless CSS
// dancer, and — deliberately — no sound: the melody plays in your head, which is the whole
// point of a rickroll (and keeps the catalog's only fully a-cappella egg honest).
import { createPortal } from "react-dom";
import { useTypedWord } from "./use-typed-word";

const LYRICS = [
  "Never gonna give you up (your licenses, that is)",
  "Never gonna let you down(grade to E1)",
  "Never gonna run around and deprovision you",
  "Never gonna make you cry (at a password reset)",
  "Never gonna say goodbye (without an offboarding case)",
  "Never gonna tell a lie — the audit log remembers everything",
];

const CSS = `
.rr-overlay {
  position: fixed; inset: 0; z-index: 9998; cursor: pointer; text-align: center; color: #fff;
  display: grid; place-items: center;
  background: linear-gradient(135deg, #3b0764 0%, #831843 55%, #7c2d12 100%);
}
.rr-card { max-width: min(640px, calc(100vw - 3rem)); }
.rr-dancer { font-size: 76px; display: inline-block; }
@media (prefers-reduced-motion: no-preference) {
  .rr-dancer { animation: rr-dance 0.6s ease-in-out infinite alternate; }
  @keyframes rr-dance { from { transform: rotate(-8deg) translateY(0); } to { transform: rotate(8deg) translateY(-10px); } }
  .rr-line { animation: rr-in 0.5s ease-out backwards; }
  @keyframes rr-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
}
.rr-line { font-size: clamp(15px, 2.4vw, 20px); font-weight: 700; margin: 0.45rem 0; text-shadow: 0 2px 8px rgba(0,0,0,0.45); }
.rr-sub { font-size: 13px; color: rgba(255,255,255,0.75); margin-top: 1.1rem; }
`;

export function RickrollShow({ onClose }: { onClose: () => void }) {
  return createPortal(
    <div className="rr-overlay" role="dialog" aria-label="You got rickrolled" onClick={onClose}>
      <style>{CSS}</style>
      <div className="rr-card">
        <span className="rr-dancer" aria-hidden>🕺</span>
        {LYRICS.map((line, i) => (
          <p key={line} className="rr-line" style={{ animationDelay: `${i * 0.45}s` }}>{line}</p>
        ))}
        <p className="rr-sub">🔇 Sound deliberately withheld — you know exactly how it goes. Esc or click to be given up.</p>
      </div>
    </div>,
    document.body
  );
}

export function RickrollEgg() {
  const [active, setActive] = useTypedWord("rickroll");
  if (!active) return null;
  return <RickrollShow onClose={() => setActive(false)} />;
}
