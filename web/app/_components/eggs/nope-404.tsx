"use client";

// The 404 rejection — the "no photo of Shaq was harmed" edition. A bouncing basketball plays
// the zero in 404, a giant hand wags NO, and clicking it swats the request into the stands
// with three synthesized "uh-uh-uh" thumps and a referee whistle. Sound is click-to-play only:
// a page load is not a user gesture, so it could never autoplay anyway.
// Rendered by app/not-found.tsx for every URL that doesn't exist; the /easter-eggs demo mounts
// it inline over staged framing.
import { useEffect, useRef } from "react";
import Link from "next/link";
import { playEggSound } from "./egg-audio";
import { EGG_SOUNDS } from "@/lib/eggs/sounds";

const CSS = `
.nope-hero { text-align: center; padding: 3.2rem 1rem 3.6rem; }
.nope-code {
  display: inline-flex; align-items: center; gap: 0.15em;
  font-size: clamp(64px, 14vw, 130px); font-weight: 900; line-height: 1; letter-spacing: 0.04em;
}
.nope-ball { display: inline-block; font-size: 0.82em; }
@media (prefers-reduced-motion: no-preference) {
  .nope-ball { animation: nope-bounce 0.9s cubic-bezier(0.35, 0, 0.65, 1) infinite alternate; }
  @keyframes nope-bounce { from { transform: translateY(-0.16em); } to { transform: translateY(0.1em) scaleY(0.94); } }
  .nope-hand-wag { animation: nope-wag 0.5s ease-in-out infinite alternate; }
  .nope-word { animation: nope-pulse 1.35s ease-in-out infinite; }
  @keyframes nope-wag { from { transform: rotate(-18deg); } to { transform: rotate(18deg); } }
  @keyframes nope-pulse { 0%, 60%, 100% { opacity: 0.35; transform: none; } 15% { opacity: 1; transform: scale(1.14); } }
}
/* The wag rides an inner span so the button itself is a still click target. */
.nope-hand {
  display: inline-block; font-size: clamp(56px, 9vw, 96px);
  cursor: pointer; background: none; border: none; padding: 0 0.2em;
}
.nope-hand-wag { display: inline-block; transform-origin: 50% 88%; }
.nope-words { display: flex; justify-content: center; gap: 0.6em; font-size: clamp(22px, 4vw, 34px); font-weight: 900; letter-spacing: 0.12em; margin: 0.5rem 0 0.9rem; }
.nope-word:nth-child(2) { animation-delay: 0.45s; }
.nope-word:nth-child(3) { animation-delay: 0.9s; }
.nope-title { font-size: clamp(17px, 2.6vw, 22px); font-weight: 700; margin: 0.4rem 0 0.2rem; }
.nope-sub { color: var(--muted, #6b7280); font-size: 13.5px; margin: 0.2rem 0 1.4rem; }
`;

export function NopeShow() {
  // One-shot per click, but keep the last tail stoppable so unmount doesn't strand the whistle.
  const stop = useRef<() => void>(() => {});
  useEffect(() => () => stop.current(), []);

  return (
    <div className="nope-hero">
      <style>{CSS}</style>
      <div className="nope-code" aria-label="404">
        <span>4</span>
        <span className="nope-ball" aria-hidden>🏀</span>
        <span>4</span>
      </div>
      <div>
        <button
          type="button"
          className="nope-hand"
          aria-label="Play the rejection"
          title="Click for the full effect 🔊"
          onClick={() => {
            stop.current();
            stop.current = playEggSound(EGG_SOUNDS.nope);
          }}
        >
          <span className="nope-hand-wag" aria-hidden>🙅</span>
        </button>
      </div>
      <div className="nope-words" aria-hidden>
        <span className="nope-word">NO.</span>
        <span className="nope-word">NO.</span>
        <span className="nope-word">NO.</span>
      </div>
      <p className="nope-title">Not in my house — that page doesn&rsquo;t exist.</p>
      <p className="nope-sub">Get that URL outta here. (Click the hand for the full effect 🔊)</p>
      <Link href="/">Take it back to the top of the key → dashboard</Link>
    </div>
  );
}
