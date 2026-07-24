"use client";

// One styled console.log per page load — a signature for whoever opens dev tools.
import { useEffect } from "react";

let printed = false;

export function ConsoleSignature() {
  useEffect(() => {
    if (printed) return;
    printed = true;
    // eslint-disable-next-line no-console
    console.log(
      "%c  iam-engine  %c\n\nCrafted by Evan Kent · 2026.\nDebugging? Check /docs first.\n",
      "background:#1e293b;color:#f59e0b;font-size:16px;font-weight:bold;padding:4px 8px;border-radius:4px",
      ""
    );
  }, []);
  return null;
}
