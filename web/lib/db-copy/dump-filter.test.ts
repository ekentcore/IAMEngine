import { test } from "node:test";
import assert from "node:assert/strict";
import { isDroppableDumpLine, dumpLineFilter } from "./dump-filter";

test("isDroppableDumpLine drops the PG17+ transaction_timeout GUC an older dest rejects", () => {
  assert.equal(isDroppableDumpLine("SET transaction_timeout = 0;"), true);
  assert.equal(isDroppableDumpLine("  set   transaction_timeout=0 ;"), true, "case/space tolerant");
});

test("isDroppableDumpLine keeps every other SET and all data lines", () => {
  for (const keep of [
    "SET statement_timeout = 0;",
    "SET lock_timeout = 0;",
    "SET idle_in_transaction_session_timeout = 0;",
    "SET client_encoding = 'UTF8';",
    "SET search_path = public;",
    "COPY public.client (id, name) FROM stdin;",
    "42\ttransaction_timeout\t\\N", // a data row that merely mentions the word
    "-- Dumped by pg_dump version 18.4",
    "",
  ]) {
    assert.equal(isDroppableDumpLine(keep), false, `should keep: ${keep}`);
  }
});

test("dumpLineFilter strips the offending line from a streamed dump, preserving the rest byte-for-byte otherwise", async () => {
  const input =
    "-- PostgreSQL database dump\n" +
    "SET statement_timeout = 0;\n" +
    "SET lock_timeout = 0;\n" +
    "SET transaction_timeout = 0;\n" +
    "SET client_encoding = 'UTF8';\n" +
    "COPY public.client (id, name) FROM stdin;\n" +
    "1\tAcme\n" +
    "\\.\n";

  const filter = dumpLineFilter();
  const chunks: Buffer[] = [];
  filter.on("data", (c) => chunks.push(Buffer.from(c)));
  const done = new Promise<void>((res) => filter.on("end", () => res()));
  // write in awkward chunk boundaries to prove line-buffering across chunks
  filter.write(input.slice(0, 40));
  filter.write(input.slice(40, 95));
  filter.write(input.slice(95));
  filter.end();
  await done;

  const out = Buffer.concat(chunks).toString();
  assert.equal(out.includes("transaction_timeout"), false, "offending GUC removed");
  assert.equal(out.includes("SET statement_timeout = 0;"), true);
  assert.equal(out.includes("SET lock_timeout = 0;"), true);
  assert.equal(out.includes("SET client_encoding = 'UTF8';"), true);
  assert.equal(out.includes("COPY public.client (id, name) FROM stdin;"), true);
  assert.equal(out.includes("1\tAcme"), true);
  assert.equal(out.includes("\\."), true);
  // exactly the one line removed
  assert.equal(out, input.split("\n").filter((l) => l !== "SET transaction_timeout = 0;").join("\n"));
});
