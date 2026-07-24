// The super-admin field guide to every easter egg — data only, rendered by /easter-eggs.
// Live entries mirror the shipped eggs (specs: docs/superpowers/specs/2026-07-24-easter-eggs-design.md
// and 2026-07-24-pirate-egg-design.md); idea entries are the approved backlog of candidates.
// Keep this in sync when an egg ships: flip its idea entry to live (or add one) in the same PR.
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

  // ---- Ideas — approved backlog, not built yet --------------------------------------------
  {
    slug: "matrix-agents",
    name: "Matrix rain on the fleet",
    emoji: "🟩",
    status: "idea",
    where: "/agents",
    trigger: "Type \"matrix\"",
    description:
      "Digital rain over the runner fleet: each online agent's heartbeat becomes a falling glyph column in its row; offline agents read \"unplugged\". Claim-gate cameo: \"There is no spoon RSAT.\"",
  },
  {
    slug: "hal-approval",
    name: "HAL 9000 approval gates",
    emoji: "🔴",
    status: "idea",
    where: "Case detail — approval-gated offboard steps",
    trigger: "Type \"hal\"",
    description:
      "Steps waiting on requiresApproval grow a pulsing red camera eye and the blocked reason reads \"I'm sorry, Dave. I'm afraid I can't do that.\" Fitting, since those gates really are server-side refusals.",
  },
  {
    slug: "mission-impossible-reveal",
    name: "Self-destructing password reveal",
    emoji: "🧨",
    status: "idea",
    where: "Ad-hoc password reset reveal",
    trigger: "Type \"missionimpossible\"",
    description:
      "The one-time reveal already atomically wipes the secret — this dramatizes it: after copy, the card burns away edge-to-edge behind a fuse spark and \"This password will self-destruct in 5 seconds.\"",
  },
  {
    slug: "terminator-offboard",
    name: "Terminator offboard HUD",
    emoji: "🤖",
    status: "idea",
    where: "Offboard case detail",
    trigger: "Type \"terminator\"",
    description:
      "Completed destructive steps get the red T-800 scanline readout (\"TARGET: DEPROVISIONED\"), the case-close toast says \"Hasta la vista\", and a later onboard of the same user earns \"He's back.\"",
  },
  {
    slug: "wargames-dashboard",
    name: "WarGames terminal",
    emoji: "☎️",
    status: "idea",
    where: "Cases list / dashboard",
    trigger: "Type \"wargames\"",
    description:
      "Green phosphor WOPR skin, slow-typed \"SHALL WE PLAY A GAME?\", cases rendered as simulation entries; Esc exits with \"THE ONLY WINNING MOVE IS NOT TO PLAY.\"",
  },
  {
    slug: "jurassic-denied",
    name: "Jurassic Park permission denial",
    emoji: "🦖",
    status: "idea",
    where: "Permission-denied views",
    trigger: "Type \"jurassic\"",
    description:
      "Dennis Nedry's \"Ah ah ah! You didn't say the magic word\" wagging-finger loop (pure CSS, no assets) over the denied panel. Client-scoping denials are the natural home.",
  },
  {
    slug: "office-space-printer",
    name: "Office Space printer send-off",
    emoji: "🖨️",
    status: "idea",
    where: "Manual printer checklist steps",
    trigger: "Type \"officespace\"",
    description:
      "The printer row glitches, flashes PC LOAD LETTER, then gets dragged offscreen and beaten (CSS shake and fly-out). For everyone who has ever dealt with a client printer.",
  },
  {
    slug: "groundhog-retries",
    name: "Groundhog Day retries",
    emoji: "⏰",
    status: "idea",
    where: "Job detail with re-queued attempts",
    trigger: "Type \"groundhog\"",
    description:
      "A much-retried job shows a 6:00 AM flip-clock badge and its attempt list rewords as \"Day 1… Day 2… Day 47.\" The stale-lease re-queue means retries genuinely do loop.",
  },
  {
    slug: "bttf-time-circuits",
    name: "Back to the Future time circuits",
    emoji: "⚡",
    status: "idea",
    where: "Simulated-date strip (super admins)",
    trigger: "Type \"bttf\" while the date simulator is active",
    description:
      "The strip becomes DeLorean time circuits — DESTINATION TIME in red LED (simulated), PRESENT TIME in green (real) — and changing the date fires a flux-capacitor flash. Doubles as a can't-miss reminder that you're in simulated time.",
  },
  {
    slug: "gandalf-blocked",
    name: "Gandalf on blocked jobs",
    emoji: "🧙",
    status: "idea",
    where: "Unclaimable / blocked jobs",
    trigger: "Type \"gandalf\"",
    description:
      "A job stuck on a missing required secret or capability gets YOU SHALL NOT PASS stamped across it with a staff-slam shake — and the missing requirement listed underneath, so the joke sneaks in real diagnostics.",
  },
];

export const LIVE_EGGS = EGG_CATALOG.filter((e) => e.status === "live");
export const IDEA_EGGS = EGG_CATALOG.filter((e) => e.status === "idea");
