"use client";

// Tiny fixed toast used by the egg components (Konami, New Year). Self-dismisses.
import { useEffect } from "react";

export function EggToast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 6000);
    return () => clearTimeout(t);
  }, [onDone]);
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
