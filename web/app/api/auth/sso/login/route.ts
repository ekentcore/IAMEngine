// GET /api/auth/sso/login — begin the O365 sign-in: mint PKCE + state, stash them in a short-lived
// httpOnly cookie, and redirect to Entra's authorize endpoint. The redirect URI is derived from the
// request origin (must be registered in the Entra app).
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ssoConfig, newPkce, authorizeUrl, publicOrigin } from "@/lib/auth/sso";

export const dynamic = "force-dynamic";

export const SSO_COOKIE = "iam_sso";

export function GET(req: Request) {
  const cfg = ssoConfig();
  if (!cfg) return NextResponse.redirect(new URL("/login?error=sso_unconfigured", req.url));

  const redirectUri = `${publicOrigin(req)}/api/auth/sso/callback`;
  const { verifier, challenge, state } = newPkce();

  // state + verifier ride in a 10-minute httpOnly cookie (both base64url — no dots, so the "."
  // delimiter is safe). The redirect URI is NOT stored (it contains dots); the callback recomputes
  // it from publicOrigin, which is identical to here.
  cookies().set(SSO_COOKIE, `${state}.${verifier}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });

  return NextResponse.redirect(authorizeUrl(cfg, redirectUri, state, challenge));
}
