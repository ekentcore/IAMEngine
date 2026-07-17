// Page data for /connectors. Shared by the (single) connectors page.
import { listConnectors } from "@/lib/connectors/repository";

export type ConnectorRow = {
  id: string;
  key: string;
  name: string;
  kind: string;
  status: string;
  definition: unknown;
  secretNames: string[];
  notes: string | null;
  publishedAt: string | null;
  updatedAt: string;
};

export async function loadConnectors(): Promise<ConnectorRow[]> {
  const rows = await listConnectors();
  return rows.map((c) => ({
    id: c.id,
    key: c.key,
    name: c.name,
    kind: c.kind,
    status: c.status,
    definition: c.definition,
    secretNames: c.secretNames,
    notes: c.notes,
    publishedAt: c.publishedAt ? c.publishedAt.toISOString() : null,
    updatedAt: c.updatedAt.toISOString(),
  }));
}
