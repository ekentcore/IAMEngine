"use client";

// Shared shell for "mode" easter eggs (the godfather pattern): typing a word toggles a class on
// <body>; the visual skin rides egg-only class hooks in the host markup (inert while off) via the
// CSS passed in. Renders a fixed hint pill while active. Esc or retyping the word exits.
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useTypedWord } from "./use-typed-word";

/** The visual half of a mode egg — body class + CSS + hint pill while mounted. The typed-word
 *  trigger lives in ModeEgg; the /easter-eggs demo modal mounts this directly over sample markup. */
export function ModeSkin({ bodyClass, css, hint }: { bodyClass: string; css: string; hint: React.ReactNode }) {
  useEffect(() => {
    document.body.classList.add(bodyClass);
    return () => document.body.classList.remove(bodyClass);
  }, [bodyClass]);

  return (
    <>
      <style>{css}</style>
      {/* Portaled to <body>, same as the godfather hint: a transformed ancestor would become the
          containing block for position:fixed and pin the pill to the host instead. */}
      {createPortal(
        <div style={{ position: "fixed", bottom: 12, left: 0, right: 0, textAlign: "center", zIndex: 9999, pointerEvents: "none" }} role="status">
          {hint}
        </div>,
        document.body
      )}
    </>
  );
}

export function ModeEgg({ word, bodyClass, css, hint }: { word: string; bodyClass: string; css: string; hint: React.ReactNode }) {
  const [active] = useTypedWord(word);
  if (!active) return null;
  return <ModeSkin bodyClass={bodyClass} css={css} hint={hint} />;
}
