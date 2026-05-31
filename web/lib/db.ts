// Shared PrismaClient singleton. Next.js dev hot-reload re-imports modules, which would
// otherwise open a new connection pool on every change — reuse one client via globalThis.
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
