"use client";

// The two clickable per-client flag badges next to the name — intake source (internal/external
// toggle) and the SUPER-ADMIN-ONLY restricted flag. Shared by ClientsTable (v1) and
// ClientsExplorer (v2); the caller supplies the PATCH plumbing via onPatch.
export function ClientFlagBadges({
  intakeSource,
  restricted,
  name,
  canRestrict,
  onPatch,
}: {
  intakeSource: string;
  restricted: boolean;
  name: string;
  canRestrict: boolean;
  onPatch: (action: string, payload: Record<string, unknown>) => void;
}) {
  return (
    <>
      <span
        className="badge"
        role="button"
        tabIndex={0}
        title="Intake source — internal scans onboarding incidents, external scans UM cases. Click to toggle."
        onClick={() => onPatch("set-intake-source", { intakeSource: intakeSource === "incident" ? "um" : "incident" })}
        style={{ cursor: "pointer", ...(intakeSource === "incident"
          ? { color: "var(--info-fg)", borderColor: "var(--info-bg)", background: "var(--info-bg)" }
          : { color: "var(--muted)", opacity: 0.65 }) }}
      >
        {intakeSource === "incident" ? "internal" : "external"}
      </span>
      {/* Restricted (internal-only) flag — SUPER ADMIN ONLY (the option is hidden from everyone
          else; the route enforces it server-side too). Restricting hides the client from every
          operator not granted it. */}
      {canRestrict && (
        <>
          {" "}
          <span
            className="badge"
            role="button"
            tabIndex={0}
            title={
              restricted
                ? "Restricted (internal-only): hidden from operators not granted it. Click to unrestrict."
                : "Click to restrict: hide this client from operators who haven't been granted it (grant per-user on the Users page)."
            }
            onClick={() => {
              if (!restricted && !confirm(`Restrict ${name}? It will be hidden from every operator (except super admins and those you grant it to on the Users page).`)) return;
              onPatch("set-restricted", { restricted: !restricted });
            }}
            style={{
              cursor: "pointer",
              ...(restricted
                ? { color: "var(--err-fg)", borderColor: "var(--err-bg)", background: "var(--err-bg)" }
                : { color: "var(--muted)", opacity: 0.5 }),
            }}
          >
            {restricted ? "🔒 restricted" : "🔓 restrict"}
          </span>
        </>
      )}
    </>
  );
}
