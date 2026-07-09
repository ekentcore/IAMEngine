// Strip secrets and obvious PII from any text before it is sent to an external LLM.
// Used as the single choke point for Azure OpenAI inputs (azureChatJson + group resolver).
// Secrets never leave the boundary; email domains are kept because they carry backbone signal.

export function redact(text: string): string {
  if (!text) return text;
  let t = text;
  // Delinea / Secret Server vault URLs (CoreSecret references)
  t = t.replace(/https?:\/\/\S*(?:secretservercloud|secretserver|delinea)\S*/gi, "[secret reference removed]");
  // explicit password values: "Password: hunter2" -> keep the label, drop the value.
  // The (?!\[) lookahead leaves an already-inserted [secret reference removed] placeholder alone.
  t = t.replace(/(\bpasswords?\b\s*[:=]\s*)((?!\[)[^\s,;]+)/gi, "$1[redacted]");
  // SSNs (before phones: same digit shapes shouldn't collide, but be explicit)
  t = t.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[ssn]");
  // US phone numbers
  t = t.replace(/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, "[phone]");
  // emails: keep the domain (identity-backbone signal), mask the local part — UNLESS the local part
  // is a naming-convention TEMPLATE (e.g. "FirstName.LastName", "Firstname.middleinitial",
  // "[FirstName].[LastName]", "{first}.{last}", "[user]"). Those are documentation, not PII, and the
  // runbook is unreadable if they're collapsed to "[user]". Real names ("felix.kessler") still mask.
  // The local-part class includes [ ] { } < > so bracketed/braced placeholders match (and are kept).
  t = t.replace(
    /(?<![\w.%+\-@])([A-Za-z0-9._%+\-[\]{}<>]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g,
    (_full, local: string, domain: string) => (/first|last|initial|middle|\buser\b|[[\]{}<>]/i.test(local) ? `${local}@${domain}` : `[user]@${domain}`)
  );
  return t;
}
