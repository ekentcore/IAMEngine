"use client";

// ↑↑↓↓←→←→BA anywhere -> confetti + a credit toast. Ignores keystrokes while typing in a field.
import { useEffect, useRef, useState } from "react";
import { advanceKonami, KONAMI_LENGTH } from "@/lib/eggs/konami";
import { fireConfetti } from "./confetti";
import { EggToast } from "./egg-toast";

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable;
}

export function KonamiEgg() {
  const progress = useRef(0);
  const [hit, setHit] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;
      progress.current = advanceKonami(progress.current, e.key);
      if (progress.current === KONAMI_LENGTH) {
        progress.current = 0;
        fireConfetti();
        setHit(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!hit) return null;
  return <EggToast message="IAM Engine — built by Evan Kent, 2026 · see /credits" onDone={() => setHit(false)} />;
}
