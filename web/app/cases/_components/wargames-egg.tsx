"use client";

// Typing "wargames" on /cases (any version — mounted from the shared CasesTable) boots WOPR:
// a green-phosphor terminal slow-types "SHALL WE PLAY A GAME?" and lists the cases as available
// simulations, closing on the only winning move. Esc or a click exits; prefers-reduced-motion
// renders the whole transcript instantly.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTypedWord } from "@/app/_components/eggs/use-typed-word";

const CSS = `
.wg-overlay {
  position: fixed; inset: 0; z-index: 9998; background: #010b03; color: #33ff66;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  padding: clamp(1rem, 6vh, 4rem) clamp(1rem, 8vw, 6rem); overflow: auto; cursor: pointer;
}
.wg-overlay::after {
  /* CRT scanlines. Image-only layer — a color would make the whole declaration invalid. */
  content: ""; position: fixed; inset: 0; pointer-events: none;
  background-image: repeating-linear-gradient(0deg, rgba(0, 0, 0, 0.35) 0 1px, transparent 1px 3px);
}
.wg-pre {
  margin: 0; white-space: pre-wrap; font-size: clamp(13px, 1.7vw, 17px); line-height: 1.6;
  letter-spacing: 0.08em; text-shadow: 0 0 7px rgba(51, 255, 102, 0.75);
}
.wg-cursor { display: inline-block; width: 0.62em; height: 1em; background: #33ff66; vertical-align: text-bottom; }
@media (prefers-reduced-motion: no-preference) {
  .wg-cursor { animation: wg-blink 0.9s steps(1) infinite; }
  @keyframes wg-blink { 50% { opacity: 0; } }
}
`;

export function buildTranscript(cases: { label: string; action: string; status: string }[]): string {
  const sims = cases.slice(0, 10).map(
    (c, i) => `  ${String(i + 1).padStart(2, " ")}. ${c.label.toUpperCase()} — ${c.action.toUpperCase()} [${c.status.toUpperCase().replace(/_/g, " ")}]`
  );
  return [
    "GREETINGS PROFESSOR FALKEN.",
    "",
    "SHALL WE PLAY A GAME?",
    "",
    "AVAILABLE SIMULATIONS:",
    ...(sims.length ? sims : ["  (NO ACTIVE SIMULATIONS)"]),
    "",
    "ANALYZING OUTCOMES ..............",
    "",
    "A STRANGE GAME.",
    "THE ONLY WINNING MOVE IS NOT TO PLAY.",
    "",
    "HOW ABOUT A NICE GAME OF CHESS?",
  ].join("\n");
}

/** The WOPR terminal itself — mount = boot. Click closes; the host (typed-word wrapper or the
 *  /easter-eggs demo) owns Escape. */
export function WarGamesShow({ cases, onClose }: { cases: { label: string; action: string; status: string }[]; onClose: () => void }) {
  const [chars, setChars] = useState(0);

  const text = buildTranscript(cases);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setChars(text.length); return; }
    const t = setInterval(() => {
      setChars((n) => {
        if (n >= text.length) { clearInterval(t); return n; }
        return n + 1;
      });
    }, 26);
    return () => clearInterval(t);
  }, [text.length]);

  useEffect(() => {
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = overflow; };
  }, []);

  return createPortal(
    <div className="wg-overlay" role="dialog" aria-label="WOPR terminal" onClick={onClose}>
      <style>{CSS}</style>
      <pre className="wg-pre">
        {text.slice(0, chars)}
        <span className="wg-cursor" aria-hidden />
        {chars >= text.length && "\n\n(Esc or click to log off)"}
      </pre>
    </div>,
    document.body
  );
}

export function WarGamesEgg({ cases }: { cases: { label: string; action: string; status: string }[] }) {
  const [active, setActive] = useTypedWord("wargames");
  if (!active) return null;
  return <WarGamesShow cases={cases} onClose={() => setActive(false)} />;
}
