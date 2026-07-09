// Password hashing with Node's built-in scrypt — a strong, memory-hard KDF, zero external deps.
// Stored form: "scrypt$<saltB64>$<hashB64>". Verify is constant-time.
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  let actual: Buffer;
  try {
    actual = scryptSync(password, Buffer.from(saltB64, "base64"), expected.length);
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// A readable, reasonably strong generated password for bootstrap / reset (printed once).
export function generatePassword(): string {
  // base64url of 15 bytes ≈ 20 chars, URL/console-safe, no ambiguity.
  return randomBytes(15).toString("base64url");
}
