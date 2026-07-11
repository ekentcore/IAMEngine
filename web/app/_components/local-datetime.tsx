"use client";

// Render an ISO timestamp in the VIEWER's timezone (not the server's). Server components that print
// a scheduled/absolute time should use this instead of a server-side toLocaleString, which formats
// in the server process's zone and shows the wrong wall-clock on a UTC/container deployment.
import { formatDateTime } from "@/lib/dates";

export function LocalDateTime({ iso }: { iso: string }) {
  // suppressHydrationWarning: the server renders in its zone, the client re-renders in the viewer's;
  // the client value is the correct one.
  return <span suppressHydrationWarning>{formatDateTime(iso)}</span>;
}
