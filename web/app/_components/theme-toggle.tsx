"use client";

// Dark-mode slider. Applies the theme LIVE (sets data-theme on <html> — instant, no reload) and stores
// the choice in a cookie the server layout reads on the next load (so there's no light-mode flash).
import { useState } from "react";

export function ThemeToggle({ dark }: { dark: boolean }) {
  const [on, setOn] = useState(dark);

  function toggle() {
    const next = !on;
    setOn(next);
    document.documentElement.setAttribute("data-theme", next ? "dark" : "light");
    document.cookie = `theme=${next ? "dark" : "light"}; path=/; max-age=31536000; samesite=lax`;
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={toggle}
      className="v2-switch"
      title={on ? "Dark mode is on — click for light" : "Switch to dark mode"}
    >
      <span className="v2-switch-text" aria-hidden>{on ? "🌙" : "☀️"}</span>
      <span className={`v2-switch-track${on ? " on" : ""}`}><span className="v2-switch-thumb" /></span>
    </button>
  );
}
