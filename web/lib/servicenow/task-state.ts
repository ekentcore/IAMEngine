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

// Classify a task state label. "Cancelled" must NOT count as done — a cancelled procurement case
// means the license was never bought, so the blocked step should not auto-re-run.
export function classifyTaskState(state: string): "open" | "done" | "cancelled" {
  if (/cancel/i.test(state)) return "cancelled";
  if (/resolv|closed|complete/i.test(state)) return "done";
  return "open";
}
