"use client";

// Top-bar navigation with an active-route pill. Client component so it can read the path; the
// rest of the header (logomark, wordmark) stays in the server layout.
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  ["/clients", "Clients"],
  ["/cases", "Cases"],
  ["/runs", "Run log"],
  ["/agents", "Agents"],
  ["/modules", "Modules"],
  ["/health", "Health"],
] as const;

export function Nav({ showUsers = false, showAudit = false, showSettings = false, showChangelog = false }: { showUsers?: boolean; showAudit?: boolean; showSettings?: boolean; showChangelog?: boolean }) {
  const path = usePathname() ?? "";
  const items: ReadonlyArray<readonly [string, string]> = [
    ...ITEMS,
    ...(showAudit ? ([["/audit", "Audit"]] as const) : []),
    ...(showUsers ? ([["/users", "Users"]] as const) : []),
    ...(showChangelog ? ([["/changelog", "Change log"]] as const) : []),
    ...(showSettings ? ([["/settings", "Settings"]] as const) : []),
  ];
  return (
    <nav style={{ display: "flex", gap: 2 }}>
      {items.map(([href, label]) => {
        const active = path === href || path.startsWith(`${href}/`);
        return (
          <Link key={href} href={href} className="nav-link" aria-current={active ? "page" : undefined}>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
