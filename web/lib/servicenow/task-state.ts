// Look up the live state of any ServiceNow task-derived record (PC procurement cases, UMs, …) by
// its number. The `task` table spans every task type, so this works without knowing the record's
// concrete table. Display values so the state is the human label ("Resolved"), not a code.
import type { SnConfig } from "./types";
import { snGet } from "./http";

export type TaskState = { number: string; state: string; sysClassName: string } | null;

type Fetcher = typeof fetch;

export async function fetchTaskState(config: SnConfig, number: string, fetcher: Fetcher = fetch): Promise<TaskState> {
  const rows = await snGet<Array<{ number?: { display_value?: string }; state?: { display_value?: string }; sys_class_name?: { display_value?: string } }>>(
    config,
    "/api/now/table/task",
    {
      sysparm_query: `number=${number}`,
      sysparm_fields: "number,state,sys_class_name",
      sysparm_display_value: "all",
      sysparm_limit: "1",
    },
    fetcher
  );
  const r = rows[0];
  if (!r) return null;
  return {
    number: r.number?.display_value ?? number,
    state: r.state?.display_value ?? "",
    sysClassName: r.sys_class_name?.display_value ?? "",
  };
}

// Batch lookup: the states of many task numbers in one query per chunk (`numberIN<a>,<b>,…`), keyed
// by number. Numbers that don't match the record-number shape (defense against query injection —
// same rule as resolveUmSysId) or that SN doesn't know are simply absent from the map.
const NUMBER_RE = /^[A-Za-z]{2,6}\d{5,}$/;
const CHUNK = 50; // keep the sysparm_query comfortably under URL-length limits

export async function fetchTaskStates(config: SnConfig, numbers: string[], fetcher: Fetcher = fetch): Promise<Map<string, NonNullable<TaskState>>> {
  const valid = numbers.filter((n) => NUMBER_RE.test(n));
  const out = new Map<string, NonNullable<TaskState>>();
  for (let i = 0; i < valid.length; i += CHUNK) {
    const chunk = valid.slice(i, i + CHUNK);
    const rows = await snGet<Array<{ number?: { display_value?: string }; state?: { display_value?: string }; sys_class_name?: { display_value?: string } }>>(
      config,
      "/api/now/table/task",
      {
        sysparm_query: `numberIN${chunk.join(",")}`,
        sysparm_fields: "number,state,sys_class_name",
        sysparm_display_value: "all",
        sysparm_limit: String(chunk.length),
      },
      fetcher
    );
    for (const r of rows) {
      const number = r.number?.display_value;
      if (!number) continue;
      out.set(number, { number, state: r.state?.display_value ?? "", sysClassName: r.sys_class_name?.display_value ?? "" });
    }
  }
  return out;
}

// Classify a task state label. "Cancelled" / "Closed Incomplete" / "Closed Skipped" must NOT count
// as done — those closures mean the work (the license purchase) did NOT happen, so the blocked
// step must not auto-re-run. Only an affirmative resolution counts.
export function classifyTaskState(state: string): "open" | "done" | "cancelled" {
  if (/cancel|incomplete|skip/i.test(state)) return "cancelled";
  if (/resolv|closed|complete/i.test(state)) return "done";
  return "open";
}
