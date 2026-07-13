// Parse the project's root env.env as plain KEY="value" lines — WITHOUT shell expansion
// (the ServiceNow password contains $, &, *, > which a shell would mangle). Skips blank
// lines, comments, and malformed lines like the "@MistralAI" header. Later duplicates win.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ENV_PATH = resolve(HERE, "../../env.env"); // repo root

export function parseEnvFile(path = ENV_PATH) {
  const out = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("@")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    // Take the QUOTED SPAN when the value is quoted, ignoring anything after the closing quote.
    // The old rule required the value to both start AND end with a quote, so a quoted value with a
    // trailing comment — KEY="val"  # note — matched neither branch: the comment was trimmed but the
    // quotes were left ON. DELINEA_BASE_URL is written exactly that way, so every consumer got
    // `"https://…"` (quotes included) and every Delinea fetch died on an invalid URL.
    const quoted = /^(["'])([\s\S]*?)\1\s*(?:#.*)?$/.exec(value);
    if (quoted) {
      value = quoted[2];
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value; // later wins
  }
  return out;
}

export function buildDatabaseUrl(env) {
  const user = encodeURIComponent(env.POSTGRES_USER ?? "");
  const pass = encodeURIComponent(env.POSTGRES_PASSWORD ?? "");
  const host = env.POSTGRES_HOST ?? "localhost";
  const port = env.POSTGRES_PORT ?? "5432";
  const dbRaw = (env.POSTGRES_DB ?? "iam_engine").replace(/^"|"$/g, "");
  return { url: `postgresql://${user}:${pass}@${host}:${port}/${dbRaw}?schema=public`, dbName: dbRaw };
}
