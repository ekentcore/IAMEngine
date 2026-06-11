// GET /api/auth/sso/callback — Entra returns here with ?code&state. Verify state, exchange the code
// for an id_token, resolve the operator (DENY-BY-DEFAULT: the email must already be an active user —
// an admin pre-provisions them in /users), link the Entra oid on first sign-in, open a session.
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { ssoConfig, exchangeCode, identityFromIdToken, publicOrigin } from "@/lib/auth/sso";
import { createSession } from "@/lib/auth/session";
import { recordAudit } from "@/lib/auth/audit";
import { SSO_COOKIE } from "../login/route";

export const dynamic = "force-dynamic";

function back(req: Request, error: string) {
  return NextResponse.redirect(new URL(`/login?error=${error}`, publicOrigin(req)));
}

export async function GET(req: Request) {
  const cfg = ssoConfig();
  if (!cfg) return back(req, "sso_unconfigured");

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (url.searchParams.get("error")) return back(req, "sso_denied");
  if (!code || !state) return back(req, "sso_bad_request");

  const jar = cookies();
  const raw = jar.get(SSO_COOKIE)?.value ?? "";
  jar.delete(SSO_COOKIE);
  const [cookieState, verifier, redirectEnc] = raw.split(".");
  if (!cookieState || !verifier || cookieState !== state) return back(req, "sso_state");
  const redirectUri = decodeURIComponent(redirectEnc ?? "");

  let identity;
  try {
    const idToken = await exchangeCode(cfg, code, redirectUri, verifier);
    identity = identityFromIdToken(cfg, idToken);
  } catch (e) {
    await recordAudit("auth.sso.error", { actor: "auth", detail: { message: (e as Error).message } });
    return back(req, "sso_exchange");
  }

  // Deny-by-default: match an active user by linked oid, else by email. Unknown identities are
  // rejected (no silent provisioning — an admin invites them first in /users).
  const user =
    (await db.user.findUnique({ where: { entraOid: identity.oid } })) ??
    (await db.user.findUnique({ where: { email: identity.email } }));
  if (!user || user.status !== "active") {
    await recordAudit("auth.sso.denied", { actor: "auth", detail: { email: identity.email } });
    return back(req, "sso_not_provisioned");
  }

  // First SSO sign-in for this user — link the oid and widen authType so the account keeps any
  // local password too (a local-only user becomes "both").
  await db.user.update({
    where: { id: user.id },
    data: {
      entraOid: identity.oid,
      name: user.name ?? identity.name,
      authType: user.authType === "local" ? "both" : user.authType === "sso" ? "sso" : "both",
      lastLoginAt: new Date(),
    },
  });
  await createSession(user.id, { ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null, userAgent: req.headers.get("user-agent") });
  await recordAudit("auth.login.sso", { user: { ...user }, detail: { email: identity.email } });

  return NextResponse.redirect(new URL("/clients", publicOrigin(req)));
}
