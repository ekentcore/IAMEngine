// Sign-in screen. Server component: shows the local form, a Microsoft 365 SSO button (when
// configured), and any callback error in a friendly form.
import { ssoEnabled } from "@/lib/auth/sso";
import { LoginForm } from "./_components/login-form";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  sso_unconfigured: "Microsoft 365 sign-in isn't configured yet.",
  sso_denied: "Microsoft sign-in was cancelled or denied.",
  sso_bad_request: "The sign-in response was incomplete — try again.",
  sso_state: "The sign-in session expired — please try again.",
  sso_exchange: "Couldn't complete sign-in with Microsoft. Try again.",
  sso_not_provisioned: "Your Microsoft account isn't authorized for iam-engine yet — ask an admin to add you.",
};

export default function LoginPage({ searchParams }: { searchParams: { error?: string } }) {
  const sso = ssoEnabled();
  const errorText = searchParams.error ? ERRORS[searchParams.error] ?? "Sign-in failed." : null;

  return (
    <main style={{ maxWidth: 380, marginTop: "8vh" }}>
      <h1 style={{ marginBottom: "0.25rem" }}>Sign in</h1>
      <p className="note" style={{ marginTop: 0 }}>iam-engine — IAM lifecycle automation</p>

      {errorText && (
        <p className="note" style={{ color: "#b91c1c", border: "1px solid #fca5a5", background: "#fef2f2", borderRadius: 8, padding: "0.5rem 0.7rem", marginTop: "1rem" }}>{errorText}</p>
      )}

      {sso && (
        <>
          <a href="/api/auth/sso/login" className="button" style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 8, width: "100%", marginTop: "1.25rem", padding: "0.55rem", border: "1px solid var(--line-2)", borderRadius: 8, textDecoration: "none", fontWeight: 500, background: "var(--bg)" }}>
            <span aria-hidden style={{ display: "inline-grid", gridTemplateColumns: "8px 8px", gap: 1 }}>
              <span style={{ width: 8, height: 8, background: "#f25022" }} /><span style={{ width: 8, height: 8, background: "#7fba00" }} />
              <span style={{ width: 8, height: 8, background: "#00a4ef" }} /><span style={{ width: 8, height: 8, background: "#ffb900" }} />
            </span>
            Sign in with Microsoft 365
          </a>
          <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "1.1rem 0 0.6rem", color: "var(--faint)", fontSize: 12 }}>
            <span style={{ flex: 1, height: 1, background: "var(--line)" }} /> or <span style={{ flex: 1, height: 1, background: "var(--line)" }} />
          </div>
        </>
      )}

      <div style={{ marginTop: sso ? 0 : "1.25rem" }}>
        <LoginForm />
      </div>

      <p className="note" style={{ marginTop: "1.25rem", color: "var(--faint)" }}>
        {sso ? "Local accounts are for admin control and break-glass access." : "Microsoft 365 single sign-on can be enabled by an admin. Local accounts are for admin control and break-glass access."}
      </p>
    </main>
  );
}
