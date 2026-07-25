"use client";

// Typing "pirate" (any case) on the change log turns it into a naval battle: two ships on a
// night sea fire the log at each other — muzzle flash, cannonball arc, boom — and each entry
// lands as pirate-speech on a parchment card. Esc or a click returns to the page. Keystrokes
// inside inputs/textareas are ignored, same as the Konami and starwars eggs. Pure CSS keyframes
// (no animation library) to stay zero-dependency like every other egg.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { advancePirate, PIRATE_LENGTH, piratify, pirateFlourish } from "@/lib/eggs/pirate";
import type { ChangelogEntry } from "@/lib/changelog/entries";

// A full log is hundreds of entries — a broadside of all of them would sink both ships.
const VOLLEY_ENTRIES = 8;
// One volley = flash (0.35s) + flight (1.1s) + boom, then the card lingers so it can be read.
const VOLLEY_MS = 6500;
const FLIGHT_DELAY_MS = 350;
const FLIGHT_MS = 1100;

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable;
}

const CSS = `
.pe-overlay {
  position: fixed; inset: 0; z-index: 9999; overflow: hidden; cursor: pointer;
  color: #e8e3d5; font-size: 15px;
  background:
    radial-gradient(circle at 78% 18%, #f5f0dcee 0 26px, #f5f0dc22 34px, transparent 90px),
    radial-gradient(1px 1px at 15% 25%, #fff, transparent),
    radial-gradient(1px 1px at 65% 15%, #fff9, transparent),
    radial-gradient(2px 2px at 85% 55%, #fff, transparent),
    radial-gradient(1px 1px at 35% 45%, #fffc, transparent),
    radial-gradient(1px 1px at 55% 30%, #fff8, transparent),
    radial-gradient(1px 1px at 8% 60%, #fffb, transparent),
    linear-gradient(#0b1026 0%, #131b3a 55%, #1d2a4d 68%, #0a1a2f 68%, #061220 100%);
  background-size: auto, 240px 240px, 240px 240px, 240px 240px, 240px 240px, 240px 240px, 240px 240px, auto;
}
.pe-sea {
  position: absolute; left: 0; right: 0; bottom: 0; height: 32vh; overflow: hidden;
  background: linear-gradient(180deg, #0e2440 0%, #081827 60%, #050f1a 100%);
}
.pe-wave {
  position: absolute; left: -10vw; right: -10vw; height: 14px; opacity: 0.35;
  background: repeating-linear-gradient(90deg, transparent 0 26px, #3f6d9a55 26px 52px);
  border-radius: 50%;
  animation: pe-wave 7s ease-in-out infinite;
}
.pe-wave:nth-child(2) { top: 28%; animation-duration: 9s; animation-delay: -3s; opacity: 0.25; }
.pe-wave:nth-child(3) { top: 55%; animation-duration: 11s; animation-delay: -6s; opacity: 0.18; }
@keyframes pe-wave { 0%, 100% { transform: translateX(0); } 50% { transform: translateX(4vw); } }
.pe-ship {
  position: absolute; bottom: 24vh; width: min(20vw, 210px);
  filter: drop-shadow(0 6px 8px #0009);
  animation: pe-bob 5.2s ease-in-out infinite;
}
.pe-ship.pe-left { left: 3vw; }
.pe-ship.pe-right { right: 3vw; transform: scaleX(-1); animation-name: pe-bob-flipped; animation-duration: 6.1s; }
@keyframes pe-bob {
  0%, 100% { transform: translateY(0) rotate(-1.5deg); }
  50% { transform: translateY(9px) rotate(1.5deg); }
}
@keyframes pe-bob-flipped {
  0%, 100% { transform: scaleX(-1) translateY(9px) rotate(-1.5deg); }
  50% { transform: scaleX(-1) translateY(0) rotate(1.5deg); }
}
.pe-flash {
  position: absolute; bottom: 30vh; width: 46px; height: 46px; border-radius: 50%;
  background: radial-gradient(circle, #fff7ce 0%, #ffc23d 45%, #ff7a1a88 70%, transparent 75%);
  opacity: 0; transform: scale(0.2);
  animation: pe-flash ${FLIGHT_DELAY_MS}ms ease-out forwards;
}
.pe-flash.pe-from-left { left: calc(3vw + min(20vw, 210px) - 30px); }
.pe-flash.pe-from-right { right: calc(3vw + min(20vw, 210px) - 30px); }
@keyframes pe-flash { 15% { opacity: 1; transform: scale(1.25); } 100% { opacity: 0; transform: scale(0.6); } }
.pe-ball-x {
  position: absolute; bottom: 31vh; width: 15px; height: 15px;
  animation: pe-ball-x ${FLIGHT_MS}ms linear ${FLIGHT_DELAY_MS}ms both;
}
.pe-ball-x.pe-from-left { left: calc(3vw + min(20vw, 210px) - 24px); --pe-dx: calc(94vw - 2 * min(20vw, 210px) + 33px); }
.pe-ball-x.pe-from-right { left: calc(97vw - min(20vw, 210px) + 9px); --pe-dx: calc(-94vw + 2 * min(20vw, 210px) - 33px); }
@keyframes pe-ball-x { from { transform: translateX(0); } to { transform: translateX(var(--pe-dx)); } }
.pe-ball-y {
  width: 100%; height: 100%; border-radius: 50%;
  background: radial-gradient(circle at 32% 30%, #6b7280, #111827 65%);
  animation: pe-ball-y ${FLIGHT_MS}ms ${FLIGHT_DELAY_MS}ms both;
}
@keyframes pe-ball-y {
  0% { transform: translateY(0); opacity: 1; animation-timing-function: ease-out; }
  50% { transform: translateY(-36vh); animation-timing-function: ease-in; }
  92% { opacity: 1; }
  /* Fades at impact — with fill:both the element would otherwise sit parked by the target ship. */
  100% { transform: translateY(0); opacity: 0; }
}
.pe-boom {
  position: absolute; bottom: 27vh; width: 90px; height: 90px; border-radius: 50%;
  background: radial-gradient(circle, #fff3c4 0%, #ffb02e 35%, #f4511e88 60%, #55555522 75%, transparent 80%);
  opacity: 0; transform: scale(0.2);
  animation: pe-boom 650ms ease-out ${FLIGHT_DELAY_MS + FLIGHT_MS - 80}ms forwards;
}
.pe-boom.pe-at-left { left: calc(3vw + min(20vw, 210px) / 2 - 45px); }
.pe-boom.pe-at-right { right: calc(3vw + min(20vw, 210px) / 2 - 45px); }
@keyframes pe-boom { 12% { opacity: 1; transform: scale(1); } 100% { opacity: 0; transform: scale(1.7); } }
.pe-card {
  position: absolute; top: 7vh; left: 50%; width: min(86vw, 560px); max-height: 52vh;
  overflow-y: auto; padding: 1.1rem 1.3rem; box-sizing: border-box;
  color: #33261a; background: #f0e2bd;
  background-image: radial-gradient(ellipse at 50% 0%, #f7ecce 0%, #ecd9a9 70%, #e2cb8f 100%);
  border: 1px solid #b99d5f; border-radius: 6px;
  box-shadow: 0 12px 30px #000a, inset 0 0 42px #b9975833;
  font-family: Georgia, 'Times New Roman', serif;
  opacity: 0; transform: translateX(-50%) rotate(-0.6deg) scale(0.94);
  animation: pe-card 500ms ease-out ${FLIGHT_DELAY_MS + FLIGHT_MS + 250}ms forwards;
}
.pe-card.pe-card-end { animation-delay: 200ms; }
@keyframes pe-card { to { opacity: 1; transform: translateX(-50%) rotate(-0.6deg) scale(1); } }
.pe-card h3 { margin: 0 0 2px; font-size: 19px; }
.pe-card .pe-when { font-size: 12px; opacity: 0.65; margin: 0 0 10px; font-style: italic; }
.pe-card ul { margin: 0; padding-left: 1.1rem; }
.pe-card li { margin-top: 5px; font-size: 14.5px; line-height: 1.45; }
.pe-card .pe-flourish { font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase; opacity: 0.7; margin: 0 0 6px; }
.pe-progress { position: absolute; top: 2.2vh; left: 0; right: 0; text-align: center; font-size: 12px; color: #9aa5b1; }
.pe-intro {
  position: absolute; top: 34vh; left: 0; right: 0; text-align: center; padding: 0 2rem;
  font-family: Georgia, 'Times New Roman', serif; font-size: clamp(19px, 3.2vw, 30px); color: #f0e2bd;
  text-shadow: 0 2px 10px #000;
  animation: pe-intro 1.6s ease-out forwards;
}
/* Gone by 1.6s — the first parchment card unfurls at 1.7s in the same band of the screen. */
@keyframes pe-intro { 0% { opacity: 0; } 15% { opacity: 1; } 70% { opacity: 1; } 100% { opacity: 0; visibility: hidden; } }
.pe-hint {
  position: absolute; bottom: 10px; left: 0; right: 0; text-align: center;
  color: #8b93a1; font-size: 12px;
}
@media (prefers-reduced-motion: reduce) {
  .pe-overlay { overflow-y: auto; cursor: auto; }
  .pe-wave, .pe-ship { animation: none; }
  .pe-flash, .pe-ball-x, .pe-boom, .pe-intro { display: none; }
  .pe-card {
    position: static; transform: none; opacity: 1; animation: none;
    max-height: none; margin: 6vh auto 8vh; width: min(86vw, 640px);
  }
}
`;

