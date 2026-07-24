// Konami-code state machine, pure so it's testable without a browser. Feed KeyboardEvent.key
// values; when the return value hits KONAMI_LENGTH the code completed and the caller resets.

const SEQ = ["arrowup", "arrowup", "arrowdown", "arrowdown", "arrowleft", "arrowright", "arrowleft", "arrowright", "b", "a"];

export const KONAMI_LENGTH = SEQ.length;

export function advanceKonami(progress: number, key: string): number {
  const k = key.toLowerCase();
  if (k === SEQ[progress]) return progress + 1;
  return k === SEQ[0] ? 1 : 0;
}
