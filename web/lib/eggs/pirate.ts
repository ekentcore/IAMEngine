// "pirate" typed-word state machine (starwars.ts pattern) plus the pirate-speech translator,
// both pure so they're testable without a browser. Feed KeyboardEvent.key values; when the
// return value hits PIRATE_LENGTH the word completed and the caller resets. Non-character keys
// (Shift, arrows, …) are neutral so typing a capital P doesn't reset progress.

const WORD = "pirate";

export const PIRATE_LENGTH = WORD.length;

export function advancePirate(progress: number, key: string): number {
  if (key.length !== 1) return progress;
  const k = key.toLowerCase();
  if (k === WORD[progress]) return progress + 1;
  return k === WORD[0] ? 1 : 0;
}

// Whole-word swaps. Keys are lowercase; matching is case-insensitive and the replacement
// re-capitalizes when the original word did. Kept small enough that entries stay readable —
// the goal is flavor, not a cipher.
const WORD_MAP: Record<string, string> = {
  my: "me",
  is: "be",
  are: "be",
  am: "be",
  was: "were",
  you: "ye",
  your: "yer",
  yours: "yers",
  yes: "aye",
  no: "nay",
  hello: "ahoy",
  hi: "ahoy",
  hey: "ahoy",
  for: "fer",
  the: "th'",
  of: "o'",
  and: "an'",
  over: "o'er",
  never: "ne'er",
  ever: "e'er",
  friend: "matey",
  friends: "mateys",
  everyone: "all hands",
  user: "landlubber",
  users: "landlubbers",
  admin: "cap'n",
  admins: "cap'ns",
  manager: "quartermaster",
  managers: "quartermasters",
  server: "galleon",
  servers: "galleons",
  bug: "barnacle",
  bugs: "barnacles",
  broken: "scuttled",
  fixed: "patched",
  fixes: "hull patches",
  fix: "hull patch",
  deleted: "sent to th' depths",
  removed: "thrown overboard",
  money: "doubloons",
  quickly: "smartly",
};

// "onboarding" -> "onboardin'". Only on longer words so "ring"/"king" keep their g.
const ING = /ing$/;
const ING_MIN_LENGTH = 5;

function matchCase(original: string, replacement: string): string {
  if (original === original.toUpperCase() && original.length > 1) return replacement.toUpperCase();
  if (original[0] === original[0].toUpperCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

export function piratify(text: string): string {
  return text.replace(/[A-Za-z]+(?:'[A-Za-z]+)?/g, (word) => {
    const mapped = WORD_MAP[word.toLowerCase()];
    if (mapped) return matchCase(word, mapped);
    if (word.length >= ING_MIN_LENGTH && ING.test(word.toLowerCase())) {
      return `${word.slice(0, -1)}'`;
    }
    return word;
  });
}

// A deterministic flourish per volley — no Math.random so replays and tests are stable.
const FLOURISHES = ["Arrr!", "Avast!", "Yo-ho-ho!", "Shiver me timbers!", "Blimey!", "Yarr!"];

export function pirateFlourish(index: number): string {
  return FLOURISHES[index % FLOURISHES.length];
}
