// RFC 6238 TOTP (time-based one-time password) — dependency-free, using only node:crypto. The
// authenticator SEED (base32, the same string an authenticator app is enrolled with) is stored on
// the Delinea secret; the browser flow generates the current 6-digit code on demand so a headless
// login can clear an app/TOTP second factor. Nothing here logs the seed or the code.
import { createHmac } from "node:crypto";

// Decode an RFC 4648 base32 string to bytes. Case-insensitive; ignores spaces and '=' padding, and
// skips any stray non-alphabet character (authenticator seeds are sometimes shown space-grouped).
export function base32Decode(s) {
  const ALPH = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = String(s ?? "").toUpperCase();
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = ALPH.indexOf(ch);
    if (idx === -1) continue; // spaces, '=', dashes, etc.
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { bits -= 8; out.push((value >>> bits) & 0xff); }
  }
  return Buffer.from(out);
}

// The current TOTP code for `seed`. `t` is a JS timestamp in ms (injectable for tests). SHA-1, 6
// digits, 30s step — the near-universal authenticator defaults.
export function totp(seed, { digits = 6, period = 30, t = Date.now() } = {}) {
  const key = base32Decode(seed);
  if (key.length === 0) throw new Error("empty or invalid base32 TOTP seed");
  let counter = Math.floor(t / 1000 / period);
  // 8-byte big-endian counter — build via modulo (not bit-shifts) so counters above 2^31 are exact.
  const buf = Buffer.alloc(8);
  for (let i = 7; i >= 0; i--) { buf[i] = counter % 256; counter = Math.floor(counter / 256); }
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(bin % 10 ** digits).padStart(digits, "0");
}
