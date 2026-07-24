"use client";

// Typing "starwars" (any case) on the change log shakes the screen, then replays the log as an
// opening crawl — starfield, tilted yellow scroll, the works. Esc or a click returns to the page.
// Keystrokes inside inputs/textareas are ignored, same as the Konami egg.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { advanceStarwars, galacticize, STARWARS_LENGTH } from "@/lib/eggs/starwars";
import type { ChangelogEntry } from "@/lib/changelog/entries";

// A full log is hundreds of entries — a crawl of all of them would outlast the trilogy.
const CRAWL_ENTRIES = 8;
const SHAKE_MS = 750;

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable;
}

const CSS = `
@keyframes sw-shake {
  0%, 100% { transform: translate(0, 0); }
  10% { transform: translate(-8px, 4px); }
  20% { transform: translate(9px, -5px); }
  30% { transform: translate(-10px, -3px); }
  40% { transform: translate(8px, 6px); }
  50% { transform: translate(-6px, -6px); }
  60% { transform: translate(10px, 3px); }
  70% { transform: translate(-7px, 5px); }
  80% { transform: translate(6px, -4px); }
  90% { transform: translate(-4px, 2px); }
}
body.sw-shaking { animation: sw-shake ${SHAKE_MS}ms ease-in-out; }
.sw-overlay {
  position: fixed; inset: 0; z-index: 9999; overflow: hidden; cursor: pointer;
  background-color: #000;
  background-image: radial-gradient(1px 1px at 15% 25%, #fff, transparent),
    radial-gradient(1px 1px at 65% 15%, #fff9, transparent),
    radial-gradient(2px 2px at 85% 55%, #fff, transparent),
    radial-gradient(1px 1px at 35% 75%, #fffc, transparent),
    radial-gradient(1px 1px at 55% 45%, #fff8, transparent),
    radial-gradient(2px 2px at 10% 85%, #fffa, transparent),
    radial-gradient(1px 1px at 90% 90%, #fff, transparent),
    radial-gradient(1px 1px at 45% 5%, #fffb, transparent);
  background-size: 240px 240px;
}
.sw-intro {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  padding: 2rem; text-align: center; color: #4bd5ee; font-size: clamp(20px, 4vw, 34px);
  animation: sw-intro 5s ease-out forwards;
}
@keyframes sw-intro { 0% { opacity: 0; } 15% { opacity: 1; } 80% { opacity: 1; } 100% { opacity: 0; visibility: hidden; } }
.sw-stage { position: absolute; inset: 0; perspective: 400px; overflow: hidden; }
.sw-crawl {
  position: absolute; inset: 0;
  transform-origin: 50% 100%;
  transform: rotateX(58deg);
}
.sw-scroll {
  position: absolute; top: 100%; left: 50%; width: min(92vw, 880px);
  color: #ffe81f; text-align: justify; font-weight: 700; overflow-wrap: break-word;
  font-size: clamp(20px, 4vw, 36px); line-height: 1.6;
  animation: sw-scroll var(--sw-duration, 90s) linear 4.5s forwards;
  transform: translateX(-50%);
}
@keyframes sw-scroll { to { transform: translateX(-50%) translateY(calc(-100% - 100vh)); } }
.sw-scroll h2 { color: #ffe81f; text-align: center; font-size: 1.6em; margin: 0 0 0.4em; }
.sw-scroll h3 { color: #ffe81f; text-align: center; font-size: 1.1em; margin: 2em 0 0.5em; }
.sw-scroll p { margin: 0 0 0.9em; }
.sw-scroll .sw-when { text-align: center; font-size: 0.6em; opacity: 0.8; margin-bottom: 1em; }
.sw-hint {
  position: absolute; bottom: 12px; left: 0; right: 0; text-align: center;
  color: #888; font-size: 12px; animation: sw-intro 5s ease-out 1s forwards reverse; opacity: 0.7;
}
@media (prefers-reduced-motion: reduce) {
  body.sw-shaking { animation: none; }
  .sw-intro { animation: none; position: static; padding-bottom: 0; }
  .sw-overlay { overflow-y: auto; }
  .sw-stage { position: static; perspective: none; overflow: visible; }
  .sw-crawl { position: static; transform: none; }
  .sw-scroll { position: static; animation: none; transform: none; font-size: 18px; margin: 0 auto; padding: 2rem 0 4rem; }
}
`;

export function StarWarsEgg({ entries }: { entries: ChangelogEntry[] }) {
  const progress = useRef(0);
  const [phase, setPhase] = useState<"idle" | "shaking" | "crawl">("idle");
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (phaseRef.current === "crawl") {
        if (e.key === "Escape") setPhase("idle");
        return;
      }
      if (phaseRef.current !== "idle" || isTypingTarget(e.target)) return;
      progress.current = advanceStarwars(progress.current, e.key);
      if (progress.current === STARWARS_LENGTH) {
        progress.current = 0;
        setPhase("shaking");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (phase !== "shaking") return;
    document.body.classList.add("sw-shaking");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t = setTimeout(() => setPhase("crawl"), reduced ? 0 : SHAKE_MS);
    return () => {
      document.body.classList.remove("sw-shaking");
      clearTimeout(t);
    };
  }, [phase]);

  if (phase === "idle") return null;

  const crawlEntries = entries.slice(0, CRAWL_ENTRIES);
  // ~18s per entry keeps the pace readable; the classic crawl runs about 85s.
  const duration = `${Math.max(70, crawlEntries.length * 18)}s`;

  return (
    <>
      <style>{CSS}</style>
      {/* Portaled to <body>: an ancestor with a transform/filter would otherwise become the
          containing block for position:fixed, leaving the header uncovered. */}
      {phase === "crawl" && createPortal(
        <div className="sw-overlay" role="dialog" aria-label="Change log, opening-crawl edition" onClick={() => setPhase("idle")}>
          <div className="sw-intro">A long time ago in a data center far, far away....</div>
          <div className="sw-stage">
            <div className="sw-crawl">
              <div className="sw-scroll" style={{ "--sw-duration": duration } as React.CSSProperties}>
                <h2>Episode MMXXVI</h2>
                <h2>THE CHANGE LOG</h2>
                <p>It is a period of relentless shipping. Rebel engineers, striking from a hidden repo, have won their first victories against the evil Galactic Backlog. Across two hundred star systems, the Empire's grip weakens with every release. These are the Rebellion's latest dispatches….</p>
                {crawlEntries.map((e) => (
                  <div key={e.id}>
                    <h3>{galacticize(e.title)}</h3>
                    <p className="sw-when">{e.date}</p>
                    {e.items.map((it, i) => <p key={i}>{galacticize(it)}</p>)}
                  </div>
                ))}
                <h3>MAY THE UPTIME BE WITH YOU.</h3>
              </div>
            </div>
          </div>
          <div className="sw-hint">Esc or click to return</div>
        </div>,
        document.body
      )}
    </>
  );
}
