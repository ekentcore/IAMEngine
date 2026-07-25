"use client";

// March 22: confetti bursts and the wedding photo takes the screen with a big "Whoo Hoo!" —
// once per person per year (localStorage-guarded, new-year pattern). Rendered only when the
// layout's occasion state says it's the day; the photo ships at /eggs/wedding.jpg.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { fireConfetti } from "./confetti";

const CSS = `
.anniv-overlay {
  position: fixed; inset: 0; z-index: 9998; background: rgba(1, 6, 12, 0.9);
  display: grid; place-items: center; cursor: pointer; text-align: center; padding: 1.5rem;
}
.anniv-card {
  background: #fff; color: #1c1917; border-radius: 10px; padding: 1rem 1rem 1.2rem;
  max-width: min(680px, 100%); box-shadow: 0 24px 80px rgba(0,0,0,.5);
}
.anniv-photo {
  display: block; max-width: 100%; max-height: min(62vh, 640px); border-radius: 6px;
}
.anniv-whoo { font-size: clamp(28px, 5vw, 44px); font-weight: 800; margin: 0.7rem 0 0.15rem; }
@media (prefers-reduced-motion: no-preference) {
  .anniv-whoo { animation: anniv-pop 0.5s cubic-bezier(0.2, 1.6, 0.4, 1) both; }
  @keyframes anniv-pop { from { transform: scale(0.4); opacity: 0; } to { transform: scale(1); opacity: 1; } }
}
.anniv-sub { font-size: 13px; color: #78716c; margin: 0; }
`;

/** The show itself — mount = confetti + the photo. Click closes; the host (the real egg below
 *  or the /easter-eggs demo) owns Escape. */
export function AnniversaryShow({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    fireConfetti();
  }, []);
  return createPortal(
    <div className="anniv-overlay" role="dialog" aria-label="Whoo Hoo" onClick={onClose}>
      <style>{CSS}</style>
      <div className="anniv-card">
        {/* eslint-disable-next-line @next/next/no-img-element -- fixed local asset, no optimizer needed */}
        <img className="anniv-photo" src="/eggs/wedding.jpg" alt="The wedding photo" />
        <p className="anniv-whoo">Whoo Hoo! 🎉</p>
        <p className="anniv-sub">March 22 — Esc or click to close</p>
      </div>
    </div>,
    document.body
  );
}

export function AnniversaryEgg({ year }: { year: string }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const key = `iam-eggs-anniversary-${year}`;
    try {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, "1");
    } catch {
      return; // storage unavailable -> skip rather than fire on every load
    }
    setShow(true);
  }, [year]);

  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShow(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [show]);

  if (!show) return null;
  return <AnniversaryShow onClose={() => setShow(false)} />;
}
