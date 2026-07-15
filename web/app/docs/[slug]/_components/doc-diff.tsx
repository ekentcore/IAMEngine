"use client";

// Shared renderer for a collapsed line diff (redline). Used by the draft-review panel and the
// version-compare tool so they never drift. `diff` is the collapsed line list from lib/docs/diff.ts —
// reuse that module's exact union type so a mistyped variant can't slip through.
import type { DiffLine } from "@/lib/docs/diff";
export type { DiffLine };

export function DocDiff({ diff }: { diff: DiffLine[] }) {
  return (
    <pre className="doc-diff">
      {diff.map((l, i) =>
        l.type === "same" && l.text === "" ? (
          <span key={i} className="doc-diff-gap">{"  ⋯\n"}</span>
        ) : (
          <span key={i} className={`doc-diff-${l.type}`}>{(l.type === "add" ? "+ " : l.type === "del" ? "- " : "  ") + l.text + "\n"}</span>
        )
      )}
    </pre>
  );
}
