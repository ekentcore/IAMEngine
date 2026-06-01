import { prisma } from "@/lib/prisma";
import type { ClientDetail } from "@/lib/clients/types";

// The clients list — minimal columns for the index table.
export function getClients() {
  return prisma.client.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true,
      slug: true,
      name: true,
      primaryDomain: true,
      backbone: true,
      status: true,
    },
  });
}

export type ClientListItem = Awaited<ReturnType<typeof getClients>>[number];

// Full client for the detail page: systems joined to the catalog (display name),
// plus secrets. Returns null when the slug is unknown.
export function getClientBySlug(slug: string): Promise<ClientDetail | null> {
  return prisma.client.findUnique({
    where: { slug },
    include: { systems: { include: { system: true } }, secrets: true },
  });
}
