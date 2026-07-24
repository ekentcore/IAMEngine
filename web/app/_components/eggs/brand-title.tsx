"use client";

// The header brand link, with a secret: 7 clicks within 3 seconds spins it once and renames the
// app "Evan's IAM Engine" until the next full navigation. Still a working link to /clients.
import { useRef, useState } from "react";
import Link from "next/link";

export function BrandTitle() {
  const clicks = useRef<number[]>([]);
  const [egg, setEgg] = useState(false);

  function onClick() {
    const now = performance.now();
    clicks.current = [...clicks.current.filter((t) => now - t < 3000), now];
    if (clicks.current.length >= 7) {
      clicks.current = [];
      setEgg(true);
    }
  }

  return (
    <Link href="/clients" className="brand" onClick={onClick}>
      <span className={egg ? "egg-spin" : undefined}>{egg ? "Evan's IAM Engine" : "iam-engine"}</span>
    </Link>
  );
}
