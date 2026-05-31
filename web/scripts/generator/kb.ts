// Load the ServiceNow KB runbook corpus (data/*.jsonl) and extract, per client, which
// systems each runbook describes (from its section headers) plus the raw headers we
// couldn't map (the "detected but not yet modeled" signal).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { headerToSystemKey } from "./system-map";

const DATA_DIR = join(process.cwd(), "..", "data");

type KbRecord = {
  action: "onboarding" | "offboarding";
  number: string;
  short_description: string;
  client: string;
  client_leaf: string;
  domain_raw?: string;
  latest?: boolean;
  body_html: string;
};

export type ClientKb = {
  clientLeaf: string;
  clientPath: string; // full domain path, e.g. "Community Veterinary Partners/<practice>"
  domainRaw: string | null;
  onboardKb: string | null;
  offboardKb: string | null;
  onboardSystems: string[]; // mapped system keys, in document order
  offboardSystems: string[];
  unmodeled: string[]; // raw headers that didn't map to a known system
  family: "cvp" | "olympus" | null; // practice-family templating
  onboardText: string; // stripped, truncated runbook body (for LLM enrichment)
  offboardText: string;
};

function stripHtml(html: string, max = 6000): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function loadJsonl(file: string): KbRecord[] {
  const out: KbRecord[] = [];
  const raw = readFileSync(join(DATA_DIR, file), "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t) as KbRecord;
      if (r.latest !== false) out.push(r);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

function extractHeaders(html: string): string[] {
  const out: string[] = [];
  const re = /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const text = m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (text && text.toLowerCase() !== "table of contents") out.push(text);
  }
  return out;
}

// Map a runbook's headers -> ordered unique system keys + the headers we couldn't place.
function classify(html: string): { systems: string[]; unmodeled: string[] } {
  const systems: string[] = [];
  const unmodeled: string[] = [];
  for (const h of extractHeaders(html)) {
    const key = headerToSystemKey(h);
    if (key) {
      if (!systems.includes(key)) systems.push(key);
    } else if (!unmodeled.includes(h)) {
      unmodeled.push(h);
    }
  }
  return { systems, unmodeled };
}

function detectFamily(path: string): "cvp" | "olympus" | null {
  const p = path.toLowerCase();
  if (p.includes("community veterinary partners") || p.startsWith("cvp")) return "cvp";
  if (p.includes("olympus")) return "olympus";
  return null;
}

// Group both KB feeds by client_leaf into one record per client.
export function loadClientKb(): ClientKb[] {
  const onboard = loadJsonl("onboarding.jsonl");
  const offboard = loadJsonl("offboarding.jsonl");

  const byClient = new Map<string, ClientKb>();
  const ensure = (r: KbRecord): ClientKb => {
    let c = byClient.get(r.client_leaf);
    if (!c) {
      c = {
        clientLeaf: r.client_leaf,
        clientPath: r.client || r.client_leaf,
        domainRaw: r.domain_raw ?? null,
        onboardKb: null, offboardKb: null,
        onboardSystems: [], offboardSystems: [], unmodeled: [],
        family: detectFamily(r.client || r.client_leaf),
        onboardText: "", offboardText: "",
      };
      byClient.set(r.client_leaf, c);
    }
    return c;
  };

  for (const r of onboard) {
    const c = ensure(r);
    c.onboardKb = r.number;
    const { systems, unmodeled } = classify(r.body_html);
    c.onboardSystems = systems;
    c.onboardText = stripHtml(r.body_html);
    for (const u of unmodeled) if (!c.unmodeled.includes(u)) c.unmodeled.push(u);
  }
  for (const r of offboard) {
    const c = ensure(r);
    c.offboardKb = r.number;
    const { systems, unmodeled } = classify(r.body_html);
    c.offboardSystems = systems;
    c.offboardText = stripHtml(r.body_html);
    for (const u of unmodeled) if (!c.unmodeled.includes(u)) c.unmodeled.push(u);
  }

  return [...byClient.values()].sort((a, b) => a.clientLeaf.localeCompare(b.clientLeaf));
}
