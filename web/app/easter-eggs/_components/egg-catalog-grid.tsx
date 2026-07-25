"use client";

// The catalog grid, now clickable: any egg with a registered demo plays it on click — inline
// demos open in a modal with a Replay button; takeover demos (star wars, pirate, matrix,
// wargames, jurassic) mount the egg's real full-screen show over the catalog. Esc always
// returns; takeover shows also close on click, same as the real eggs.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { CatalogEgg } from "@/lib/eggs/catalog";
import { EGG_DEMOS } from "./egg-demos";

const label: React.CSSProperties = { fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--muted)" };

function EggCard({ egg, onOpen }: { egg: CatalogEgg; onOpen?: () => void }) {
  const clickable = !!onOpen;
  return (
    <div
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-haspopup={clickable ? "dialog" : undefined}
      onClick={onOpen}
      onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } } : undefined}
      style={{
        border: "1px solid var(--line)", borderRadius: 8, padding: "0.9rem 1rem", background: "var(--bg-soft)",
        cursor: clickable ? "pointer" : undefined,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span aria-hidden style={{ fontSize: 18 }}>{egg.emoji}</span>
        <strong>{egg.name}</strong>
        <span style={{ ...label, marginLeft: "auto" }}>{egg.where}</span>
      </div>
      <p style={{ margin: "0.5rem 0 0", fontSize: 13 }}>
        <span style={label}>Trigger&nbsp;</span> {egg.trigger}
        {egg.exit && <span style={{ color: "var(--muted)" }}> · exits with {egg.exit}</span>}
      </p>
      <p style={{ margin: "0.4rem 0 0", fontSize: 13, color: "var(--muted)" }}>{egg.description}</p>
      {clickable && <p style={{ ...label, margin: "0.5rem 0 0", fontSize: 11 }}>▶ Click for a demo</p>}
    </div>
  );
}

export function EggCatalogGrid({ eggs }: { eggs: CatalogEgg[] }) {
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const [playKey, setPlayKey] = useState(0);

  const open = openSlug ? eggs.find((e) => e.slug === openSlug) ?? null : null;
  const demo = open ? EGG_DEMOS[open.slug] : undefined;
  const close = () => setOpenSlug(null);

  // Esc closes whichever demo is up — the takeover shows leave Escape to their host on purpose.
  useEffect(() => {
    if (!openSlug) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpenSlug(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openSlug]);

  return (
    <>
      <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
        {eggs.map((egg) => (
          <EggCard
            key={egg.slug}
            egg={egg}
            onOpen={EGG_DEMOS[egg.slug] ? () => { setPlayKey((k) => k + 1); setOpenSlug(egg.slug); } : undefined}
          />
        ))}
      </div>

      {open && demo && demo.kind === "takeover" && (
        <div key={playKey}>{demo.render(close)}</div>
      )}

      {/* Portaled to <body>, same as the eggs themselves: a transformed ancestor would become
          the containing block for position:fixed and pin the modal to the page flow instead. */}
      {open && demo && demo.kind === "inline" && createPortal(
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${open.name} demo`}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "grid", placeItems: "center", zIndex: 70 }}
          onClick={(e) => { if (e.target === e.currentTarget) close(); }}
        >
          <div style={{ background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 10, padding: "1.1rem 1.3rem", width: "min(680px, calc(100vw - 2rem))", maxHeight: "calc(100vh - 4rem)", overflowY: "auto", boxShadow: "var(--shadow-2, 0 10px 40px rgba(0,0,0,.3))" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span aria-hidden style={{ fontSize: 20 }}>{open.emoji}</span>
              <h2 style={{ margin: 0, fontSize: 17 }}>{open.name}</h2>
              <span style={{ ...label, marginLeft: "auto" }}>demo</span>
            </div>
            <p className="note" style={{ margin: "0.4rem 0 0.8rem" }}>
              Real trigger: {open.trigger}{open.exit ? ` · exits with ${open.exit}` : ""}
            </p>
            <div key={playKey}>{demo.render(close)}</div>
            {demo.note && <p className="note" style={{ margin: "0.8rem 0 0", fontSize: 12 }}>{demo.note}</p>}
            <div className="toolbar" style={{ justifyContent: "flex-end", gap: 8, marginTop: "1rem" }}>
              <button type="button" onClick={() => setPlayKey((k) => k + 1)}>Replay</button>
              <button type="button" className="primary" onClick={close}>Close</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
