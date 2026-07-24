// "godfather" typed-word state machine (starwars.ts / konami.ts pattern), pure so it's testable
// without a browser. Feed KeyboardEvent.key values; when the return value hits GODFATHER_LENGTH the
// word completed and the caller resets. Non-character keys (Shift, arrows, …) are neutral so typing
// a capital G doesn't reset progress.

const WORD = "godfather";

export const GODFATHER_LENGTH = WORD.length;

export function advanceGodfather(progress: number, key: string): number {
  if (key.length !== 1) return progress;
  const k = key.toLowerCase();
  if (k === WORD[progress]) return progress + 1;
  return k === WORD[0] ? 1 : 0;
}
