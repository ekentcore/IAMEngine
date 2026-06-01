// Build a downloadable RFC-822 .eml from an email artifact. Recipient/field values are the
// KB template's placeholders now; a pulled UM case fills them later. Name-only CC entries
// (people named in the KB with no address) are surfaced in the body as a manual-CC reminder.
import type { EmailArtifact } from "./artifacts";

const isAddr = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

export function buildEml(email: EmailArtifact, opts?: { from?: string }): string {
  const to = (email.to ?? []).filter(isAddr);
  const ccAddrs = (email.cc ?? []).filter(isAddr);
  const ccNames = (email.cc ?? []).filter((c) => !isAddr(c));

  const headers = [
    opts?.from ? `From: ${opts.from}` : null,
    `To: ${to.join(", ")}`,
    ccAddrs.length ? `Cc: ${ccAddrs.join(", ")}` : null,
    `Subject: ${email.subject ?? ""}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
  ].filter(Boolean) as string[];

  let body = email.body ?? "";
  if (ccNames.length) body = `[Also CC (no address in KB): ${ccNames.join(", ")}]\n\n${body}`;

  // RFC-822 wants CRLF; normalize the body's LF to CRLF too.
  return headers.join("\r\n") + "\r\n\r\n" + body.replace(/\r?\n/g, "\r\n");
}

export function emlFilename(slug: string, email: EmailArtifact): string {
  const subj = (email.subject || "email")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "email";
  return `${slug}-${subj}.eml`;
}
