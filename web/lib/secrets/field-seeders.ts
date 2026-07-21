// Field seeders: an optional "upload a file instead of typing" affordance on the guided create
// form (CreateInDelineaForm). Keyed by secret name — a secret with a seeder gets a file input
// above its fields; picking a file parses it LOCALLY (never uploaded anywhere) and fills the
// matching field values, exactly as if the operator had typed them. Built for google-admin, whose
// ClientSecret field wants the base64 of a downloaded JSON key file — a conversion operators on a
// locked-down Windows machine have no terminal to run.
//
// Extensible: add an entry for any secret whose credential arrives as a downloadable file. Parsers
// are pure (fileText in, field values out; throw with an operator-readable message) so they unit-
// test without a browser; the file read + input wiring live in the form component.

export type SeededFields = {
  // Keyed by the field REQUIREMENT LABEL (FieldReq.label) — the same key the form's typed inputs
  // use — so seeded and typed values merge into one `values` state and one create request.
  values: Record<string, string>;
  note: string; // shown under the file input on success, e.g. which service account was read
};

export type FieldSeeder = {
  prompt: string; // the file-input line, e.g. "Or upload the downloaded JSON key file — …"
  accept: string; // the <input type="file"> accept attribute
  fills: string[]; // the requirement labels parse() emits (the form flags these as seeded)
  parse: (fileText: string) => SeededFields; // throws Error with an operator-readable message
};

// UTF-8-safe base64 of a text file's contents. btoa alone chokes on any non-latin1 character, so
// encode to UTF-8 bytes first; chunked fromCharCode keeps the argument list under engine limits.
// (Node ≥ 18 has global btoa too, so the same path runs in tests and in the browser.)
export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// Parse a downloaded Google service-account key file. Validates it's really a service-account key
// (not an OAuth-client or some other Cloud Console download) before seeding, so the operator hears
// "wrong file" here instead of a token-exchange failure at Test time. Field labels must stay in
// lockstep with field-requirements.ts's "google-admin" entry.
export function parseGoogleServiceAccountKey(fileText: string): SeededFields {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileText);
  } catch {
    throw new Error("that file isn't JSON — upload the .json key file downloaded from the service account's Keys tab");
  }
  const key = parsed as { type?: unknown; client_email?: unknown; private_key?: unknown };
  if (key.type !== "service_account") {
    throw new Error(
      "that JSON isn't a service-account key (its \"type\" isn't \"service_account\") — an OAuth client download looks similar; use the key from the service account's Keys → Add key → JSON"
    );
  }
  const clientEmail = typeof key.client_email === "string" ? key.client_email : "";
  if (!clientEmail || typeof key.private_key !== "string" || !key.private_key.trim()) {
    throw new Error("that service-account key is missing client_email or private_key — re-download a fresh JSON key");
  }
  return {
    values: { ClientSecret: utf8ToBase64(fileText), accountid: clientEmail },
    note: `read key for ${clientEmail} — ClientSecret (base64) and accountid are filled in`,
  };
}

export const FIELD_SEEDERS: Record<string, FieldSeeder> = {
  "google-admin": {
    prompt: "Or upload the downloaded JSON key file — it's converted to base64 in your browser (never uploaded) and fills ClientSecret + accountid:",
    accept: ".json,application/json",
    fills: ["ClientSecret", "accountid"],
    parse: parseGoogleServiceAccountKey,
  },
};
