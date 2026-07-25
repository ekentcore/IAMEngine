// The super-admin field guide to every easter egg — data only, rendered by /easter-eggs.
// Live entries mirror the shipped eggs (specs: docs/superpowers/specs/2026-07-24-easter-eggs-design.md
// and 2026-07-24-pirate-egg-design.md; the ten-egg batch is documented by its entries here).
// Keep this in sync when an egg ships: flip its idea entry to live (or add one) in the same PR,
// and update the counts asserted in catalog.test.ts.
import type { Role } from "@prisma/client";

export type EggStatus = "live" | "idea";

export type CatalogEgg = {
  slug: string;
  name: string;
  emoji: string;
  status: EggStatus;
  /** The page or surface the egg lives on (or would live on). */
  where: string;
  /** How to fire it — typed word, date, clicks, or "automatic". */
  trigger: string;
  description: string;
  /** How to make it stop, when it isn't self-dismissing. */
  exit?: string;
};

// The catalog spoils every egg by design, so only the REAL super-admin may read it —
// impersonation can neither grant nor revoke it (same rule as the date simulator).
export function canViewEggCatalog(realRole: Role | null | undefined): boolean {
  return realRole === "super_admin";
}

export const EGG_CATALOG: CatalogEgg[] = [
  // ---- Live in the app -------------------------------------------------------------------
  {
    slug: "birthday-banner",
    name: "Birthday banner",
    emoji: "🎂",
    status: "live",
    where: "Every page (top banner)",
    trigger: "Automatic on November 14",
    description:
      "Full-width banner: HAPPY BIRTHDAY TO MY CREATOR - EVAN KENT. If the 14th falls on a Saturday it also shows Friday the 13th as \"TOMORROW\"; on a Sunday it also shows Monday the 15th as \"BELATED\". Beats any holiday banner when both apply.",
  },
  {
    slug: "date-simulator",
    name: "Super-admin date simulator",
    emoji: "📅",
    status: "live",
    where: "Header toolbar (left of the 💡)",
    trigger: "Real super admins only — pick any date",
    description:
      "Preview tool for the date-driven eggs: writes a simulated-date cookie and re-renders the eggs as if it were that day. Eggs-only and fail-closed — nothing outside lib/eggs ever reads the cookie, and it is ignored unless the real, non-impersonated user is a super admin. A slim strip shows the simulated date while active.",
    exit: "Reset button in the 📅 popover",
  },
  {
    slug: "holiday-eve-banner",
    name: "Holiday-eve banner",
    emoji: "🏖️",
    status: "live",
    where: "Every page (top banner)",
    trigger: "Automatic the workday before a major US holiday",
    description:
      "\"I HOPE YOU HAVE TOMORROW OFF FOR <HOLIDAY>\" with gently falling emoji, the day before New Year's, Memorial Day, Independence Day, Labor Day, Thanksgiving, and Christmas. Weekend-aware: a Saturday holiday greets on Thursday, a Sunday or Monday holiday greets on Friday.",
  },
  {
    slug: "holiday-greetings",
    name: "Day-of holiday greetings",
    emoji: "🕎",
    status: "live",
    where: "Every page (top banner)",
    trigger: "Automatic on the holiday itself",
    description:
      "Greeting banners for 17 holidays — the US majors plus Rosh Hashanah, Yom Kippur, Hanukkah, Passover, Ramadan, both Eids, Lunar New Year, Diwali, Easter, and Kwanzaa — shown across each holiday's whole span. Lunar dates are table-verified for 2026–2032 (extend lib/eggs/holiday-dates.ts before 2033). Memorial Day and Yom Kippur render solemn: muted, no animation. Banners stack when occasions collide.",
  },
  {
    slug: "holiday-bulb",
    name: "Holiday light bulb",
    emoji: "🎃",
    status: "live",
    where: "Header 💡 feature-request button",
    trigger: "Automatic by season",
    description:
      "The 💡 swaps its glyph: 🎃 October 25–31, 🎄 December 20–26, 🎆 December 31–January 1. Fully functional the whole time — just dressed up.",
  },
  {
    slug: "new-year-confetti",
    name: "New Year confetti",
    emoji: "🎉",
    status: "live",
    where: "Every page",
    trigger: "Automatic on January 1–2, once per year",
    description:
      "One confetti burst with a \"Happy New Year from IAM Engine\" toast, guarded by a per-year localStorage key so it fires exactly once per person per year.",
  },
  {
    slug: "konami",
    name: "Konami code",
    emoji: "🕹️",
    status: "live",
    where: "Anywhere",
    trigger: "Type ↑ ↑ ↓ ↓ ← → ← → B A (outside inputs)",
    description:
      "Confetti burst plus the toast \"IAM Engine — built by Evan Kent, 2026 · see /credits\" — the one breadcrumb that reveals the credits page.",
  },
  {
    slug: "console-signature",
    name: "Console signature",
    emoji: "🖋️",
    status: "live",
    where: "Browser dev-tools console",
    trigger: "Automatic on page load",
    description:
      "A styled console.log with a small ASCII mark: \"Crafted by Evan Kent · 2026. Debugging? Check /docs first.\"",
  },
  {
    slug: "credits-page",
    name: "/credits page",
    emoji: "🎬",
    status: "live",
    where: "/credits (unlinked)",
    trigger: "Visit the URL — the Konami toast is the breadcrumb",
    description:
      "Film-credits plaque: created-by credit and fixed build stats (PRs shipped, runner versions, client profiles distilled). Static on purpose — no queries.",
  },
  {
    slug: "logo-7-click",
    name: "Logo 7-click",
    emoji: "🌀",
    status: "live",
    where: "Header app title",
    trigger: "Click the title 7 times within ~3 seconds",
    description:
      "The title plays one spin animation and renames itself \"Evan's IAM Engine\" until the next navigation.",
  },
  {
    slug: "milestone-sparkle",
    name: "Milestone case sparkle",
    emoji: "✨",
    status: "live",
    where: "Case detail pages",
    trigger: "Automatic when the case number is a multiple of 1000",
    description:
      "IAM0001000, IAM0002000, … get a small ✨ beside the case number with a \"milestone case\" tooltip. Pure render-time check.",
  },
  {
    slug: "starwars-crawl",
    name: "Change log opening crawl",
    emoji: "🌌",
    status: "live",
    where: "/changelog (any site version)",
    trigger: "Type \"starwars\" (outside inputs)",
    description:
      "The screen shakes, then the newest 8 changelog entries scroll as a tilted yellow opening crawl over a starfield — \"A long time ago in a data center far, far away....\" — closing with MAY THE UPTIME BE WITH YOU. Honors prefers-reduced-motion (static, scrollable text).",
    exit: "Esc or click",
  },
  {
    slug: "godfather-mode",
    name: "Run-log Godfather mode",
    emoji: "🎩",
    status: "live",
    where: "/runs (any site version)",
    trigger: "Type \"godfather\" (outside inputs)",
    description:
      "Every error line restyles in the Godfather-poster look — cream-on-black didone serif, gold-bordered ✗ badges, a 🎩 on the page title, and the hint pill \"Every error is an offer you can't refuse\". No font file shipped; it rides system Didot/Bodoni.",
    exit: "Esc or type the word again",
  },
  {
    slug: "pirate-battle",
    name: "Change log naval battle",
    emoji: "🏴‍☠️",
    status: "live",
    where: "/changelog (any site version)",
    trigger: "Type \"pirate\" (outside inputs)",
    description:
      "Two ships exchange fire: the newest 8 entries launch as cannonballs and land as pirate-speech parchment cards. Pure CSS keyframes, zero dependencies.",
    exit: "Esc or click",
  },

  // ---- The second batch (shipped together — the ten-egg PR) -------------------------------
  {
    slug: "matrix-agents",
    name: "Matrix rain on the fleet",
    emoji: "🟩",
    status: "live",
    where: "/agents (any site version)",
    trigger: "Type \"matrix\" (outside inputs)",
    description:
      "Digital rain over the runner fleet: each online agent becomes a falling glyph column headed by its name; offline agents read UNPLUGGED in red. Caption: \"There is no spoon RSAT.\" Honors prefers-reduced-motion (static glyphs).",
    exit: "Esc or click",
  },
  {
    slug: "hal-approval",
    name: "HAL 9000 approval gates",
    emoji: "🔴",
    status: "live",
    where: "Case detail — steps waiting for approval",
    trigger: "Type \"hal\" (outside inputs)",
    description:
      "Every \"needs approval\" badge goes black with a pulsing red camera eye and appends \"— I'm sorry, Dave. I'm afraid I can't do that.\" Fitting, since those gates really are server-side refusals.",
    exit: "Esc or type it again",
  },
  {
    slug: "mission-impossible-reveal",
    name: "Self-destructing password reveal",
    emoji: "🧨",
    status: "live",
    where: "Case detail — the one-time password reveal",
    trigger: "Type \"missionimpossible\" to arm, then reveal a generated password",
    description:
      "The one-time reveal already atomically wipes the secret server-side — this dramatizes it: with the mode armed, clicking \"I saved it\" chars the card edge-to-edge behind an ember line before it closes. It NEVER burns on its own — an auto-close could lose a real password.",
    exit: "Esc or type it again to disarm",
  },
  {
    slug: "terminator-offboard",
    name: "Terminator offboard HUD",
    emoji: "🤖",
    status: "live",
    where: "Offboard case detail",
    trigger: "Type \"terminator\" (outside inputs; offboard cases only)",
    description:
      "Completed destructive and disable steps get the red T-800 scanline readout with a \"TARGET: DEPROVISIONED\" stamp, the page title earns a 🤖, and the hint pill says \"Hasta la vista, baby.\"",
    exit: "Esc or type it again",
  },
  {
    slug: "wargames-dashboard",
    name: "WarGames terminal",
    emoji: "☎️",
    status: "live",
    where: "/cases (any site version)",
    trigger: "Type \"wargames\" (outside inputs)",
    description:
      "WOPR boots over the case list: green phosphor and scanlines, slow-typed \"SHALL WE PLAY A GAME?\", the cases listed as AVAILABLE SIMULATIONS, closing on \"THE ONLY WINNING MOVE IS NOT TO PLAY.\" Reduced motion renders the transcript instantly.",
    exit: "Esc or click",
  },
  {
    slug: "jurassic-denied",
    name: "Jurassic Park magic word",
    emoji: "🦖",
    status: "live",
    where: "Anywhere",
    trigger: "Type \"jurassic\" (outside inputs)",
    description:
      "Dennis Nedry's wagging-finger popup: \"Ah ah ah! You didn't say the magic word!\" — looping, pure CSS, no assets, mercifully no sound.",
    exit: "Esc or click",
  },
  {
    slug: "office-space-printer",
    name: "Office Space printer send-off",
    emoji: "🖨️",
    status: "live",
    where: "Case detail — the Printers manual step",
    trigger: "Type \"officespace\" (outside inputs)",
    description:
      "The printer step flashes PC LOAD LETTER, shakes, then gets dragged offscreen to the parking lot. For everyone who has ever dealt with a client printer. Esc brings it back unharmed (unlike the movie).",
    exit: "Esc or type it again",
  },
  {
    slug: "groundhog-retries",
    name: "Groundhog Day retries",
    emoji: "⏰",
    status: "live",
    where: "Case detail — steps waiting on auto-retry",
    trigger: "Type \"groundhog\" (outside inputs)",
    description:
      "Every auto-retry note becomes a 6:00 alarm-clock readout counting \"Day <attempt>\" — because the vendor-sync retry loop genuinely is the same morning over and over until it isn't.",
    exit: "Esc or type it again",
  },
  {
    slug: "bttf-time-circuits",
    name: "Back to the Future time circuits",
    emoji: "⚡",
    status: "live",
    where: "The simulated-date strip (super admins, while simulating)",
    trigger: "Type \"bttf\" while the date simulator is active",
    description:
      "The strip becomes DeLorean time circuits — DESTINATION TIME in red LED (simulated), PRESENT TIME in green (real) — behind a flux-capacitor flash. Doubles as a can't-miss reminder that you're in simulated time.",
    exit: "Esc or type it again",
  },
  {
    slug: "gandalf-blocked",
    name: "Gandalf on blocked steps",
    emoji: "🧙",
    status: "live",
    where: "Case detail — blocked steps and the missing-credentials banner",
    trigger: "Type \"gandalf\" (outside inputs)",
    description:
      "Steps blocked on a missing credential — and the case-level credentials banner — get YOU SHALL NOT PASS stamped across them with a staff-slam shake, while the missing requirement stays listed underneath. The joke sneaks in real diagnostics.",
    exit: "Esc or type it again",
  },

  // ---- The sound batch (ten eggs, seven with synthesized audio — spec:
  // docs/superpowers/specs/2026-07-24-sound-eggs-design.md). No audio assets anywhere; every
  // sound is an original Web Audio synth gesture, and localStorage["egg-sounds"]="off" mutes all.
  {
    slug: "not-found-nope",
    name: "The 404 rejection",
    emoji: "🏀",
    status: "live",
    where: "Any URL that doesn't exist",
    trigger: "Visit a missing page",
    description:
      "The app finally has a 404, and it does not want that URL in its house: a bouncing basketball plays the zero, a giant hand wags NO. NO. NO., and clicking the hand swats the request away with three synthesized uh-uh-uh thumps and a referee whistle. Sound is click-to-play (a page load is not a user gesture).",
    exit: "The link back to the dashboard",
  },
  {
    slug: "law-and-order",
    name: "Law & Order cold open",
    emoji: "🚔",
    status: "live",
    where: "/cases (any site version)",
    trigger: "Type \"lawandorder\" (outside inputs)",
    description:
      "A black title card over the docket: \"In the identity system, the people are represented by two separate yet equally important groups: the runners, who execute the steps, and the admins, who approve them.\" IAM ENGINE — SPECIAL PROVISIONS UNIT, and the two-note DUN DUN lands as the card slams in. These are their cases.",
    exit: "Esc or click",
  },
  {
    slug: "sad-trombone",
    name: "Sad trombone failures",
    emoji: "🎺",
    status: "live",
    where: "/runs (any site version)",
    trigger: "Type \"womp\" (outside inputs)",
    description:
      "Every failed row gets a 🎺 womp womp lead-in and a slow sag on its badge, while one synthesized wah-wah-wah-waaah plays the mode in. The kindest possible framing for a runner error.",
    exit: "Esc or type it again",
  },
  {
    slug: "dialup-agents",
    name: "Dial-up fleet reconnect",
    emoji: "📞",
    status: "live",
    where: "/agents (any site version)",
    trigger: "Type \"dialup\" (outside inputs)",
    description:
      "A terminal dials 1-556-0456 and the whole 1997 ritual plays out in synth: DTMF digits, carrier tone, the filtered-noise SCREEEECH, then every agent connects at 56,000 bps. Someone needs the phone line, so hang up when you're done.",
    exit: "Esc or click",
  },
  {
    slug: "mario-coins",
    name: "Coin block",
    emoji: "🪙",
    status: "live",
    where: "Anywhere",
    trigger: "Type \"mario\" (outside inputs)",
    description:
      "A ? block drops from the sky. Bonk it: a coin pops with the classic two-note chirp (synthesized, naturally) and the counter climbs. That's it. That's the egg. It's weirdly satisfying.",
    exit: "Esc or click outside the block",
  },
  {
    slug: "airhorn-ship",
    name: "Airhorn for the newest ship",
    emoji: "📣",
    status: "live",
    where: "/changelog (any site version)",
    trigger: "Type \"airhorn\" (outside inputs)",
    description:
      "The newest changelog entry gets a gold SHIPPED banner and three pumps of a synthesized triple airhorn blast — bwaa, bwaa, bwaaaaa. Every release deserves a hype man.",
    exit: "Esc or type it again",
  },
  {
    slug: "clippy",
    name: "Clipper, the assistant",
    emoji: "📎",
    status: "live",
    where: "Anywhere",
    trigger: "Type \"clippy\" (outside inputs)",
    description:
      "A fully original bent-wire office assistant boings into the corner with one page-aware line — \"It looks like you're provisioning a user. Have you tried turning them off and on again? Oh wait — that's offboarding.\" He has been waiting since 1997.",
    exit: "Esc or click the bubble",
  },
  {
    slug: "rickroll",
    name: "The rickroll",
    emoji: "🕺",
    status: "live",
    where: "Anywhere",
    trigger: "Type \"rickroll\" (outside inputs)",
    description:
      "You got got: a disco overlay, a tireless CSS dancer, and the lyrics rewritten for IAM — \"Never gonna give you up (your licenses, that is)\". Deliberately the only silent sound egg: the melody plays in your head, which is the whole point.",
    exit: "Esc or click",
  },
  {
    slug: "this-is-fine",
    name: "This is fine",
    emoji: "🔥",
    status: "live",
    where: "/runs (any site version)",
    trigger: "Type \"thisisfine\" (outside inputs)",
    description:
      "Failed rows smolder, a flame line flickers along the bottom of the viewport, and the hint dog sips his coffee: This is fine. Silent by design — the whole joke is the calm.",
    exit: "Esc or type it again",
  },
  {
    slug: "hold-music",
    name: "Hold music",
    emoji: "🎼",
    status: "live",
    where: "Case detail — steps still waiting to run",
    trigger: "Type \"holdmusic\" (outside inputs)",
    description:
      "Pending and running steps go on hold — \"🎼 Your step is important to us. Please continue to hold.\" — while a soft synthesized Cmaj7/Fmaj7 arpeggio loops until you exit. You are caller number 3.",
    exit: "Esc or type it again (stops the loop)",
  },

  // ---- The anniversary egg ----------------------------------------------------------------
  {
    slug: "anniversary-wedding",
    name: "March 22 wedding day",
    emoji: "💒",
    status: "live",
    where: "Every page",
    trigger: "Automatic on March 22, once per year",
    description:
      "Confetti bursts and the wedding photo takes over the screen with a big \"Whoo Hoo!\" — once per person per year, guarded by a per-year localStorage key like the New Year burst.",
    exit: "Esc or click",
  },
];

export const LIVE_EGGS = EGG_CATALOG.filter((e) => e.status === "live");
export const IDEA_EGGS = EGG_CATALOG.filter((e) => e.status === "idea");
