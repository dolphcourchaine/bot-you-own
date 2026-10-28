// ============================================================================
//  IDENTITY — Passkeys (WebAuthn), the "use your fingerprint / Face ID" login.
//
//  A passkey is a key pair the person's phone or laptop makes and keeps. We
//  only ever see the PUBLIC half. Two moments matter:
//
//    REGISTRATION  — the browser hands us a new public key. We check it was
//                    made for OUR site, in answer to OUR one-time challenge,
//                    and store the key. (verifyRegistration)
//    ASSERTION     — later, the browser hands us a signature made with the
//                    private half. We check it against the stored public key,
//                    again for our site and our fresh challenge. (verifyAssertion)
//
//  What we deliberately do NOT do: check the "attestation statement", the
//  optional certificate chain that says which brand of authenticator made the
//  key. Browsers send format "none" by default and it proves nothing about the
//  person anyway. We trust the public key we were handed at registration and
//  nothing else — the same rule whether the format says "none", "packed" or
//  anything else. The attestation statement is parsed past and ignored.
//
//  Everything is bytes-in, decision-out: CBOR (the compact format WebAuthn
//  uses) is decoded by the small decoder below, keys are turned into WebCrypto
//  keys, and signatures are checked by crypto.subtle. No Node, no npm.
//  Identity fails CLOSED: every check returns { ok:false, reason } on doubt.
// ============================================================================

// ---------------------------------------------------------------------------
//  base64url ↔ bytes (the browser gives us base64url strings)
// ---------------------------------------------------------------------------
export function b64uToBytes(str) {
  let s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64u(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// A fresh challenge: 32 random bytes as base64url. Issue one per attempt,
// remember it server-side, and it can only ever be answered once.
export function randomChallenge() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToB64u(bytes);
}

// ---------------------------------------------------------------------------
//  CBOR — a compact binary cousin of JSON. Just enough of it for WebAuthn:
//  integers, byte strings, text, arrays, maps, true/false/null, floats.
//  Indefinite-length items (rare, never sent by authenticators) throw.
// ---------------------------------------------------------------------------
export function decodeCbor(bytes) {
  return decodeCborFirst(bytes).value;
}

// Decodes ONE item and hands back what follows it — the COSE public key inside
// authenticator data may be followed by extension bytes we need to skip.
export function decodeCborFirst(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;

  const need = (n) => { if (pos + n > bytes.length) throw new Error("cbor: truncated"); };
  const readLength = (info) => {
    if (info < 24) return info;
    if (info === 24) { need(1); return bytes[pos++]; }
    if (info === 25) { need(2); const v = view.getUint16(pos); pos += 2; return v; }
    if (info === 26) { need(4); const v = view.getUint32(pos); pos += 4; return v; }
    if (info === 27) {
      need(8);
      const v = view.getBigUint64(pos); pos += 8;
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("cbor: integer too large");
      return Number(v);
    }
    throw new Error("cbor: indefinite length not supported");
  };

  const item = () => {
    need(1);
    const first = bytes[pos++];
    const major = first >> 5, info = first & 31;
    switch (major) {
      case 0: return readLength(info);                       // unsigned int
      case 1: return -1 - readLength(info);                  // negative int
      case 2: { const n = readLength(info); need(n); const v = bytes.slice(pos, pos + n); pos += n; return v; }
      case 3: { const n = readLength(info); need(n); const v = new TextDecoder().decode(bytes.subarray(pos, pos + n)); pos += n; return v; }
      case 4: { const n = readLength(info); const arr = []; for (let i = 0; i < n; i++) arr.push(item()); return arr; }
      case 5: { const n = readLength(info); const m = new Map(); for (let i = 0; i < n; i++) { const k = item(); m.set(k, item()); } return m; }
      case 6: { readLength(info); return item(); }           // a tag: ignore it, keep the value
      case 7:
        switch (info) {
          case 20: return false;
          case 21: return true;
          case 22: return null;
          case 23: return undefined;
          case 24: need(1); return bytes[pos++];             // "simple value" — pass it through as a number
          case 25: { need(2); const v = half(view.getUint16(pos)); pos += 2; return v; }
          case 26: { need(4); const v = view.getFloat32(pos); pos += 4; return v; }
          case 27: { need(8); const v = view.getFloat64(pos); pos += 8; return v; }
          default: throw new Error("cbor: unsupported simple value");
        }
      default: throw new Error("cbor: bad major type");
    }
  };

  const value = item();
  return { value, rest: bytes.slice(pos) };
}

// 16-bit float → number (IEEE 754 half precision).
function half(h) {
  const sign = h & 0x8000 ? -1 : 1, exp = (h >> 10) & 0x1f, frac = h & 0x3ff;
  if (exp === 0) return sign * frac * 2 ** -24;
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * (1 + frac / 1024) * 2 ** (exp - 15);
}

// ---------------------------------------------------------------------------
//  Authenticator data — the fixed-layout block every WebAuthn response carries:
//    rpIdHash (32)  flags (1)  counter (4, big-endian)
//    then, only when the AT flag is set: aaguid (16), credIdLen (2), credId, COSE key
// ---------------------------------------------------------------------------
export function parseAuthenticatorData(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 37) throw new Error("authData too short");
  const rpIdHash = bytes.slice(0, 32);
  const raw = bytes[32];
  const flags = { up: !!(raw & 0x01), uv: !!(raw & 0x04), at: !!(raw & 0x40), ed: !!(raw & 0x80), raw };
  const counter = ((bytes[33] << 24) >>> 0) + (bytes[34] << 16) + (bytes[35] << 8) + bytes[36];
  const out = { rpIdHash, flags, counter };
  if (flags.at) {
    if (bytes.length < 37 + 16 + 2) throw new Error("authData: credential truncated");
    out.aaguid = bytes.slice(37, 53);
    const idLen = (bytes[53] << 8) | bytes[54];
    if (bytes.length < 55 + idLen) throw new Error("authData: credential id truncated");
    out.credentialId = bytes.slice(55, 55 + idLen);
    // The COSE key is a CBOR map; whatever follows it is extension data.
    const { rest } = decodeCborFirst(bytes.subarray(55 + idLen));
    out.cosePublicKey = bytes.slice(55 + idLen, bytes.length - rest.length);
  }
  return out;
}

