"use server";
// Server action backing the self-service EXO certificate generator on the cloud-auth help page.
// Generates a fresh self-signed cert + .pfx in memory and returns the artifacts; nothing is stored.
import { requireUser, AuthError } from "@/lib/auth/guard";
import { generateExoCert, type ExoCertResult } from "@/lib/m365/exo-cert";

export async function generateExoCertAction(
  input: { password: string; commonName?: string; days?: number }
): Promise<{ ok: true; cert: ExoCertResult } | { ok: false; error: string }> {
  try {
    await requireUser(); // any signed-in operator may generate a throwaway cert
    const cert = await generateExoCert(input);
    return { ok: true, cert };
  } catch (e) {
    return { ok: false, error: e instanceof AuthError ? e.message : e instanceof Error ? e.message : "failed to generate certificate" };
  }
}
