// A collapsible page section — the v3 chrome for the h2 blocks that make up a page. Native
// <details>/<summary> so it works in server components with no client JS: the summary reads like
// the <h2> it replaces (title + optional count + subtitle), with a chevron that rotates when open.
// Defaults to open, so a section only disappears when the operator chooses to fold it.
import type { ReactNode } from "react";

export function CollapsibleSection({
  title,
  count,
  subtitle,
  defaultOpen = true,
  children,
}: {
  title: ReactNode;
  count?: number;
  subtitle?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="collapsible" open={defaultOpen}>
      <summary className="collapsible-summary">
        <span className="collapsible-chevron" aria-hidden>▸</span>
        <span className="collapsible-title">{title}</span>
        {typeof count === "number" && <span className="collapsible-count">{count}</span>}
        {subtitle && <span className="note collapsible-subtitle">{subtitle}</span>}
      </summary>
      <div className="collapsible-body">{children}</div>
    </details>
  );
}
