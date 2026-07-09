"use client";

// Site-wide "Version 2" slider. Stores the choice in a cookie (read by middleware to route canonical
// pages to their /v2 variants) and navigates the current page to its v2/canonical counterpart so the
// switch takes effect immediately.
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { V2_COOKIE, V2_ROUTES, V2_CANONICAL } from "@/lib/v2";

export function V2Toggle({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const path = usePathname() ?? "";
  const [on, setOn] = useState(enabled);

  function toggle() {
    const next = !on;
    setOn(next);
    document.cookie = `${V2_COOKIE}=${next ? "on" : "off"}; path=/; max-age=31536000; samesite=lax`;
    // Jump the current page to its counterpart when it has one; otherwise just re-render.
    const target = next ? V2_ROUTES[path] : V2_CANONICAL[path];
    if (target && target !== path) router.push(target);
    router.refresh();
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={toggle}
      className="v2-switch"
      title={on ? "Version 2 is on — pages load their v2 versions site-wide" : "Turn on Version 2 — load the new versions of pages site-wide"}
    >
      <span className="v2-switch-text">Version 2</span>
      <span className={`v2-switch-track${on ? " on" : ""}`}><span className="v2-switch-thumb" /></span>
    </button>
  );
}
