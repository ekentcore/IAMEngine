// One-off audit: did the source onboarding KBs contain persona/role, location, or group-list
// signal that the v2.0 generator dropped? Scans data/onboarding.jsonl body_html per client and
// reports who has strong v2.1 signal. Heuristic — meant to size the gap, not to be authoritative.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "..");
const lines = readFileSync(join(ROOT, "data/onboarding.jsonl"), "utf8").split("\n").filter(Boolean);

const strip = (html) => (html ?? "")
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
  .replace(/\s+/g, " ");

// Strong signals (conditionality + enumerations), tuned to over-report rather than miss.
const tableCount = (h) => (h.match(/<table/gi) || []).length;
const liCount = (h) => (h.match(/<li/gi) || []).length;
const groupNames = (t) => {
  // typical AD/cloud group-naming shapes: SG-x, GRP-x, TEAM-x, *-Users, Egnyte-x, "Security Group"
  const m = t.match(/\b([A-Z][A-Za-z0-9]+[-_][A-Za-z0-9][\w-]{1,40})\b/g) || [];
  return new Set(m.filter((g) => /(-|_)(users|group|team|admins?|staff|all|vpn|rds|sso)\b/i.test(g) || /^(SG|GRP|GG|DL|TEAM|DEPT|RDS|VPN|SSO|Egnyte|Centrify)[-_]/i.test(g)));
};
const has = (t, re) => re.test(t);

const ROLE_RE = /\b(if (the )?(user|employee|they) (is|are|will be)|depending on (the|their)|based on (their |the )?(role|title|department|position|job)|for (sales|engineering|finance|hr|executive|admin|management|field|remote|professional)\b|persona|job role|by (role|title|department))\b/i;
const LOC_RE = /\b(time ?zone|office location|site code|by (office|location|site)|each (office|location|site)|branch office|physical(DeliveryOfficeName)?|street address|city.{0,12}state)\b/i;
const GROUP_RE = /\b(security group|distribution (list|group)|add(ed)? to (the )?group|member ?of|group membership|ad groups?|m365 groups?|microsoft 365 groups?)\b/i;

const rows = [];
for (const ln of lines) {
  let rec; try { rec = JSON.parse(ln); } catch { continue; }
  const t = strip(rec.body_html);
  const groups = groupNames(t);
  const role = has(t, ROLE_RE);
  const loc = has(t, LOC_RE);
  const grp = has(t, GROUP_RE) || groups.size >= 3;
  const tables = tableCount(rec.body_html);
  const score = (role ? 1 : 0) + (loc ? 1 : 0) + (grp ? 1 : 0);
  rows.push({
    client: rec.client_leaf || rec.client || "?", number: rec.number,
    role, loc, grp, groups: groups.size, tables, li: liCount(rec.body_html), score,
    sample: [...groups].slice(0, 6),
  });
}

const n = rows.length;
const c = (f) => rows.filter(f).length;
console.log(`Scanned ${n} onboarding KBs\n`);
console.log(`role/persona conditionality signal : ${c((r) => r.role)}`);
console.log(`location/office signal             : ${c((r) => r.loc)}`);
console.log(`group-list signal                  : ${c((r) => r.grp)}`);
console.log(`>=2 of the three signals           : ${c((r) => r.score >= 2)}`);
console.log(`all three signals                  : ${c((r) => r.score === 3)}`);
console.log(`has >=1 HTML table                 : ${c((r) => r.tables >= 1)}\n`);

console.log("Top 20 strongest v2.1 candidates (by signal score, then group count):");
rows.sort((a, b) => b.score - a.score || b.groups - a.groups || b.tables - a.tables);
for (const r of rows.slice(0, 20)) {
  console.log(
    `  ${String(r.score)}★ ${r.client.padEnd(34).slice(0, 34)} ` +
    `${r.role ? "role " : "     "}${r.loc ? "loc " : "    "}${r.grp ? "grp " : "    "}` +
    `grps=${String(r.groups).padStart(2)} tbl=${String(r.tables).padStart(2)} ${r.number}` +
    (r.sample.length ? `  e.g. ${r.sample.join(", ")}` : "")
  );
}
