// Generic typed-word state machine — the godfather/starwars/pirate pattern, factored out so the
// ten-egg batch doesn't ship ten copies. Pure and browser-free so it's testable under node:test.
// Feed KeyboardEvent.key values; when the return value hits word.length the word completed and the
// caller resets. Non-character keys (Shift, arrows, Escape, …) are neutral so typing a capital
// letter doesn't reset progress.

export function advanceWord(word: string, progress: number, key: string): number {
  if (key.length !== 1) return progress;
  const k = key.toLowerCase();
  if (k === word[progress]) return progress + 1;
  return k === word[0] ? 1 : 0;
}
