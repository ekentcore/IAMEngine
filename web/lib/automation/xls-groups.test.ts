import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { parseGroupSheet, sheetCellValues } from "./xls-groups";

function workbook(rows: string[][]): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Groups");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

const buf = workbook([
  ["Department", "Groups"],
  ["Finance", "FIN-Users; AAD-KnowBe4"],
  ["Sales", "SALES-Users"],
]);

test("parses headers and rows from the first sheet", () => {
  const sheet = parseGroupSheet(buf);
  assert.equal(sheet.sheetName, "Groups");
  assert.deepEqual(sheet.headers, ["Department", "Groups"]);
  assert.equal(sheet.rows.length, 2);
  assert.deepEqual(sheet.rows[0], { Department: "Finance", Groups: "FIN-Users; AAD-KnowBe4" });
});

test("sheetCellValues returns every distinct cell value (for the resolver guardrail)", () => {
  const vals = sheetCellValues(parseGroupSheet(buf));
  assert.ok(vals.includes("Finance"));
  assert.ok(vals.includes("FIN-Users; AAD-KnowBe4"));
  assert.ok(vals.includes("SALES-Users"));
});

test("degrades gracefully on a non-spreadsheet buffer (no data rows, no crash)", () => {
  const sheet = parseGroupSheet(Buffer.from("not a spreadsheet"));
  assert.ok(Array.isArray(sheet.headers) && Array.isArray(sheet.rows));
  assert.equal(sheet.rows.length, 0);
});
