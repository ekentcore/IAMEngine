// Strip secrets and obvious PII from any text before it is sent to an external LLM.
// Used as the single choke point for Azure OpenAI inputs (azureChatJson + group resolver).
// Secrets never leave the boundary; email domains are kept because they carry backbone signal.

// emails: the local part matters — a naming-convention TEMPLATE ("FirstName.LastName", "{first}.{last}",
// "[user]") is documentation, not PII, and must survive; anything else is masked.
// The local-part class includes [ ] { } < > so bracketed/braced placeholders match. A local part
// counts as a template only for template WORDS or a BALANCED bracket pair — a stray leading "<"
// from the common "Jane Doe <jane.doe@x.com>" form is a real address and must still mask.
const EMAIL_RE = /(?<![\w.%+\-@])([A-Za-z0-9._%+\-[\]{}<>]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
const TEMPLATE_WORD_RE = /first|last|initial|middle|\buser\b/i;
const BALANCED_BRACKET_RE = /\[[^\][]*\]|\{[^{}]*\}|<[^<>]*>/;
const isTemplateLocal = (local: string) => TEMPLATE_WORD_RE.test(local) || BALANCED_BRACKET_RE.test(local);

export function redact(text: string): string {
  if (!text) return text;
  let t = text;
  // Delinea / Secret Server vault URLs (CoreSecret references)
  t = t.replace(/https?:\/\/\S*(?:secretservercloud|secretserver|delinea)\S*/gi, "[secret reference removed]");
  // explicit password values: "Password: hunter2" -> keep the label, drop the value.
  // The (?!\[) lookahead leaves an already-inserted [secret reference removed] placeholder alone.
  // A lone bullet marker is NOT a value — "passwords:" followed by "- step…" on the next line is a
  // list of password steps, common in KBs. Everything else (including symbols-only values) redacts.
  t = t.replace(/(\bpasswords?\b\s*[:=]\s*)((?!\[)(?!(?:[-*•+>]|\d+[.)])(?:\s|$))[^\s,;]+)/gi, "$1[redacted]");
  // SSNs (before phones: same digit shapes shouldn't collide, but be explicit)
  t = t.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[ssn]");
  // US phone numbers
  t = t.replace(/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, "[phone]");
  // emails: keep the domain (identity-backbone signal), mask the local part — UNLESS the local part
  // is a naming-convention TEMPLATE (e.g. "FirstName.LastName", "Firstname.middleinitial",
  // "[FirstName].[LastName]", "{first}.{last}", "[user]"). Those are documentation, not PII, and the
  // runbook is unreadable if they're collapsed to "[user]". Real names ("felix.kessler") still mask.
  t = t.replace(EMAIL_RE, (_full, local: string, domain: string) =>
    isTemplateLocal(local) ? `${local}@${domain}` : `[user]@${domain}`
  );
  return t;
}

// Reversible email masking for LLM round-trips. redact()'s [user]@domain mask is lossy — fine for
// one-way inputs, but the runbook extractor ECHOES the text back as structured steps, and group /
// DL addresses ("DCG@dcg.co", "TeamDCG@dcg.co") are real configuration the steps must keep.
// Mask each distinct address as a unique bracketed placeholder before send (the model never sees
// the real local part), then restore() the addresses in the model's response. Placeholders are
// bracketed so a subsequent redact() pass leaves them alone (TEMPLATE_LOCAL_RE matches them).
export function maskEmailsReversible(text: string): { masked: string; restore: (s: string) => string } {
  const placeholders = new Map<string, string>(); // original email -> placeholder
  let n = 0;
  const masked = (text ?? "").replace(EMAIL_RE, (full, local: string, domain: string) => {
    if (isTemplateLocal(local)) return full; // templates stay readable as-is
    let p = placeholders.get(full);
    if (!p) {
      p = `[u${++n}]@${domain}`;
      placeholders.set(full, p);
    }
    return p;
  });
  const restore = (s: string) => {
    let out = s;
    for (const [email, p] of placeholders) out = out.split(p).join(email);
    return out;
  };
  return { masked, restore };
}
