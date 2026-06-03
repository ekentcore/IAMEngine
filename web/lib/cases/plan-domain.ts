// Wire the pure email-domain resolver (lib/clients/email-domain) to real ServiceNow contacts and
// the DB cache. Built once per request and handed to the planning paths so they can resolve the
// right UPN domain without each knowing about ServiceNow.
import type { PrismaClient } from "@prisma/client";
import { snConfigFromEnv, fetchAccountContactEmails } from "../servicenow/gateway";
import { makeClientRepository } from "../clients/repository";
import { resolveEmailDomain, type ResolveClient, type ResolveResult } from "../clients/email-domain";

export type EmailDomainResolver = (client: ResolveClient, override?: string | null) => Promise<ResolveResult>;

export function makeEmailDomainResolver(db: PrismaClient): EmailDomainResolver {
  const repo = makeClientRepository(db);
  const config = snConfigFromEnv();
  return (client, override) =>
    resolveEmailDomain(
      {
        fetchContactEmails: (sysId) => fetchAccountContactEmails(config, sysId),
        setEmailDomain: (id, d) => repo.setEmailDomain(id, d),
      },
      { client, override }
    );
}
