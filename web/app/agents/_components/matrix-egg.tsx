"use client";

// Typing "matrix" on /agents (any version — mounted from the shared AgentsView) rains the fleet:
// each ONLINE agent becomes a falling glyph column headed by its name; offline agents read
// UNPLUGGED. Esc or a click exits. Pure CSS animation, zero dependencies; the glyph streams are
// deterministic (index-seeded) so re-renders don't reshuffle the rain.
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useTypedWord } from "@/app/_components/eggs/use-typed-word";

const GLYPHS = "ﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘｱﾎﾃﾏｹﾒｴｶｷﾑﾕﾗｾﾈｽﾀﾇ0123456789ZXCVBNM";

// Index-seeded pseudo-stream: stable across renders, different per column.
function stream(col: number, rows: number): string[] {
  return Array.from({ length: rows }, (_, r) => GLYPHS[(col * 31 + r * 17 + (col % 3) * 7) % GLYPHS.length]);
}

const CSS = `
.mx-overlay {
  position: fixed; inset: 0; z-index: 9998; background: #010401; color: #22c55e;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  display: flex; flex-direction: column; overflow: hidden; cursor: pointer;
}
.mx-cols { flex: 1; display: flex; justify-content: space-evenly; gap: 12px; padding: 1.2rem 1rem 0; overflow: hidden; }
.mx-col { display: flex; flex-direction: column; align-items: center; min-width: 0; }
.mx-name {
  font-size: 12px; letter-spacing: 0.1em; margin-bottom: 10px; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; max-width: 16ch;
  color: #86efac; text-shadow: 0 0 8px rgba(34, 197, 94, 0.8);
}
.mx-rain { position: relative; flex: 1; width: 2ch; overflow: hidden; }
.mx-stream {
  position: absolute; left: 0; top: 0; display: flex; flex-direction: column; align-items: center;
  font-size: 15px; line-height: 1.35; width: 100%;
  text-shadow: 0 0 6px rgba(34, 197, 94, 0.9);
}
.mx-stream span:first-child { color: #dcfce7; }
@media (prefers-reduced-motion: no-preference) {
  .mx-stream { animation: mx-fall linear infinite; }
  @keyframes mx-fall { from { transform: translateY(-100%); } to { transform: translateY(100%); } }
}
.mx-unplugged { font-size: 11px; letter-spacing: 0.22em; color: #b91c1c; text-shadow: 0 0 6px rgba(185, 28, 28, 0.8); writing-mode: vertical-rl; margin-top: 14px; }
.mx-caption { text-align: center; padding: 0.7rem 1rem 1rem; font-size: 12.5px; color: #86efac; }
`;

export function MatrixEgg({ agents, now }: { agents: { name: string; lastSeenAt: string | null }[]; now: number }) {
  const [active, setActive] = useTypedWord("matrix");

  useEffect(() => {
    if (!active) return;
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = overflow; };
  }, [active]);

  if (!active) return null;

  // Same 90-second rule as the fleet table's lastSeen().
  const cols = agents.slice(0, 14).map((a, i) => ({
    name: a.name,
    online: !!a.lastSeenAt && now - new Date(a.lastSeenAt).getTime() < 90_000,
    i,
  }));

  return createPortal(
    <div className="mx-overlay" role="dialog" aria-label="The fleet, as the Matrix" onClick={() => setActive(false)}>
      <style>{CSS}</style>
      <div className="mx-cols">
        {cols.length === 0 && <div className="mx-caption" style={{ alignSelf: "center" }}>NO AGENTS IN THE CONSTRUCT.</div>}
        {cols.map((c) => (
          <div key={c.i} className="mx-col">
            <div className="mx-name">{c.name}</div>
            {c.online ? (
              <div className="mx-rain">
                {/* two copies of the stream chase each other so the column never goes empty */}
                {[0, 1].map((copy) => (
                  <div key={copy} className="mx-stream" style={{ animationDuration: `${2.6 + (c.i % 5) * 0.9}s`, animationDelay: `${copy * (2.6 + (c.i % 5) * 0.9) / 2 - (2.6 + (c.i % 5) * 0.9)}s` }}>
                    {stream(c.i, 24).map((g, r) => <span key={r} style={{ opacity: Math.max(0.15, 1 - r * 0.04) }}>{g}</span>)}
                  </div>
                ))}
              </div>
            ) : (
              <div className="mx-unplugged">UNPLUGGED</div>
            )}
          </div>
        ))}
      </div>
      <div className="mx-caption">There is no spoon RSAT. — Esc or click to leave the construct</div>
    </div>,
    document.body
  );
}
