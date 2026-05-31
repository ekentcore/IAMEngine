// Regression gauge: diff generated drafts against the hand-curated profiles (matched by
// client.name). Not a gate — a signal of how close extraction gets to known-good profiles.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Profile } from "./profile.js";

export function diffAgainstCurated(curatedDir: string, generated: Map<string, Profile>): string[] {
  const lines: string[] = ["", "## Diff vs hand-curated profiles", ""];
  let matched = 0;
  for (const file of readdirSync(curatedDir)) {
    if (!file.endsWith(".json") || file.startsWith("_")) continue;
    const curated = JSON.parse(readFileSync(join(curatedDir, file), "utf8")) as Profile;
    if (curated.schemaVersion !== "2.0") continue;
    const gen = generated.get(curated.client.name.toLowerCase());
    if (!gen) continue;
    matched++;
    const cKeys = new Set(curated.systems.map((s) => s.key));
    const gKeys = new Set(gen.systems.map((s) => s.key));
    const missing = [...cKeys].filter((k) => !gKeys.has(k));
    const extra = [...gKeys].filter((k) => !cKeys.has(k));
    const bbFlag = curated.identity.backbone === gen.identity.backbone ? "ok" : `**${gen.identity.backbone}** vs curated **${curated.identity.backbone}**`;
    lines.push(`### ${curated.client.name} (${file})`);
    lines.push(`- backbone: ${bbFlag}`);
    lines.push(`- systems missing vs curated: ${missing.length ? missing.join(", ") : "none"}`);
    lines.push(`- systems extra vs curated: ${extra.length ? extra.join(", ") : "none"}`);
    lines.push("");
  }
  if (!matched) lines.push("_(no generated drafts matched a curated profile by client name)_");
  return lines;
}