// A small ship silhouette: hull, two masts with sails, and a jolly roger. Drawn pointing right;
// the right-hand ship is the same SVG flipped with scaleX(-1).
function Ship() {
  return (
    <svg viewBox="0 0 200 150" width="100%" aria-hidden="true">
      {/* masts */}
      <rect x="70" y="18" width="4" height="82" fill="#2c1e12" />
      <rect x="122" y="30" width="4" height="70" fill="#2c1e12" />
      {/* sails */}
      <path d="M74 24 Q104 44 74 66 Z" fill="#d8cba8" />
      <path d="M74 70 Q100 84 74 96 Z" fill="#cbbd97" />
      <path d="M126 36 Q150 52 126 72 Z" fill="#d8cba8" />
      {/* jolly roger */}
      <rect x="60" y="16" width="12" height="9" fill="#14100c" />
      <circle cx="66" cy="20" r="2.1" fill="#e8e3d5" />
      {/* hull */}
      <path d="M28 100 L180 100 L164 132 Q100 144 48 132 Z" fill="#3a2417" />
      <path d="M28 100 L180 100 L176 108 L34 108 Z" fill="#54351f" />
      {/* gun ports */}
      <circle cx="70" cy="118" r="4" fill="#14100c" />
      <circle cx="104" cy="119" r="4" fill="#14100c" />
      <circle cx="138" cy="117" r="4" fill="#14100c" />
    </svg>
  );
}

