// Deterministically parse a group-mapping spreadsheet (the KB's "permissions groups" xls)
// into a header + rows table. The LLM only DECIDES which rows/groups apply to a user; the
// cell-reading is reliable code here, and sheetCellValues() bounds what the LLM may return.
import * as XLSX from "xlsx";

export type GroupSheet = {
  sheetName: string;
  headers: string[];
  rows: Record<string, string>[];
};

export function parseGroupSheet(data: Buffer): GroupSheet {
  const wb = XLSX.read(data, { type: "buffer" });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error("spreadsheet has no sheets");
  const ws = wb.Sheets[sheetName];

  const matrix = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, blankrows: false, defval: "" });
  const headerRow = matrix.find((r) => r.some((c) => String(c).trim() !== ""));
  if (!headerRow) return { sheetName, headers: [], rows: [] };

  const headers = headerRow.map((h) => String(h).trim());
  const start = matrix.indexOf(headerRow) + 1;
  const rows = matrix.slice(start)
    .filter((r) => r.some((c) => String(c).trim() !== ""))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, String(r[i] ?? "").trim()])));

  return { sheetName, headers, rows };
}

// Every distinct non-empty cell value — used to bound the resolver's output to values that
// actually appear in the sheet (no hallucinated group names).
export function sheetCellValues(sheet: GroupSheet): string[] {
  const set = new Set<string>();
  for (const row of sheet.rows) for (const v of Object.values(row)) if (v.trim()) set.add(v.trim());
  return [...set];
}
