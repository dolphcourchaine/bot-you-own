// ============================================================================
//  IDENTITY — TOTP, the six-digit codes from an authenticator app.
//
//  This is the same maths Google Authenticator, 1Password, Authy and the rest
//  all use (RFC 6238, built on RFC 4226): we and the app share one secret;
//  every 30 seconds both sides run HMAC-SHA1 over "which
//  30-second slot is it now", chop the result down to six digits, and the
//  person types what their app shows. If it matches, they hold the secret.
//
//  How the pieces fit:
//    newSecret()      → make a fresh secret (20 random bytes, shown as base32)
//    otpauthUri()     → the text that becomes the QR code the app scans
//    totp()           → what the code SHOULD be right now (used by tests & verify)
//    verifyTotp()     → check a typed code, allowing one slot either side so a
//                       phone whose clock is 30 s off still works
//
//  Nothing here talks to the network, and nothing depends on Node — it runs
//  in a Cloudflare Worker with only WebCrypto. Identity fails CLOSED: any
//  malformed input is a plain "no", never an exception the caller has to
//  interpret as a yes.
// ============================================================================

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";   // RFC 4648 base32

// Bytes → base32 text (no "=" padding — authenticator apps don't want it).
export function base32Encode(bytes) {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

// base32 text → bytes. Forgiving about case, spaces, dashes and padding
// (people copy secrets in all sorts of shapes); strict about anything else.
export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=\-]/g, "");
  const out = [];
  let bits = 0, value = 0;
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("not base32");
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

// A brand-new secret: 20 random bytes (the RFC's recommended size for SHA-1).
export function newSecret() {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return base32Encode(bytes);
}

// The code an authenticator app shows for this secret at this moment.
export async function totp(secretBase32, { time = Date.now(), step = 30, digits = 6 } = {}) {
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(time / 1000 / step);
  return hotp(secret, counter, digits);
}

// Check a typed code. Accepts the slot for "now" plus `window` slots either
// side. Returns { ok, offset } where offset says which slot matched (0 = now,
// -1 = the previous 30 s, +1 = the next) — handy for spotting drifting clocks.
export async function verifyTotp(secretBase32, code, { time = Date.now(), window = 1, step = 30, digits = 6 } = {}) {
  const typed = String(code ?? "").replace(/\s/g, "");
  if (!new RegExp(`^\\d{${digits}}$`).test(typed)) return { ok: false };
  let secret;
  try { secret = base32Decode(secretBase32); } catch { return { ok: false }; }
  const base = Math.floor(time / 1000 / step);
  // Every slot is checked, and every comparison is constant-time, so how long
  // this takes tells an attacker nothing about how close they were.
  let matched = null;
  for (let off = -window; off <= window; off++) {
    const expect = await hotp(secret, base + off, digits);
    if (constantTimeEqual(expect, typed) && matched === null) matched = off;
  }
  return matched === null ? { ok: false } : { ok: true, offset: matched };
}

// The text inside the QR code an authenticator app scans.
export function otpauthUri({ secret, label, issuer }) {
  const enc = encodeURIComponent;
  const who = issuer ? `${enc(issuer)}:${enc(label)}` : enc(label);
  const q = [`secret=${secret}`, issuer ? `issuer=${enc(issuer)}` : null, "algorithm=SHA1", "digits=6", "period=30"].filter(Boolean).join("&");
  return `otpauth://totp/${who}?${q}`;
}

// ---- the actual RFC 4226 step: HMAC-SHA1(secret, counter) → dynamic truncation → digits
async function hotp(secretBytes, counter, digits) {
  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new Uint8Array(8);
  // 8-byte big-endian counter. Counters fit in 2^53 so two 32-bit halves are enough.
  let hi = Math.floor(counter / 0x100000000), lo = counter >>> 0;
  for (let i = 7; i >= 4; i--) { msg[i] = lo & 255; lo = Math.floor(lo / 256); }
  for (let i = 3; i >= 0; i--) { msg[i] = hi & 255; hi = Math.floor(hi / 256); }
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  const num = bin % 10 ** digits;
  return String(num).padStart(digits, "0");
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
