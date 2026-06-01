// Clients index. Lists seeded clients; each links to its runbook detail page.
import Link from "next/link";
import { getClients } from "@/lib/clients/repository";

export const dynamic = "force-dynamic";

export default async function ClientsPage() {
  const clients = await getClients();
  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif", maxWidth: 900 }}>
      <h1>Clients</h1>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
            <th style={th}>Name</th>
            <th style={th}>Primary domain</th>
            <th style={th}>Backbone</th>
            <th style={th}>Status</th>
          </tr>
        </thead>
        <tbody>
          {clients.map((c) => (
            <tr key={c.id} style={{ borderBottom: "1px solid #eee" }}>
              <td style={td}>
                <Link href={`/clients/${c.slug}`}>{c.name}</Link>
              </td>
              <td style={td}>{c.primaryDomain}</td>
              <td style={td}>{c.backbone}</td>
              <td style={td}>{c.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {clients.length === 0 && (
        <p style={{ color: "#666" }}>No clients seeded yet. Run npm run db:seed.</p>
      )}
    </main>
  );
}

const th: React.CSSProperties = { padding: ".4rem .5rem", fontWeight: 600 };
const td: React.CSSProperties = { padding: ".4rem .5rem" };
