"use client";

// Header identity chip: who's signed in + role, with account + sign-out actions.
import Link from "next/link";
import { ROLE_LABELS } from "@/lib/auth/permissions";
import type { Role } from "@prisma/client";

export function UserMenu({ email, name, role }: { email: string; name: string | null; role: Role }) {
  return (
    <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.6rem" }}>
      <Link href="/account" className="nav-link" style={{ textAlign: "right", lineHeight: 1.2 }} title="Account & password">
        <div style={{ fontSize: 13, fontWeight: 600 }}>{name || email}</div>
        <div className="note" style={{ fontSize: 11 }}>{ROLE_LABELS[role] ?? role}</div>
      </Link>
      <button
        title="Sign out"
        style={{ fontSize: 12, padding: "0.3rem 0.6rem" }}
        onClick={async () => {
          await fetch("/api/auth/logout", { method: "POST" });
          window.location.href = "/login";
        }}
      >
        Sign out
      </button>
    </div>
  );
}
