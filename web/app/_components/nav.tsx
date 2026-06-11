"use client";

// Top-bar navigation with an active-route pill. Client component so it can read the path; the
// rest of the header (logomark, wordmark) stays in the server layout.
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  ["/clients", "Clients"],
  ["/cases", "Cases"],
  ["/agents", "Agents"],
  ["/health", "Health"],
] as const;

export function Nav({ showUsers = false }: { showUsers?: boolean }) {
  const path = usePathname() ?? "";
  const items: ReadonlyArray<readonly [string, string]> = showUsers ? [...ITEMS, ["/users", "Users"]] : ITEMS;
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