// ---------------------------------------------------------------------------
//  COSE key → JWK. COSE is how WebAuthn writes a public key (a CBOR map with
//  numeric labels); JWK is what WebCrypto wants. Only the two shapes every
//  authenticator uses: EC P-256 with ES256, and RSA with RS256.
// ---------------------------------------------------------------------------
export function coseToJwk(coseBytes) {
  let m;
  try { m = decodeCbor(coseBytes); } catch { throw new Error("unsupported key"); }
  if (!(m instanceof Map)) throw new Error("unsupported key");
  const kty = m.get(1), alg = m.get(3);
  if (kty === 2) {
    // EC2: crv (-1) must be P-256 (1), x (-2) and y (-3) are 32-byte coordinates.
    const crv = m.get(-1), x = m.get(-2), y = m.get(-3);
    if (crv !== 1 || alg !== -7 || !(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) throw new Error("unsupported key");
    return { jwk: { kty: "EC", crv: "P-256", x: bytesToB64u(x), y: bytesToB64u(y) }, alg: "ES256" };
  }
  if (kty === 3) {
    const n = m.get(-1), e = m.get(-2);
    if (alg !== -257 || !(n instanceof Uint8Array) || !(e instanceof Uint8Array) || !n.length || !e.length) throw new Error("unsupported key");
    return { jwk: { kty: "RSA", n: bytesToB64u(n), e: bytesToB64u(e) }, alg: "RS256" };
  }
  throw new Error("unsupported key");
}

const IMPORT_PARAMS = {
  ES256: { name: "ECDSA", namedCurve: "P-256" },
  RS256: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
};

async function importPublicKey(jwk, alg) {
  const params = IMPORT_PARAMS[alg];
  if (!params) throw new Error("unsupported key");
  const clean = alg === "ES256"
    ? { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true }
    : { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true };
  return crypto.subtle.importKey("jwk", clean, params, false, ["verify"]);
}

// ---------------------------------------------------------------------------
//  REGISTRATION — "here is my new public key"
// ---------------------------------------------------------------------------
export async function verifyRegistration({ clientDataJSON, attestationObject, expectedChallenge, expectedOrigin, rpId }) {
  try {
    const client = checkClientData(clientDataJSON, "webauthn.create", expectedChallenge, expectedOrigin);
    if (!client.ok) return client;

    let att;
    try { att = decodeCbor(b64uToBytes(attestationObject)); } catch { return { ok: false, reason: "bad attestation object" }; }
    if (!(att instanceof Map) || !(att.get("authData") instanceof Uint8Array)) return { ok: false, reason: "bad attestation object" };
    // att.get("fmt") / att.get("attStmt") are deliberately ignored — see the header.

    let auth;
    try { auth = parseAuthenticatorData(att.get("authData")); } catch { return { ok: false, reason: "bad authenticator data" }; }
    if (!(await rpIdMatches(auth.rpIdHash, rpId))) return { ok: false, reason: "wrong rpId" };
    if (!auth.flags.up) return { ok: false, reason: "user not present" };
    if (!auth.flags.at || !auth.credentialId || !auth.credentialId.length || !auth.cosePublicKey) return { ok: false, reason: "no credential" };

    let key;
    try { key = coseToJwk(auth.cosePublicKey); } catch { return { ok: false, reason: "unsupported key" }; }
    try { await importPublicKey(key.jwk, key.alg); } catch { return { ok: false, reason: "unsupported key" }; }

    return {
      ok: true,
      credentialId: bytesToB64u(auth.credentialId),
      publicKey: key.jwk,
      alg: key.alg,
      counter: auth.counter,
      aaguid: toHex(auth.aaguid),
    };
  } catch {
    return { ok: false, reason: "malformed registration" };
  }
}

// ---------------------------------------------------------------------------
//  ASSERTION — "here is proof I still hold the private key"
// ---------------------------------------------------------------------------
export async function verifyAssertion({ clientDataJSON, authenticatorData, signature, expectedChallenge, expectedOrigin, rpId, publicKey, alg, storedCounter = 0 }) {
  try {
    const client = checkClientData(clientDataJSON, "webauthn.get", expectedChallenge, expectedOrigin);
    if (!client.ok) return client;

    const authBytes = b64uToBytes(authenticatorData);
    let auth;
    try { auth = parseAuthenticatorData(authBytes); } catch { return { ok: false, reason: "bad authenticator data" }; }
    if (!(await rpIdMatches(auth.rpIdHash, rpId))) return { ok: false, reason: "wrong rpId" };
    if (!auth.flags.up) return { ok: false, reason: "user not present" };

    // The signed message is authenticatorData ‖ SHA-256(clientDataJSON).
    const clientHash = new Uint8Array(await crypto.subtle.digest("SHA-256", b64uToBytes(clientDataJSON)));
    const signed = new Uint8Array(authBytes.length + clientHash.length);
    signed.set(authBytes, 0); signed.set(clientHash, authBytes.length);

    let key;
    try { key = await importPublicKey(publicKey, alg); } catch { return { ok: false, reason: "unsupported key" }; }
    let sig = b64uToBytes(signature);
    let valid = false;
    try {
      if (alg === "ES256") {
        // WebAuthn ECDSA signatures arrive ASN.1 DER-wrapped; WebCrypto wants raw r‖s.
        sig = derToRaw(sig, 32);
        valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, signed);
      } else {
        valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, signed);
      }
    } catch { valid = false; }
    if (!valid) return { ok: false, reason: "bad signature" };

    // The counter climbs on every use for authenticators that count; a value
    // that fails to climb means a cloned key is in play. Ones that don't count
    // report 0 forever, and that's fine.
    const stored = Number(storedCounter) || 0;
    if ((auth.counter > 0 || stored > 0) && !(auth.counter > stored)) return { ok: false, reason: "counter went backwards" };

    return { ok: true, counter: auth.counter };
  } catch {
    return { ok: false, reason: "malformed assertion" };
  }
}

