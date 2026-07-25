"use client";

// Typing "lawandorder" on /cases opens the cold-open title card over the docket, with the
// two-note DUN DUN (synthesized, lib/eggs/sounds.ts) landing as the card slams in. The typed
// word is the user gesture, so the sound is autoplay-safe. Esc or click closes and cuts the tail.
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useTypedWord } from "@/app/_components/eggs/use-typed-word";
import { playEggSound } from "@/app/_components/eggs/egg-audio";
import { EGG_SOUNDS } from "@/lib/eggs/sounds";

const SERIF = `Georgia, "Times New Roman", serif`;

const CSS = `
.lo-overlay {
  position: fixed; inset: 0; z-index: 9998; background: #000; color: #e7e5e4;
  display: grid; place-items: center; cursor: pointer; text-align: center;
  font-family: ${SERIF};
}
.lo-card { max-width: min(640px, calc(100vw - 3rem)); }
.lo-open { font-size: clamp(15px, 2.2vw, 19px); line-height: 1.7; font-style: italic; color: #d6d3d1; }
.lo-title {
  font-size: clamp(26px, 5vw, 44px); font-weight: 700; letter-spacing: 0.16em; margin: 1.4rem 0 0.3rem;
}
.lo-sub { font-size: clamp(13px, 1.8vw, 16px); letter-spacing: 0.3em; color: #a8a29e; }
.lo-dun {
  font-size: clamp(30px, 6vw, 54px); font-weight: 900; letter-spacing: 0.2em; margin-top: 1.6rem;
  color: #fff;
}
@media (prefers-reduced-motion: no-preference) {
  .lo-card { animation: lo-in 0.4s ease-out; }
  @keyframes lo-in { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: none; } }
  .lo-dun span { display: inline-block; animation: lo-slam 0.35s ease-out backwards; }
  .lo-dun span + span { animation-delay: 0.5s; }
  @keyframes lo-slam { from { opacity: 0; transform: scale(2.4); } to { opacity: 1; transform: none; } }
}
.lo-cases { margin-top: 1.5rem; font-size: 13px; color: #a8a29e; font-style: italic; }
.lo-exit { margin-top: 1.6rem; font-size: 12px; color: #78716c; letter-spacing: 0.08em; }
`;

export function LawAndOrderShow({ cases, onClose }: { cases: string[]; onClose: () => void }) {
  useEffect(() => playEggSound(EGG_SOUNDS.dundun), []);
  return createPortal(
    <div className="lo-overlay" role="dialog" aria-label="Law and order" onClick={onClose}>
      <style>{CSS}</style>
      <div className="lo-card">
        <p className="lo-open">
          In the identity system, the people are represented by two separate yet equally important
          groups: the runners, who execute the steps, and the admins, who approve them.
        </p>
        <div className="lo-title">IAM ENGINE</div>
        <div className="lo-sub">SPECIAL PROVISIONS UNIT</div>
        <div className="lo-dun" aria-hidden><span>DUN</span> <span>DUN</span></div>
        <p className="lo-cases">These are their cases{cases.length ? `: ${cases.slice(0, 3).join(" · ")}` : ""}.</p>
        <p className="lo-exit">Esc or click — the docket resumes</p>
      </div>
    </div>,
    document.body
  );
}

export function LawAndOrderEgg({ cases }: { cases: string[] }) {
  const [active, setActive] = useTypedWord("lawandorder");
  if (!active) return null;
  return <LawAndOrderShow cases={cases} onClose={() => setActive(false)} />;
}
