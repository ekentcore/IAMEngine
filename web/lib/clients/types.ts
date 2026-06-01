import type { Prisma, Mode } from "@prisma/client";

// getClientBySlug payload: a client with its systems (joined to the catalog for
// the display name) and secrets.
export type ClientDetail = Prisma.ClientGetPayload<{
  include: { systems: { include: { system: true } }; secrets: true };
}>;

export type ClientSystemWithCatalog = ClientDetail["systems"][number];

// The profile identity block (stored on Client.identity as JSON).
export type Identity = {
  backbone: string;
  usernamePatterns: string[];
  password?: {
    mode?: string;
    minLength?: number;
    requireChangeAtSignIn?: boolean;
    onOffboard?: string;
  };
  directorySync?: { host?: string; command?: string };
};

// One runbook row, serialized for the client component.
export type RunbookItem = {
  seq: number;
  stepNumber: number;
  systemKey: string;
  systemName: string;
  mode: Mode;
  automated: boolean;
  when: "always" | "on_request";
  dependsOn: string[]; // in-action system keys, for the "after: …" badge
  steps: string[]; // human-readable summary of the lane config
  codePreview: string | null; // filled server-side for automated systems with a previewer
};

// A KB article reference for an action, with its resolved link (null if no
// SN_INSTANCE_URL or no number).
export type KbRef = { number: string; url: string | null };
