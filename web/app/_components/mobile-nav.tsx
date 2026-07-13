"use client";

// Mobile header nav: a hamburger that opens a slide-in drawer. Only visible ≤760px (the desktop inline
// nav is hidden there). Mirrors the desktop Nav's items + role gating.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { createPortal } from "react-dom";

const ITEMS: ReadonlyArray<readonly [string, string]> = [
  ["/clients", "Clients"],
  ["/cases", "Cases"],
  ["/runs", "Run log"],
  ["/agents", "Agents"],
  ["/modules", "Modules"],
  ["/help", "Help"],
  ["/health", "Health"],
];

export function MobileNav({ showUsers = false, showAudit = false, showSettings = false }: { showUsers?: boolean; showAudit?: boolean; showSettings?: boolean }) {
  const [open, setOpen] = useState(false);
  const path = usePathname() ?? "";
  const items: ReadonlyArray<readonly [string, string]> = [
    ...ITEMS,
    ...(showAudit ? ([["/audit", "Audit"]] as const) : []),
    ...(showUsers ? ([["/users", "Users"]] as const) : []),
    ...(showSettings ? ([["/settings", "Settings"]] as const) : []),
  ];
  return (
    <span className="mobile-nav">
      <button type="button" className="mobile-nav-btn" aria-label="Open menu" aria-expanded={open} onClick={() => setOpen(true)}>☰</button>
      {/* Portal to <body>: the .app-header has backdrop-filter, which would make it the containing block
          for the fixed-position drawer and trap it inside the header's height. */}
      {open && createPortal(
        <>
          <div className="mobile-drawer-backdrop" onClick={() => setOpen(false)} />
          <nav className="mobile-drawer" aria-label="Main menu">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <strong>Menu</strong>
              <button type="button" className="mobile-nav-btn" aria-label="Close menu" onClick={() => setOpen(false)}>✕</button>
            </div>
            {items.map(([href, label]) => (
              <Link key={href} href={href} aria-current={path === href || path.startsWith(`${href}/`) ? "page" : undefined} onClick={() => setOpen(false)}>
                {label}
              </Link>
            ))}
          </nav>
        </>,
        document.body,
      )}
    </span>
  );
}
