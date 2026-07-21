"use client";

// Top-bar navigation. The four operational pages stay as inline links; everything else
// (reference + admin, role-gated) folds into one "More" menu so the bar stays compact as
// pages accumulate. Client component so it can read the path for active states.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { FeatureRequestNavBadge } from "./feature-request-nav-badge";

// The one menu link that carries a live count badge — kept as a constant so nav and mobile-nav agree.
export const FEATURE_REQUESTS_HREF = "/feature-requests";

// Always-visible: the pages an operator lives in. (Also the mobile drawer's first group.)
export const PRIMARY = [
  ["/clients", "Clients"],
  ["/cases", "Cases"],
  ["/runs", "Run log"],
  ["/agents", "Agents"],
] as const;

type Item = readonly [string, string];

// Reference + admin pages, grouped for the menu. Role-gated entries are filtered by the flags
// the server layout passes down (the server stays the authority; this only hides links).
export function menuGroups(flags: { showUsers?: boolean; showAudit?: boolean; showSettings?: boolean; showChangelog?: boolean; showDocs?: boolean; showFleetAudit?: boolean; showConnectors?: boolean }): { label: string; items: Item[] }[] {
  const reference: Item[] = [
    ...(flags.showDocs ? ([["/docs", "Documents"]] as const) : []),
    // Everyone sees the board (read-only below admin); the admin editor lives ON the page,
    // gated server-side — it moved out of Settings, so the nav is how you find it now.
    ["/feature-requests", "Feature requests"],
    ["/modules", "Modules"],
    ["/health", "Health"],
    // Fleet sweeps over every client's M365 credential — same capability as wiring one.
    ...(flags.showFleetAudit ? ([["/fleet-audit", "Fleet audits"]] as const) : []),
    ["/help", "Help"],
  ];
  // Self-contained operator utilities — no data access, no role gate (everything runs in the browser).
  const tools: Item[] = [
    ["/tools/google-key", "Google key converter"],
  ];
  const admin: Item[] = [
    ...(flags.showAudit ? ([["/audit", "Audit"]] as const) : []),
    ...(flags.showUsers ? ([["/users", "Users"]] as const) : []),
    ...(flags.showConnectors ? ([["/connectors", "Connectors"]] as const) : []),
    ...(flags.showChangelog ? ([["/changelog", "Change log"]] as const) : []),
    ...(flags.showSettings ? ([["/settings", "Settings"]] as const) : []),
  ];
  return [
    { label: "Reference", items: reference },
    { label: "Tools", items: tools },
    ...(admin.length ? [{ label: "Administration", items: admin }] : []),
  ];
}

const isActive = (path: string, href: string) => path === href || path.startsWith(`${href}/`);

export function Nav(flags: { showUsers?: boolean; showAudit?: boolean; showSettings?: boolean; showChangelog?: boolean; showDocs?: boolean; showFleetAudit?: boolean; showConnectors?: boolean }) {
  const path = usePathname() ?? "";
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const groups = menuGroups(flags);
  const menuActive = groups.some((g) => g.items.some(([href]) => isActive(path, href)));

  // Close on route change, outside click, and Escape — standard disclosure behavior.
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  return (
    <nav style={{ display: "flex", gap: 2, alignItems: "center" }}>
      {PRIMARY.map(([href, label]) => (
        <Link key={href} href={href} className="nav-link" aria-current={isActive(path, href) ? "page" : undefined}>
          {label}
        </Link>
      ))}
      <div className="nav-more" ref={wrap}>
        <button
          type="button"
          className="nav-link nav-more-btn"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-current={menuActive ? "page" : undefined}
          onClick={() => setOpen((v) => !v)}
        >
          More <span className="nav-caret" aria-hidden="true" />
        </button>
        {open && (
          <div className="nav-menu" role="menu" aria-label="More pages">
            {groups.map((g) => (
              <div key={g.label} className="nav-menu-group">
                <div className="nav-menu-label">{g.label}</div>
                {g.items.map(([href, label]) => (
                  <Link key={href} href={href} role="menuitem" className="nav-menu-item" aria-current={isActive(path, href) ? "page" : undefined}>
                    <span>{label}</span>
                    {href === FEATURE_REQUESTS_HREF && <FeatureRequestNavBadge />}
                  </Link>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </nav>
  );
}
