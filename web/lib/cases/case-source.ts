// How a case was opened, in the words an engineer would use.
import type { CaseSource } from "@prisma/client";

export const CASE_SOURCE_LABEL: Record<CaseSource, string> = {
  manual: "Created by hand",
  servicenow: "Imported from ServiceNow",
  intake_poll: "Imported automatically",
  sim: "Created by the simulator",
  api: "Created programmatically",
};
