"use client";

// Typing "dialup" on /agents reconnects the fleet the 1997 way: a terminal dials, handshakes
// (synthesized DTMF, carrier, and the filtered-noise screech — lib/eggs/sounds.ts), and then
// every agent "connects at 56,000 bps". Esc or click hangs up and cuts the sound.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTypedWord } from "@/app/_components/eggs/use-typed-word";
import { playEggSound } from "@/app/_components/eggs/egg-audio";
import { EGG_SOUNDS } from "@/lib/eggs/sounds";

const MONO = `ui-monospace, "SF Mono", Menlo, Consolas, monospace`;

// Script lines appear on the same clock the sound follows (dial ~0-1s, screech ~2-3.4s, connect ~3.5s).
const SCRIPT: [number, string][] = [
  [0, "IAM ENGINE DIAL-UP NETWORKING v1.0"],
  [200, "Dialing 1-556-0456 …"],
  [1200, "Carrier detected. Handshaking …"],
  [2100, "*** SCREEEEEEECH *** (this is the agents negotiating)"],
  [3600, "CONNECTED AT 56,000 bps"],
];

const CSS = `
.du-overlay {
  position: fixed; inset: 0; z-index: 9998; background: #0a0a14; color: #d4d4d8;
  display: grid; place-items: center; cursor: pointer; font-family: ${MONO};
}
.du-term {
  width: min(560px, calc(100vw - 3rem)); background: #000; border: 1px solid #3f3f46;
  border-radius: 8px; padding: 1.1rem 1.3rem; font-size: 13.5px; line-height: 1.75;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6); text-align: left;
}
.du-line { margin: 0; white-space: pre-wrap; }
.du-line.du-shout { color: #fbbf24; }
.du-agent { color: #4ade80; }
.du-agent::before { content: "▸ "; color: #71717a; }
@media (prefers-reduced-motion: no-preference) {
  .du-line, .du-agent { animation: du-in 0.15s steps(2) backwards; }
  @keyframes du-in { from { opacity: 0; } to { opacity: 1; } }
}
.du-exit { color: #71717a; font-size: 11.5px; margin-top: 0.8rem; }
`;

export function DialupShow({ agents, onClose }: { agents: string[]; onClose: () => void }) {
  const [now, setNow] = useState(0);
  useEffect(() => playEggSound(EGG_SOUNDS.dialup), []);
  useEffect(() => {
    // One ticking clock gates every line; simpler and more drop-safe than a timeout per line.
    const t0 = Date.now();
    const timer = setInterval(() => setNow(Date.now() - t0), 120);
    return () => clearInterval(timer);
  }, []);

  const connected = now >= 3600;
  return createPortal(
    <div className="du-overlay" role="dialog" aria-label="Dial-up networking" onClick={onClose}>
      <style>{CSS}</style>
      <div className="du-term">
        {SCRIPT.filter(([at]) => now >= at).map(([at, line]) => (
          <p key={at} className={line.startsWith("***") ? "du-line du-shout" : "du-line"}>{line}</p>
        ))}
        {connected &&
          agents.slice(0, 8).map((name, i) => (
            <p key={name} className="du-agent" style={{ animationDelay: `${i * 0.12}s` }}>
              {name} — connected at 56,000 bps
            </p>
          ))}
        {connected && <p className="du-exit">Welcome back to 1997. Esc or click to hang up (someone needs the phone line).</p>}
      </div>
    </div>,
    document.body
  );
}

export function DialupEgg({ agents }: { agents: string[] }) {
  const [active, setActive] = useTypedWord("dialup");
  if (!active) return null;
  return <DialupShow agents={agents} onClose={() => setActive(false)} />;
}
