import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "runner-generator",
  date: "2026-06-05",
  approx: true,
  title: "Runner service + profile generator (week of Jun 1)",
  items: [
    "PowerShell 7 runner: polls the app, claims jobs, executes Coretelligent.* modules, posts results",
    "Fleet profile generator produced 231 draft client profiles (70 tests)",
    "On-request lanes: intake answers turn optional systems on per case",
  ],
};
