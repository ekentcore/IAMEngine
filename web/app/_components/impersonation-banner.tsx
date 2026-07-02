"use client";

// Persistent strip shown while a super-admin is impersonating (viewing as another user). Makes the
// state obvious and offers a one-click exit. Read-only is enforced server-side (mutations 403 while
// impersonating); this just surfaces it.
export function ImpersonationBanner({ name, role }: { name: string; role: string }) {
  return (
    <div style={{ background: "#7c2d12", color: "#fff", padding: "0.5rem 1rem", display: "flex", alignItems: "center", justifyContent: "center", gap: 14, fontSize: 13 }}>
      <span>
        👁 Viewing as <strong>{name}</strong> ({role}) — read-only. You&rsquo;re seeing exactly what they see.
      </span>
      <button
        type="button"
        style={{ fontSize: 12, padding: "0.25rem 0.75rem", background: "#fff", color: "#7c2d12", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}
        onClick={async () => {
          await fetch("/api/impersonate", { method: "DELETE" });
          window.location.href = "/clients";
        }}
      >
        Exit impersonation
      </button>
    </div>
  );
}
