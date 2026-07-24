"use client";

// Jan 1-2: one confetti burst per user per year (localStorage-guarded). Rendered only when the
// layout's occasion state says the new-year window is active.
import { useEffect, useState } from "react";
import { fireConfetti } from "./confetti";
import { EggToast } from "./egg-toast";

export function NewYearEgg({ year }: { year: string }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const key = `iam-eggs-newyear-${year}`;
    try {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, "1");
    } catch {
      return; // storage unavailable -> skip rather than fire on every load
    }
    fireConfetti();
    setShow(true);
  }, [year]);

  if (!show) return null;
  return <EggToast message={`Happy New Year from IAM Engine 🎆 (${year})`} onDone={() => setShow(false)} />;
}
