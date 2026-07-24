"use client";

// Tiny fixed toast used by the egg components (Konami, New Year). Self-dismisses.
import { useEffect, useRef } from "react";

export function EggToast({ message, onDone }: { message: string; onDone: () => void }) {
  const done = useRef(onDone);
  done.current = onDone;
  // Mount-once: parents pass inline callbacks, and a dependency on them would
  // reset the dismiss timer on every parent re-render.
  useEffect(() => {
    const t = setTimeout(() => done.current(), 6000);
    return () => clearTimeout(t);
  }, []);
  return (
    <div
      role="status"
      style={{
        position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", zIndex: 9999,
        background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 10,
        padding: "0.6rem 1rem", fontSize: 13, boxShadow: "var(--shadow-2, 0 10px 40px rgba(0,0,0,.3))",
        whiteSpace: "nowrap",
      }}
    >
      {message}
    </div>
  );
}