// ---------------------------------------------------------------------------
//  helpers
// ---------------------------------------------------------------------------

// The clientDataJSON is the browser's own record of what it was asked to do.
// It must be for the right action, answer OUR challenge, and come from OUR origin.
function checkClientData(clientDataJSON, wantType, expectedChallenge, expectedOrigin) {
  let data;
  try { data = JSON.parse(new TextDecoder().decode(b64uToBytes(clientDataJSON))); } catch { return { ok: false, reason: "bad client data" }; }
  if (!data || typeof data !== "object") return { ok: false, reason: "bad client data" };
  if (data.type !== wantType) return { ok: false, reason: "wrong type" };
  if (typeof data.challenge !== "string" || !constantTimeEqual(data.challenge, String(expectedChallenge || ""))) return { ok: false, reason: "wrong challenge" };
  if (typeof data.origin !== "string" || data.origin !== String(expectedOrigin || "")) return { ok: false, reason: "wrong origin" };
  return { ok: true };
}

async function rpIdMatches(rpIdHash, rpId) {
  if (!rpId) return false;
  const want = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(rpId))));
  if (rpIdHash.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= rpIdHash[i] ^ want[i];
  return diff === 0;
}

// DER "SEQUENCE { INTEGER r, INTEGER s }" → fixed-width r‖s.
function derToRaw(der, size) {
  if (der[0] !== 0x30) throw new Error("not DER");
  let pos = 2;
  if (der[1] & 0x80) pos = 2 + (der[1] & 0x7f);          // long-form length (won't happen for P-256, handled anyway)
  const readInt = () => {
    if (der[pos++] !== 0x02) throw new Error("not DER");
    let len = der[pos++];
    if (len & 0x80) { const n = len & 0x7f; len = 0; for (let i = 0; i < n; i++) len = (len << 8) | der[pos++]; }
    let v = der.subarray(pos, pos + len); pos += len;
    while (v.length > size && v[0] === 0) v = v.subarray(1);   // strip the sign-padding zero
    if (v.length > size) throw new Error("not DER");
    const out = new Uint8Array(size); out.set(v, size - v.length);
    return out;
  };
  const r = readInt(), s = readInt();
  const raw = new Uint8Array(size * 2); raw.set(r, 0); raw.set(s, size);
  return raw;
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function toHex(bytes) {
  return Array.from(bytes || [], (b) => b.toString(16).padStart(2, "0")).join("");
}
