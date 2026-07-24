// "starwars" typed-word state machine (konami.ts pattern), pure so it's testable without a
// browser. Feed KeyboardEvent.key values; when the return value hits STARWARS_LENGTH the word
// completed and the caller resets. Non-character keys (Shift, arrows, …) are neutral so typing
// a capital S doesn't reset progress.

const WORD = "starwars";

export const STARWARS_LENGTH = WORD.length;

export function advanceStarwars(progress: number, key: string): number {
  if (key.length !== 1) return progress;
  const k = key.toLowerCase();
  if (k === WORD[progress]) return progress + 1;
  return k === WORD[0] ? 1 : 0;
}
