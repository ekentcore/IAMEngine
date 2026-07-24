import { fmtDetail, fmtDetailLong } from "../_lib/loader";

// Audit "detail" cell. The one-line summary is shown truncated; when there's more (e.g. a long, often
// truncated error reason), it becomes a native <details> disclosure whose full text sits in a
// user-selectable <pre> — click to expand, then select + copy. Deliberately NO clipboard-button:
// this app runs over http on the LAN where navigator.clipboard is undefined and a copy button would
// silently no-op. Native selection works everywhere. No client JS — safe in a server component.
export function AuditDetailCell({ detail }: { detail: unknown }) {
  const oneLine = fmtDetail(detail);
  const full = fmtDetailLong(detail);

  // Nothing extra to reveal — render the plain (truncated) one-liner as before.
  if (!full || full === oneLine) {
    return (
      <td className="note" style={{ maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {oneLine}
      </td>
    );
  }

  return (
    <td className="note" style={{ maxWidth: 360 }}>
      <details>
        <summary style={{ cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title="Click to show the full detail">
          {oneLine}
        </summary>
        <pre
          style={{
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            userSelect: "text",
            margin: "6px 0 0",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 12,
          }}
        >
          {full}
        </pre>
      </details>
    </td>
  );
}