function PirateCard({ entry, volley, end }: { entry?: ChangelogEntry; volley: number; end?: boolean }) {
  return (
    <div className={`pe-card${end ? " pe-card-end" : ""}`}>
      {end ? (
        <>
          <p className="pe-flourish">Yo-ho-ho!</p>
          <h3>That be all th&#39; plunder, matey ☠️</h3>
          <p className="pe-when">Th&#39; rest o&#39; th&#39; log rests in Davy Jones&#39; locker.</p>
        </>
      ) : entry ? (
        <>
          <p className="pe-flourish">{pirateFlourish(volley)}</p>
          <h3>{piratify(entry.title)}</h3>
          <p className="pe-when">{entry.date}</p>
          <ul>
            {entry.items.map((it, i) => <li key={i}>{piratify(it)}</li>)}
          </ul>
        </>
      ) : null}
    </div>
  );
}

/** The battle itself — mount = volley 0 fires. Click closes; the host (typed-word wrapper or
 *  the /easter-eggs demo) owns Escape. */
export function PirateShow({ entries, onClose }: { entries: ChangelogEntry[]; onClose: () => void }) {
  const [volley, setVolley] = useState(0);

  const battleEntries = entries.slice(0, VOLLEY_ENTRIES);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => {
      setVolley((v) => {
        // battleEntries.length is the end card; stop counting there.
        if (v >= battleEntries.length) { clearInterval(t); return v; }
        return v + 1;
      });
    }, VOLLEY_MS);
    return () => clearInterval(t);
  }, [battleEntries.length]);

  const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const atEnd = volley >= battleEntries.length;
  const fromLeft = volley % 2 === 0;

  return createPortal(
    // Portaled to <body>: an ancestor with a transform/filter would otherwise become the
    // containing block for position:fixed, leaving the header uncovered.
    <div className="pe-overlay" role="dialog" aria-label="Change log, high-seas edition" onClick={onClose}>
      <style>{CSS}</style>
      <div className="pe-sea">
        <div className="pe-wave" style={{ top: "8%" }} />
        <div className="pe-wave" />
        <div className="pe-wave" />
      </div>
      <div className="pe-ship pe-left"><Ship /></div>
      <div className="pe-ship pe-right"><Ship /></div>
      {reduced ? (
        battleEntries.map((e, i) => <PirateCard key={e.id} entry={e} volley={i} />)
      ) : (
        <>
          {volley === 0 && <div className="pe-intro">Batten down th&#39; hatches — th&#39; change log be under fire!</div>}
          {!atEnd && (
            // Keyed by volley so the flash/ball/boom animations restart for every entry.
            <div key={volley}>
              <div className={`pe-flash ${fromLeft ? "pe-from-left" : "pe-from-right"}`} />
              <div className={`pe-ball-x ${fromLeft ? "pe-from-left" : "pe-from-right"}`}>
                <div className="pe-ball-y" />
              </div>
              <div className={`pe-boom ${fromLeft ? "pe-at-right" : "pe-at-left"}`} />
              <PirateCard entry={battleEntries[volley]} volley={volley} />
            </div>
          )}
          {atEnd && <PirateCard volley={volley} end />}
          <div className="pe-progress">{atEnd ? "" : `Broadside ${volley + 1} of ${battleEntries.length}`}</div>
        </>
      )}
      <div className="pe-hint">Esc or click to return, ye scurvy dog</div>
    </div>,
    document.body
  );
}

export function PirateEgg({ entries }: { entries: ChangelogEntry[] }) {
  const progress = useRef(0);
  const [active, setActive] = useState(false);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (activeRef.current) {
        if (e.key === "Escape") setActive(false);
        return;
      }
      if (isTypingTarget(e.target)) return;
      progress.current = advancePirate(progress.current, e.key);
      if (progress.current === PIRATE_LENGTH) {
        progress.current = 0;
        setActive(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!active) return null;
  return <PirateShow entries={entries} onClose={() => setActive(false)} />;
}
