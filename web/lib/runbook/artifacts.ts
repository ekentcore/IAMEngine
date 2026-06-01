// Typed non-step content carried by a runbook section (mirrors the generator IR's Artifact).
// Stored on RunbookSection.artifacts (Json) and rendered as blocks in the runbook view.

export type EmailArtifact = {
  type: "email";
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  fields?: string[];
};

export type AttachmentArtifact = {
  type: "attachment";
  href: string;
  sysId?: string | null;
  filename?: string;
};

export type Artifact = EmailArtifact | AttachmentArtifact;

export function asArtifacts(value: unknown): Artifact[] {
  return Array.isArray(value) ? (value as Artifact[]) : [];
}

export const isEmail = (a: Artifact): a is EmailArtifact => a.type === "email";
export const isAttachment = (a: Artifact): a is AttachmentArtifact => a.type === "attachment";
