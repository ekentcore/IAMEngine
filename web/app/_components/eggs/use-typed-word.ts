"use client";

// Shared listener for typed-word easter eggs (the konami/godfather pattern): typing the word
// anywhere outside an input toggles `active`; Escape always deactivates. Pure progress logic
// lives in lib/eggs/typed-word.ts so it stays testable without a browser.
import { useEffect, useRef, useState } from "react";
import { advanceWord } from "@/lib/eggs/typed-word";

export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable;
}

export function useTypedWord(word: string): [boolean, (v: boolean) => void] {
  const progress = useRef(0);
  const [active, setActive] = useState(false);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (activeRef.current && e.key === "Escape") {
        setActive(false);
        return;
      }
      if (isTypingTarget(e.target)) return;
      progress.current = advanceWord(word, progress.current, e.key);
      if (progress.current === word.length) {
        progress.current = 0;
        setActive((a) => !a);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [word]);

  return [active, setActive];
}
