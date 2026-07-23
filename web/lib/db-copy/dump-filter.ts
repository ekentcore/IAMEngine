// Cross-version guard for the pg_dump → psql pipe. pg_dump emits a preamble of `SET <guc> = …;`
// statements; when the pg_dump/source is NEWER than the destination, some of those GUCs don't exist
// on the older destination and psql aborts (ON_ERROR_STOP). The one that bites 17→pre-17 copies is
// `transaction_timeout` (added in PostgreSQL 17): "unrecognized configuration parameter
// transaction_timeout". Dropping the line is safe — its value is 0 (no timeout), the default anyway.
// This filters the streamed SQL line by line, removing only those known-incompatible SET lines.
import { Transform } from "node:stream";

// SET lines to drop, keyed by the GUC the destination may not recognize. Extend if a future pg_dump
// preamble introduces another newer-than-destination GUC.
const DROP = /^\s*SET\s+(transaction_timeout)\b/i;

/** True when a dump line is a SET for a GUC an older destination won't recognize (drop it). */
export function isDroppableDumpLine(line: string): boolean {
  return DROP.test(line);
}

/** A stream transform that drops incompatible SET lines while passing everything else through unchanged. */
export function dumpLineFilter(): Transform {
  let buf = "";
  return new Transform({
    transform(chunk, _enc, cb) {
      buf += chunk.toString("utf8");
      const parts = buf.split("\n");
      buf = parts.pop() ?? ""; // last element is a partial line (or "" if the chunk ended on \n)
      const kept = parts.filter((l) => !isDroppableDumpLine(l));
      cb(null, kept.length ? kept.join("\n") + "\n" : "");
    },
    flush(cb) {
      // Trailing partial line with no newline — emit unless it's itself a droppable SET.
      cb(null, buf.length && !isDroppableDumpLine(buf) ? buf : "");
    },
  });
}
