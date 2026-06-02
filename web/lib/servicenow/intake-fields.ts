// The full intake-form picture for a UM: every u_* field on the User Management form, split into
// the ones the requester FILLED IN (with readable values) and the ones left blank — so a dry run
// shows exactly what was requested vs. omitted, with the human field labels.
import type { SnConfig, SnFieldValue } from "./types";
import { snGet, assertConfig } from "./http";

const TABLE = "/api/now/table/sn_customerservice_user_management";
const DICT = "/api/now/table/sys_dictionary";

export type IntakeField = { name: string; label: string; value: string };
export type IntakeBreakdown = {
  number: string;
  filled: IntakeField[];
  empty: Array<{ name: string; label: string }>;
};

// "Filled in" = a non-empty value that isn't a default-false checkbox (an unchecked box / blank
// field is treated as not provided).
function isFilled(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v !== "" && v !== "false";
}

export async function fetchIntakeFields(
  config: SnConfig,
  number: string,
  fetcher: typeof fetch = fetch
): Promise<IntakeBreakdown | null> {
  assertConfig(config);

  // 1. dictionary -> every u_* form field + its human label.
  const dict = await snGet<Array<{ element: string; column_label: string }>>(
    config,
    DICT,
    {
      sysparm_query: "name=sn_customerservice_user_management^elementSTARTSWITHu_",
      sysparm_fields: "element,column_label",
      sysparm_limit: "1000",
    },
    fetcher
  );
  const labels = new Map<string, string>();
  for (const d of dict) if (d.element) labels.set(d.element, d.column_label || d.element);
  const fields = [...labels.keys()];
  if (fields.length === 0) return null;

  // 2. the record, with readable display values for references/choices/dates.
  const rows = await snGet<Array<Record<string, SnFieldValue>>>(
    config,
    TABLE,
    {
      sysparm_query: `number=${number}`,
      sysparm_fields: ["number", ...fields].join(","),
      sysparm_display_value: "all",
      sysparm_limit: "1",
    },
    fetcher
  );
  const rec = rows[0];
  if (!rec) return null;

  const filled: IntakeField[] = [];
  const empty: Array<{ name: string; label: string }> = [];
  for (const name of fields) {
    const cell = rec[name];
    const value = (cell?.value ?? "").trim();
    const display = (cell?.display_value ?? "").trim();
    const label = labels.get(name) ?? name;
    if (isFilled(value)) {
      const shown = display && display !== value ? display : value === "true" ? "yes" : value;
      filled.push({ name, label, value: shown });
    } else {
      empty.push({ name, label });
    }
  }
  filled.sort((a, b) => a.label.localeCompare(b.label));
  empty.sort((a, b) => a.label.localeCompare(b.label));
  return { number, filled, empty };
}

// Plain-text render for the CLI dry run / a markdown section.
export function formatIntakeFields(b: IntakeBreakdown): string {
  const pad = Math.max(0, ...b.filled.map((f) => f.label.length)) + 2;
  const lines: string[] = [`Intake form — ${b.number}  (${b.filled.length} filled, ${b.empty.length} blank)`, ""];
  lines.push(`FILLED IN (${b.filled.length}):`);
  for (const f of b.filled) lines.push(`  ${f.label.padEnd(pad)}${f.value}`);
  lines.push("", `NOT FILLED IN (${b.empty.length}):`);
  for (const e of b.empty) lines.push(`  ${e.label}`);
  return lines.join("\n");
}
