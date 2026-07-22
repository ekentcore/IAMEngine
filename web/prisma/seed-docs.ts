// Seed the four IAM Engine reference documents as v1.0 published versions. Idempotent: the Document
// row is upserted (title/audience/summary kept current), but a version is only created when the
// document has NONE yet — so re-seeding never clobbers an AI update or a hand edit.
//
// Source Markdown lives beside this file in ./seed-docs/*.md (converted from the original Word docs
// in data/docs.zip). Run as part of `prisma db seed`, or standalone: `ts-node prisma/seed-docs.ts`.
import { PrismaClient, type DocAudience } from "@prisma/client";
import { readFileSync } from "fs";
import { join } from "path";

type DocSeed = { slug: string; title: string; audience: DocAudience; summary: string; sortOrder: number };

// Order = the order they read as a set: the client overview first, then the setup guide and security
// design it references, then the internal reference.
const DOCS: DocSeed[] = [
  { slug: "client-overview", title: "IAM Engine — Client Overview", audience: "client", sortOrder: 10, summary: "What the platform does, how a request becomes executed steps, and what a client configures. Prepared for client review." },
  { slug: "setup-and-configuration", title: "IAM Engine — Setup and Configuration Guide", audience: "client", sortOrder: 20, summary: "Exact permissions and setup steps, system by system. The technical companion to the client overview." },
  { slug: "security-design", title: "IAM Engine — Security Design", audience: "client", sortOrder: 30, summary: "How the platform is secured and why each decision was made. For a client's security review." },
  { slug: "internal-reference", title: "IAM Engine — Internal Reference", audience: "internal", sortOrder: 40, summary: "The internal counterpart to the client docs: implementation, deployment status, and the unshipped security roadmap. Coretelligent staff only." },
];

const SEED_VERSION = "2.0";
const SEED_DATE = new Date("2026-07-22T00:00:00.000Z"); // the "Version 2.0 · 22 July 2026" the docs carry

export async function seedDocuments(prisma: PrismaClient): Promise<void> {
  let created = 0;
  let seeded = 0;
  for (const d of DOCS) {
    const markdown = readFileSync(join(__dirname, "seed-docs", `${d.slug}.md`), "utf8");
    const doc = await prisma.document.upsert({
      where: { slug: d.slug },
      update: { title: d.title, audience: d.audience, summary: d.summary, sortOrder: d.sortOrder },
      create: { slug: d.slug, title: d.title, audience: d.audience, summary: d.summary, sortOrder: d.sortOrder },
      include: { versions: true },
    });
    if (doc.versions.length === 0) {
      await prisma.documentVersion.create({
        data: {
          documentId: doc.id,
          version: SEED_VERSION,
          status: "published",
          markdown,
          changeNote: "Baseline (v2.0 edition).",
          generatedByAi: false,
          createdByLabel: "Seed",
          publishedAt: SEED_DATE,
          createdAt: SEED_DATE,
        },
      });
      seeded++;
    }
    created++;
  }
  console.log(`documents: ${created} upserted, ${seeded} seeded at v${SEED_VERSION}`);
}

// Standalone runner (so docs can be seeded without the full client seed).
if (require.main === module) {
  const prisma = new PrismaClient();
  seedDocuments(prisma)
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
}
