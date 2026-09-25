import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "custom-connectors-attachable",
  date: "2026-09-22",
  time: "17:45",
  title: "Published custom connectors can be added to a client",
  items: [
    "A custom connector published from the Connectors builder now appears in a client's Edit systems \"add system…\" list, under Custom connectors - before, the list only offered the built-in systems, so a published connector had no way to be picked",
    "Adding one fills in sensible defaults: it runs in each lane (onboard/offboard) its definition implements and is off in the others, with the secrets the definition uses",
    "Draft and archived connectors are not offered",
  ],
};
