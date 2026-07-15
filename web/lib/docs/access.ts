// Who may see and manage documents. A hard boundary, mirrored by the page loader (which hides the
// link) and the API routes (which re-check server-side) — never trust the hidden link alone.
//
//   client-facing docs  → engineer and above may view/download
//   internal docs        → global_admin and above (staff-only reference)
//   manage (AI update / publish / discard) → global_admin and above
//
// These take a plain Role; callers first check authEnabled() (when auth is off everything is
// allowed, exactly like the rest of the app).
import type { DocAudience, Role } from "@prisma/client";
import { ROLE_RANK } from "@/lib/auth/permissions";

// The lowest rank that may view a document of the given audience.
export function canViewAudience(role: Role, audience: DocAudience): boolean {
  const floor = audience === "internal" ? ROLE_RANK.global_admin : ROLE_RANK.engineer;
  return ROLE_RANK[role] >= floor;
}

// May the operator see the /docs area at all (i.e. view at least client-facing docs)?
export function canViewDocs(role: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK.engineer;
}

// May the operator run an AI update, publish a draft, or discard one?
export function canManageDocs(role: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK.global_admin;
}
