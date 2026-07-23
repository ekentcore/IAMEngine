"use client";

// Site-wide version slider (v2 ⇄ v3). v1 is retired, so this only ever chooses between v2 and v3.
// Stores the choice in the `site_version` cookie (read by middleware to route pages to their /v2 or
// /v3 variant) and jumps the current page to its counterpart so the switch takes effect immediately.
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { SITE_VERSION_COOKIE, counterpartPath, type SiteVersion } from "@/lib/v2";

export function VersionToggle({ version }: { version: SiteVersion }) {
  const router = useRouter();
  const path = usePathname() ?? "";
  const [v, setV] = useState<SiteVersion>(version);
  const on = v === "v3";

  function toggle() {
    const next: SiteVersion = on ? "v2" : "v3";
    setV(next);
    document.cookie = `${SITE_VERSION_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    // Jump the current page to its counterpart for the new version when it has one; otherwise just
    // re-render (a page with no v3 stays put and keeps serving v2).
    const target = counterpartPath(path, next);
    if (target) router.push(target);
    router.refresh();
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={toggle}
      className="v2-switch"
      title={on ? "Version 3 is on — pages load their v3 versions site-wide" : "Turn on Version 3 — load the new versions of pages site-wide"}
    >
      <span className="v2-switch-text">{on ? "Version 3" : "Version 2"}</span>
      <span className={`v2-switch-track${on ? " on" : ""}`}><span className="v2-switch-thumb" /></span>
    </button>
  );
}
