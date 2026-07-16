"use client";

// "Who needs this permission?" — the question the per-client connection test cannot answer.
// One row per missing permission, expandable to the clients that need it, with the grant command.
import { useState } from "react";
import type { PermissionPivot } from "@/lib/audits/m365-audit";

function grantCommand(role: string, roleId: string | undefined, resourceAppId: string): string | null {
  if (!roleId) return null;
  return [
    `$sp    = Get-MgServicePrincipal -Filter "appId eq '<the client's app id>'"`,
    `$graph = Get-MgServicePrincipal -Filter "appId eq '${resourceAppId}'"`,
    `New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id \``,
    `  -PrincipalId $sp.Id -ResourceId $graph.Id -AppRoleId ${roleId}`,
  ].join("\n");
}

export function PermissionPivotTable({
  pivot,
  roleIds,
  resourceAppId,
}: {
  pivot: PermissionPivot[];
  roleIds: Record<string, string>;
  resourceAppId: string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  if (!pivot.length) return <p className="note">Every client covered — no missing permissions.</p>;

  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 4 }}>
      {pivot.map((p) => {
        const isOpen = open === p.role;
        const cmd = grantCommand(p.role, roleIds[p.role], resourceAppId);
        return (
          <div key={p.role} style={{ borderTop: "1px solid #f3f4f6" }}>
            <button
              onClick={() => setOpen(isOpen ? null : p.role)}
              style={{ display: "flex", width: "100%", alignItems: "center", gap: 10, padding: "8px 12px", background: "none", border: "none", textAlign: "left", cursor: "pointer" }}
            >
              <span style={{ color: p.optional ? "#b45309" : "#b91c1c", width: 14 }}>{p.optional ? "○" : "✗"}</span>
              <code style={{ flex: 1, fontSize: 13 }}>{p.role}</code>
              {/* An optional permission missing is a note, never a failure — same rule as the
                  connection-test panel, so the two never contradict each other. */}
              {p.optional && <span className="muted" style={{ fontSize: 11 }}>(optional)</span>}
              <span style={{ fontSize: 12 }}>
                {p.clients.length} client{p.clients.length === 1 ? "" : "s"} missing
              </span>
              <span className="muted" style={{ fontSize: 11 }}>{isOpen ? "▴" : "▾"}</span>
            </button>
            {isOpen && (
              <div style={{ padding: "0 12px 12px 36px" }}>
                <div style={{ fontSize: 12, marginBottom: 8 }}>
                  {p.clients.map((c) => (
                    <a key={c.slug} href={`/clients/${c.slug}`} style={{ marginRight: 10 }} title={c.client}>
                      {c.slug}
                    </a>
                  ))}
                </div>
                {cmd ? (
                  <>
                    <pre style={{ fontSize: 11, background: "#f9fafb", padding: 8, borderRadius: 3, overflowX: "auto", margin: 0 }}>{cmd}</pre>
                    <button
                      style={{ marginTop: 6, fontSize: 11 }}
                      onClick={() => { void navigator.clipboard.writeText(cmd); setCopied(p.role); setTimeout(() => setCopied(null), 1500); }}
                    >
                      {copied === p.role ? "copied" : "copy grant command"}
                    </button>
                  </>
                ) : (
                  <p className="note" style={{ fontSize: 12, margin: 0 }}>
                    Grant in Entra: App registrations → the app → API permissions → Add a permission → Microsoft Graph →
                    Application permissions → tick <code>{p.role}</code> → Add → Grant admin consent.
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
