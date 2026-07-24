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

// The crawl retells the change log as dispatches from the Galactic Civil War. Pure
// dictionary rewrite: longest key wins, one pass (replacements are never re-processed),
// word boundaries respected, a leading capital on the match is preserved.
const GALACTIC: [string, string][] = [
  ["a password", "the secret plans"],
  ["passwords", "secret plans"],
  ["password", "secret plans"],
  ["clients", "star systems"],
  ["client", "star system"],
  ["users", "rebels"],
  ["user", "rebel"],
  ["onboarding", "recruitment"],
  ["onboarded", "recruited"],
  ["onboards", "recruits"],
  ["onboard", "recruit"],
  ["offboarding", "exile"],
  ["offboarded", "exiled"],
  ["offboards", "exiles"],
  ["offboard", "exile"],
  ["mailboxes", "holocrons"],
  ["mailbox", "holocron"],
  ["runners", "astromech droids"],
  ["runner", "astromech droid"],
  ["agents", "protocol droids"],
  ["agent", "protocol droid"],
  ["servers", "Star Destroyers"],
  ["server", "Star Destroyer"],
  ["databases", "Jedi Archives"],
  ["database", "Jedi Archives"],
  ["errors", "disturbances in the Force"],
  ["error", "disturbance in the Force"],
  ["bugs", "disturbances in the Force"],
  ["bug", "disturbance in the Force"],
  ["emails", "transmissions"],
  ["email", "transmission"],
  ["groups", "squadrons"],
  ["group", "squadron"],
  ["cases", "missions"],
  ["case", "mission"],
  ["jobs", "directives"],
  ["job", "directive"],
  ["admins", "Grand Moffs"],
  ["admin", "Grand Moff"],
  ["Microsoft", "the Empire"],
  ["calendars", "star charts"],
  ["calendar", "star chart"],
  ["licenses", "Imperial clearances"],
  ["license", "Imperial clearance"],
  ["deployed", "jumped to hyperspace"],
  ["deploys", "jumps to hyperspace"],
  ["deploy", "jump to hyperspace"],
];

const GALACTIC_MAP = new Map(GALACTIC.map(([k, v]) => [k.toLowerCase(), v]));
// The first alternative swallows email addresses and dotted identifiers whole
// (calendar.reviewers, user@host) so their parts are never reworded.
const GALACTIC_RE = new RegExp(
  `\\S+[@.]\\S+|\\b(${GALACTIC.map(([k]) => k.replace(/ /g, "\\s+")).sort((a, b) => b.length - a.length).join("|")})\\b`,
  "gi",
);

export function galacticize(text: string): string {
  return text.replace(GALACTIC_RE, (match, word: string | undefined) => {
    if (word === undefined) return match; // protected email/identifier token
    const replacement = GALACTIC_MAP.get(word.toLowerCase().replace(/\s+/g, " "));
    if (!replacement) return match;
    return /^[A-Z]/.test(word) ? replacement[0].toUpperCase() + replacement.slice(1) : replacement;
  });
}
