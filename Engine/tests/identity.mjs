// ============================================================================
//  IDENTITY TESTS — every way a person can prove who they are, exercised
//  without Google, Microsoft, a phone or a browser.
//
//    node Engine/tests/identity.mjs
//
//  a. ID tokens   — a throwaway RSA key signs tokens; a local HTTP server plays
//                   the provider's JWKS endpoint. Sixteen cases from the
//                   original food-log suite, behaviour-identical.
//  b. TOTP        — the RFC 6238 published test vectors, plus the ±30 s window.
//  c. CBOR        — known byte strings decode to known values.
//  d. Passkeys    — real P-256 and RSA keys made in node, wrapped the way a
//                   browser would wrap them, verified and then tampered with.
//  e. QR          — the encoder's output matched against a reference matrix,
//                   structure checks, and determinism.
//
//  Prints PASS / FAIL per check and a final "identity: N passed, M failed".
//  Exit code 1 on any failure.
// ============================================================================
import http from "node:http";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyIdToken, clearJwksCache } from "../identity/idtoken.js";
import { base32Encode, base32Decode, newSecret, totp, verifyTotp, otpauthUri } from "../identity/totp.js";
import { b64uToBytes, bytesToB64u, decodeCbor, decodeCborFirst, parseAuthenticatorData, coseToJwk, verifyRegistration, verifyAssertion, randomChallenge } from "../identity/passkeys.js";

let passed = 0, failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
};
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const hex = (s) => new Uint8Array(s.replace(/\s+/g, "").match(/../g).map((h) => parseInt(h, 16)));
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ============================================================================
//  a. ID tokens
// ============================================================================
console.log("\n-- ID tokens --");
{
  async function makeKey(kid) {
    const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
    return { kp, jwk: { kty: "RSA", kid, use: "sig", alg: "RS256", n: jwk.n, e: jwk.e } };
  }
  async function sign(kp, kid, claims) {
    const h = b64u(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })), p = b64u(JSON.stringify(claims));
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${b64u(sig)}`;
  }

  const good = await makeKey("k1"), evil = await makeKey("k1");   // same kid, different key = a forged signature
  const server = http.createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ keys: [good.jwk] })); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const jwksUrl = `http://127.0.0.1:${server.address().port}/certs`;
  const now = Date.now(), nowS = Math.floor(now / 1000);
  const CLIENT = "123-abc.apps.googleusercontent.com";

  const cases = [
    ["google good", "google", await sign(good.kp, "k1", { iss: "https://accounts.google.com", aud: CLIENT, exp: nowS + 600, iat: nowS, sub: "1", email: "Sam@Example.com", email_verified: true }), true, "sam@example.com"],
    ["google wrong aud", "google", await sign(good.kp, "k1", { iss: "https://accounts.google.com", aud: "someone-else", exp: nowS + 600, email: "sam@example.com", email_verified: true }), false, "wrong audience"],
    ["google expired", "google", await sign(good.kp, "k1", { iss: "https://accounts.google.com", aud: CLIENT, exp: nowS - 3600, email: "sam@example.com", email_verified: true }), false, "expired"],
    ["google bad signature", "google", await sign(evil.kp, "k1", { iss: "https://accounts.google.com", aud: CLIENT, exp: nowS + 600, email: "sam@example.com", email_verified: true }), false, "bad signature"],
    ["google wrong issuer", "google", await sign(good.kp, "k1", { iss: "https://evil.example", aud: CLIENT, exp: nowS + 600, email: "sam@example.com", email_verified: true }), false, "wrong issuer"],
    ["google unverified email", "google", await sign(good.kp, "k1", { iss: "https://accounts.google.com", aud: CLIENT, exp: nowS + 600, email: "sam@example.com", email_verified: false }), false, "no verified email in token"],
    ["google tampered payload", "google", (await sign(good.kp, "k1", { iss: "https://accounts.google.com", aud: CLIENT, exp: nowS + 600, email: "sam@example.com", email_verified: true })).replace(/^([^.]+)\.[^.]+/, (m, h) => `${h}.${b64u(JSON.stringify({ iss: "https://accounts.google.com", aud: CLIENT, exp: nowS + 600, email: "mallory@example.com", email_verified: true }))}`), false, "bad signature"],
    ["microsoft good (tenant issuer)", "microsoft", await sign(good.kp, "k1", { iss: "https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0", tid: "9188040d-6c67-4c5b-b112-36a304b66dad", aud: CLIENT, exp: nowS + 600, preferred_username: "sam@outlook.com" }), true, "sam@outlook.com"],
    ["microsoft wrong aud", "microsoft", await sign(good.kp, "k1", { iss: "https://login.microsoftonline.com/t1/v2.0", tid: "t1", aud: "other-app", exp: nowS + 600, email: "sam@outlook.com" }), false, "wrong audience"],
    ["microsoft expired", "microsoft", await sign(good.kp, "k1", { iss: "https://login.microsoftonline.com/t1/v2.0", tid: "t1", aud: CLIENT, exp: nowS - 120, email: "sam@outlook.com" }), false, "expired"],
    ["microsoft bad signature", "microsoft", await sign(evil.kp, "k1", { iss: "https://login.microsoftonline.com/t1/v2.0", tid: "t1", aud: CLIENT, exp: nowS + 600, email: "sam@outlook.com" }), false, "bad signature"],
    ["microsoft issuer/tid mismatch", "microsoft", await sign(good.kp, "k1", { iss: "https://login.microsoftonline.com/OTHER/v2.0", tid: "t1", aud: CLIENT, exp: nowS + 600, email: "sam@outlook.com" }), false, "wrong issuer"],
    ["not a jwt", "google", "hello", false, "not a JWT"],
    ["unknown provider", "facebook", "a.b.c", false, "unknown provider"],
    ["alg none", "google", `${b64u(JSON.stringify({ alg: "none", kid: "k1" }))}.${b64u(JSON.stringify({ iss: "https://accounts.google.com", aud: CLIENT, exp: nowS + 600, email: "sam@example.com", email_verified: true }))}.`, false, "unsupported algorithm"],
  ];

  for (const [name, provider, token, wantOk, want] of cases) {
    clearJwksCache();
    const r = await verifyIdToken(token, provider, { clientId: CLIENT, jwksUrl, now });
    const ok = r.ok === wantOk && (wantOk ? r.email === want : r.reason === want);
    check(`idtoken: ${name}`, ok, r.ok ? "ok " + r.email : "refused: " + r.reason);
  }
  // The cache: one JWKS fetch serves many tokens.
  let fetches = 0; const counting = (u, o) => { fetches++; return fetch(u, o); };
  clearJwksCache();
  for (let i = 0; i < 3; i++) await verifyIdToken(cases[0][2], "google", { clientId: CLIENT, jwksUrl, now, fetchFn: counting });
  check(`idtoken: jwks cached (${fetches} fetch for 3 verifications)`, fetches === 1);
  server.close();
}

// ============================================================================
//  b. TOTP
// ============================================================================
console.log("\n-- TOTP --");
{
  const secret = base32Encode(new TextEncoder().encode("12345678901234567890"));
  check("totp: base32 of the RFC secret", secret === "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", secret);
  // RFC 6238 Appendix B, SHA-1 column (8 digits).
  const vectors = [[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"], [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"]];
  for (const [T, want] of vectors) {
    const got = await totp(secret, { time: T * 1000, digits: 8 });
    check(`totp: RFC vector T=${T} → ${want}`, got === want, got);
  }
  const now = 1700000000000;
  const code = await totp(secret, { time: now });
  check("totp: 6 digits, zero-padded shape", /^\d{6}$/.test(code), code);
  check("totp: verifies at the same moment (offset 0)", (await verifyTotp(secret, code, { time: now })).offset === 0);
  check("totp: verifies 30 s later (offset -1)", (await verifyTotp(secret, code, { time: now + 30_000 })).offset === -1);
  check("totp: verifies 30 s earlier (offset +1)", (await verifyTotp(secret, code, { time: now - 30_000 })).offset === 1);
  check("totp: refused 90 s later", (await verifyTotp(secret, code, { time: now + 90_000 })).ok === false);
  check("totp: spaces in the typed code are ignored", (await verifyTotp(secret, code.slice(0, 3) + " " + code.slice(3), { time: now })).ok === true);
  check("totp: a 5-digit code is refused", (await verifyTotp(secret, code.slice(1), { time: now })).ok === false);
  check("totp: a wrong code is refused", (await verifyTotp(secret, String((Number(code) + 1) % 1000000).padStart(6, "0"), { time: now })).ok === false);
  check("totp: garbage secret is refused, not thrown", (await verifyTotp("not!base32", code, { time: now })).ok === false);

  const rnd = crypto.getRandomValues(new Uint8Array(20));
  check("totp: base32 round-trip (20 bytes)", same(base32Decode(base32Encode(rnd)), rnd));
  const odd = crypto.getRandomValues(new Uint8Array(7));
  check("totp: base32 round-trip (7 bytes, partial group)", same(base32Decode(base32Encode(odd)), odd));
  check("totp: base32 decode forgives case, spaces, dashes, padding", same(base32Decode("gezd gnbv-gy3t qojq===="), new TextEncoder().encode("1234567890")));
  let threw = false; try { base32Decode("ABC1"); } catch { threw = true; }
  check("totp: base32 decode rejects a '1'", threw);
  const s = newSecret();
  check("totp: newSecret is 32 base32 chars (20 bytes)", /^[A-Z2-7]{32}$/.test(s) && base32Decode(s).length === 20, s);
  const uri = otpauthUri({ secret: s, label: "jim@example.com", issuer: "Bot You Own" });
  check("totp: otpauth URI shape", uri === `otpauth://totp/Bot%20You%20Own:jim%40example.com?secret=${s}&issuer=Bot%20You%20Own&algorithm=SHA1&digits=6&period=30`, uri);
}

// ============================================================================
//  c. CBOR
// ============================================================================
console.log("\n-- CBOR --");
{
  const m = decodeCbor(hex("a2 01 02 20 01"));
  check("cbor: map with int keys {1:2, -1:1}", m instanceof Map && m.get(1) === 2 && m.get(-1) === 1);
  check("cbor: array [1,2,3]", JSON.stringify(decodeCbor(hex("83 01 02 03"))) === "[1,2,3]");
  check("cbor: text 'foo'", decodeCbor(hex("63 66 6f 6f")) === "foo");
  const bs = decodeCbor(hex("42 01 02"));
  check("cbor: byte string → Uint8Array", bs instanceof Uint8Array && same(bs, [1, 2]));
  check("cbor: true / false / null / undefined", decodeCbor(hex("f5")) === true && decodeCbor(hex("f4")) === false && decodeCbor(hex("f6")) === null && decodeCbor(hex("f7")) === undefined);
  check("cbor: 1-byte length 100", decodeCbor(hex("18 64")) === 100);
  check("cbor: 2-byte length 256", decodeCbor(hex("19 01 00")) === 256);
  check("cbor: 4-byte length 65536", decodeCbor(hex("1a 00 01 00 00")) === 65536);
  check("cbor: 8-byte length 2^32", decodeCbor(hex("1b 00 00 00 01 00 00 00 00")) === 4294967296);
  check("cbor: negative -1 and -100", decodeCbor(hex("20")) === -1 && decodeCbor(hex("38 63")) === -100);
  check("cbor: float64 1.1", decodeCbor(hex("fb 3f f1 99 99 99 99 99 9a")) === 1.1);
  check("cbor: float32 100000", decodeCbor(hex("fa 47 c3 50 00")) === 100000);
  check("cbor: float16 1.0 and -0.5", decodeCbor(hex("f9 3c 00")) === 1 && decodeCbor(hex("f9 b8 00")) === -0.5);
  const mm = decodeCbor(hex("a2 63 66 6d 74 64 6e 6f 6e 65 67 61 74 74 53 74 6d 74 a0"));
  check("cbor: map with text keys {fmt:'none', attStmt:{}}", mm.get("fmt") === "none" && mm.get("attStmt") instanceof Map && mm.get("attStmt").size === 0);
  const first = decodeCborFirst(hex("a1 01 02 ff ee"));
  check("cbor: decodeCborFirst returns the rest", first.value.get(1) === 2 && same(first.rest, [0xff, 0xee]));
  let threw = false; try { decodeCbor(hex("5f")); } catch { threw = true; }
  check("cbor: indefinite length throws", threw);
  threw = false; try { decodeCbor(hex("83 01 02")); } catch { threw = true; }
  check("cbor: truncated input throws", threw);
}

// ============================================================================
//  d. Passkeys
// ============================================================================
console.log("\n-- Passkeys --");
{
  // A tiny CBOR encoder — enough to build what an authenticator would send.
  function cborEncode(v) {
    const out = [];
    const head = (major, n) => {
      if (n < 24) out.push((major << 5) | n);
      else if (n < 256) out.push((major << 5) | 24, n);
      else if (n < 65536) out.push((major << 5) | 25, n >> 8, n & 255);
      else out.push((major << 5) | 26, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
    };
    const enc = (x) => {
      if (typeof x === "number") { if (x >= 0) head(0, x); else head(1, -1 - x); }
      else if (x instanceof Uint8Array) { head(2, x.length); out.push(...x); }
      else if (typeof x === "string") { const b = new TextEncoder().encode(x); head(3, b.length); out.push(...b); }
      else if (Array.isArray(x)) { head(4, x.length); x.forEach(enc); }
      else if (x instanceof Map) { head(5, x.size); for (const [k, val] of x) { enc(k); enc(val); } }
      else if (x && typeof x === "object") { const ks = Object.keys(x); head(5, ks.length); for (const k of ks) { enc(k); enc(x[k]); } }
      else throw new Error("cannot encode " + typeof x);
    };
    enc(v);
    return new Uint8Array(out);
  }
  // node's WebCrypto gives raw r‖s; browsers give DER. Wrap the way a browser would.
  function rawToDer(raw) {
    const int = (bytes) => {
      let i = 0; while (i < bytes.length - 1 && bytes[i] === 0) i++;
      let v = bytes.slice(i);
      if (v[0] & 0x80) v = new Uint8Array([0, ...v]);
      return [0x02, v.length, ...v];
    };
    const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
    return new Uint8Array([0x30, body.length, ...body]);
  }
  const RP = "localhost", ORIGIN = "http://localhost:8790";
  const rpIdHash = await sha256(new TextEncoder().encode(RP));
  const credId = crypto.getRandomValues(new Uint8Array(16));

  function authData({ flags, counter, cose = null, extensions = null, hash = rpIdHash }) {
    const parts = [hash, new Uint8Array([flags]), new Uint8Array([(counter >>> 24) & 255, (counter >>> 16) & 255, (counter >>> 8) & 255, counter & 255])];
    if (cose) parts.push(new Uint8Array(16), new Uint8Array([credId.length >> 8, credId.length & 255]), credId, cose);
    if (extensions) parts.push(extensions);
    const len = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(len); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  const clientData = (type, challenge) => b64u(JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false }));

  async function register({ cose, challenge, fmt = "none", flags = 0x45, rp = RP, origin = ORIGIN, type = "webauthn.create", counter = 0 }) {
    const att = cborEncode(new Map([["fmt", fmt], ["attStmt", new Map()], ["authData", authData({ flags, counter, cose })]]));
    return verifyRegistration({ clientDataJSON: b64u(JSON.stringify({ type, challenge, origin })), attestationObject: b64u(att), expectedChallenge: challenge, expectedOrigin: ORIGIN, rpId: rp });
  }

  // ---- ES256 ---------------------------------------------------------------
  const ec = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const ecJwk = await crypto.subtle.exportKey("jwk", ec.publicKey);
  const ecCose = cborEncode(new Map([[1, 2], [3, -7], [-1, 1], [-2, b64uToBytes(ecJwk.x)], [-3, b64uToBytes(ecJwk.y)]]));

  const chal = randomChallenge();
  check("passkey: randomChallenge is 32 bytes base64url", /^[A-Za-z0-9_-]{43}$/.test(chal) && b64uToBytes(chal).length === 32, chal);
  check("passkey: base64url round-trip", bytesToB64u(b64uToBytes(chal)) === chal);

  const reg = await register({ cose: ecCose, challenge: chal });
  check("passkey: ES256 registration ok", reg.ok === true, reg.reason);
  check("passkey: registration returns credentialId, alg, counter, aaguid", reg.ok && reg.credentialId === bytesToB64u(credId) && reg.alg === "ES256" && reg.counter === 0 && reg.aaguid === "0".repeat(32));
  check("passkey: returned jwk matches the generated key", reg.ok && reg.publicKey.kty === "EC" && reg.publicKey.crv === "P-256" && reg.publicKey.x === ecJwk.x && reg.publicKey.y === ecJwk.y);
  let imported = false;
  try { await crypto.subtle.importKey("jwk", { ...reg.publicKey, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]); imported = true; } catch {}
  check("passkey: returned jwk imports in WebCrypto", imported);

  const packed = await register({ cose: ecCose, challenge: chal, fmt: "packed" });
  check("passkey: fmt 'packed' accepted (attestation statement ignored)", packed.ok === true, packed.reason);

  // Registration negatives
  const attOk = b64u(cborEncode(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData({ flags: 0x45, counter: 0, cose: ecCose })]])));
  check("passkey: registration wrong challenge", (await verifyRegistration({ clientDataJSON: clientData("webauthn.create", chal), attestationObject: attOk, expectedChallenge: randomChallenge(), expectedOrigin: ORIGIN, rpId: RP })).reason === "wrong challenge");
  check("passkey: registration wrong origin", (await register({ cose: ecCose, challenge: chal, origin: "https://evil.example" })).reason === "wrong origin");
  check("passkey: registration wrong type", (await register({ cose: ecCose, challenge: chal, type: "webauthn.get" })).reason === "wrong type");
  check("passkey: registration wrong rpId", (await register({ cose: ecCose, challenge: chal, rp: "example.com" })).reason === "wrong rpId");
  check("passkey: registration user not present", (await register({ cose: ecCose, challenge: chal, flags: 0x44 })).reason === "user not present");
  check("passkey: registration without a credential (AT off)", (await register({ cose: null, challenge: chal, flags: 0x05 })).reason === "no credential");
  const badCose = cborEncode(new Map([[1, 2], [3, -7], [-1, 2], [-2, b64uToBytes(ecJwk.x)], [-3, b64uToBytes(ecJwk.y)]]));   // P-384 claimed
  check("passkey: registration with an unsupported curve", (await register({ cose: badCose, challenge: chal })).reason === "unsupported key");
  const bogus = await verifyRegistration({ clientDataJSON: clientData("webauthn.create", chal), attestationObject: "!!!notcbor", expectedChallenge: chal, expectedOrigin: ORIGIN, rpId: RP });
  check("passkey: garbage attestation object refused, not thrown", bogus.ok === false, bogus.reason);

  // parseAuthenticatorData with extension bytes after the COSE key
  const withExt = parseAuthenticatorData(authData({ flags: 0xc5, counter: 7, cose: ecCose, extensions: hex("a0") }));
  check("passkey: authData parser stops the COSE key before extensions", withExt.flags.ed && withExt.counter === 7 && same(withExt.cosePublicKey, ecCose) && same(withExt.credentialId, credId));
  const { jwk: j2, alg: a2 } = coseToJwk(ecCose);
  check("passkey: coseToJwk EC2 → ES256", a2 === "ES256" && j2.kty === "EC" && j2.x === ecJwk.x);

  // ---- ES256 assertion -----------------------------------------------------
  async function assert({ key, alg, publicKey, challenge, flags = 0x05, counter = 1, storedCounter = 0, rp = RP, origin = ORIGIN, type = "webauthn.get", tamper = false, hash = rpIdHash }) {
    const ad = authData({ flags, counter, hash });
    const cd = b64u(JSON.stringify({ type, challenge, origin }));
    const signed = new Uint8Array([...ad, ...(await sha256(b64uToBytes(cd)))]);
    let sig;
    if (alg === "ES256") sig = rawToDer(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, signed)));
    else sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, signed));
    if (tamper) sig[sig.length - 1] ^= 0x01;
    return verifyAssertion({ clientDataJSON: cd, authenticatorData: b64u(ad), signature: b64u(sig), expectedChallenge: challenge, expectedOrigin: ORIGIN, rpId: RP, publicKey, alg, storedCounter });
  }
  const chal2 = randomChallenge();
  const ecArgs = { key: ec.privateKey, alg: "ES256", publicKey: reg.publicKey, challenge: chal2 };
  const ok1 = await assert(ecArgs);
  check("passkey: ES256 assertion ok (DER signature → raw)", ok1.ok === true && ok1.counter === 1, ok1.reason);
  // Run a handful so we hit r/s values with a leading 0x00 in DER.
  let all = true; for (let i = 0; i < 12; i++) { const r = await assert({ ...ecArgs, challenge: randomChallenge() }); if (!r.ok) all = false; }
  check("passkey: 12 more ES256 assertions with fresh signatures all verify", all);
  check("passkey: assertion counter climbs (stored 5 → 6)", (await assert({ ...ecArgs, counter: 6, storedCounter: 5 })).ok === true);
  check("passkey: authenticator that never counts (0 → 0) accepted", (await assert({ ...ecArgs, counter: 0, storedCounter: 0 })).ok === true);
  check("passkey: counter replay (stored 5, got 5)", (await assert({ ...ecArgs, counter: 5, storedCounter: 5 })).reason === "counter went backwards");
  check("passkey: counter went backwards (stored 5, got 3)", (await assert({ ...ecArgs, counter: 3, storedCounter: 5 })).reason === "counter went backwards");
  check("passkey: assertion wrong rpIdHash", (await assert({ ...ecArgs, hash: await sha256(new TextEncoder().encode("example.com")) })).reason === "wrong rpId");
  check("passkey: assertion wrong challenge", (await verifyAssertion({ clientDataJSON: clientData("webauthn.get", chal2), authenticatorData: b64u(authData({ flags: 0x05, counter: 1 })), signature: "AA", expectedChallenge: randomChallenge(), expectedOrigin: ORIGIN, rpId: RP, publicKey: reg.publicKey, alg: "ES256", storedCounter: 0 })).reason === "wrong challenge");
  check("passkey: assertion wrong origin", (await assert({ ...ecArgs, origin: "https://evil.example" })).reason === "wrong origin");
  check("passkey: assertion wrong type", (await assert({ ...ecArgs, type: "webauthn.create" })).reason === "wrong type");
  check("passkey: assertion tampered signature", (await assert({ ...ecArgs, tamper: true })).reason === "bad signature");
  check("passkey: assertion user-present flag off", (await assert({ ...ecArgs, flags: 0x04 })).reason === "user not present");
  const other = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  check("passkey: assertion signed by a different key", (await assert({ ...ecArgs, key: other.privateKey })).reason === "bad signature");
  const junk = await verifyAssertion({ clientDataJSON: clientData("webauthn.get", chal2), authenticatorData: "AAAA", signature: "AA", expectedChallenge: chal2, expectedOrigin: ORIGIN, rpId: RP, publicKey: reg.publicKey, alg: "ES256" });
  check("passkey: junk authenticator data refused, not thrown", junk.ok === false, junk.reason);

  // ---- RS256 ---------------------------------------------------------------
  const rsa = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const rsaJwk = await crypto.subtle.exportKey("jwk", rsa.publicKey);
  const rsaCose = cborEncode(new Map([[1, 3], [3, -257], [-1, b64uToBytes(rsaJwk.n)], [-2, b64uToBytes(rsaJwk.e)]]));
  const chal3 = randomChallenge();
  const rreg = await register({ cose: rsaCose, challenge: chal3 });
  check("passkey: RS256 registration ok", rreg.ok === true && rreg.alg === "RS256" && rreg.publicKey.kty === "RSA" && rreg.publicKey.n === rsaJwk.n, rreg.reason);
  const rsaArgs = { key: rsa.privateKey, alg: "RS256", publicKey: rreg.publicKey, challenge: randomChallenge() };
  const rok = await assert(rsaArgs);
  check("passkey: RS256 assertion ok", rok.ok === true && rok.counter === 1, rok.reason);
  check("passkey: RS256 tampered signature", (await assert({ ...rsaArgs, tamper: true })).reason === "bad signature");
}

// ============================================================================
//  e. QR
// ============================================================================
console.log("\n-- QR --");
{
  // qr.js is a plain browser script; run it with a fake window to get at qrMatrix.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, "..", "public", "id", "qr.js"), "utf8");
  const win = {};
  vm.runInNewContext(src, { window: win, TextEncoder });
  const { qrMatrix, drawQr } = win;
  check("qr: window.qrMatrix and window.drawQr are exposed", typeof qrMatrix === "function" && typeof drawQr === "function");

  const isFinder = (m, cx, cy) => {
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      if (m[cy + dy][cx + dx] !== (d !== 2)) return false;
    }
    return true;
  };
  const finders = (m) => { const n = m.length; return isFinder(m, 3, 3) && isFinder(m, n - 4, 3) && isFinder(m, 3, n - 4); };
  const timing = (m) => { for (let i = 8; i < m.length - 8; i++) if (m[6][i] !== (i % 2 === 0) || m[i][6] !== (i % 2 === 0)) return false; return true; };
  // Read the 15 format bits back and check they are one of the 8 valid codes for level M.
  const formatBits = (m) => {
    const bits = [];
    for (let i = 0; i <= 5; i++) bits[i] = m[i][8];
    bits[6] = m[7][8]; bits[7] = m[8][8]; bits[8] = m[8][7];
    for (let i = 9; i < 15; i++) bits[i] = m[8][14 - i];
    return bits.reduce((v, b, i) => v | ((b ? 1 : 0) << i), 0);
  };
  const validFormat = (level, mask) => { const d = (level << 3) | mask; let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537); return ((d << 10) | r) ^ 0x5412; };
  const formatIsValidM = (m) => { const f = formatBits(m); for (let k = 0; k < 8; k++) if (validFormat(0, k) === f) return k; return -1; };

  const hello = qrMatrix("HELLO WORLD");
  check("qr: 'HELLO WORLD' is version 1 (21×21)", hello.length === 21 && hello.every((r) => r.length === 21));
  check("qr: finder patterns at the three corners", finders(hello));
  check("qr: timing patterns", timing(hello));
  check("qr: dark module at (8, size-8)", hello[21 - 8][8] === true);
  check("qr: format info decodes to level M with a valid mask", formatIsValidM(hello) >= 0, "mask " + formatIsValidM(hello));
  check("qr: encoding twice is identical", JSON.stringify(qrMatrix("HELLO WORLD")) === JSON.stringify(hello));

  // Reference: "HELLO WORLD", byte mode, version 1, level M, mask 0 — produced by
  // an independent encoder (python-qrcode) and checked here module for module.
  const REF = `
#######..##.#.#######
#.....#.##..#.#.....#
#.###.#.....#.#.###.#
#.###.#...##..#.###.#
#.###.#.##..#.#.###.#
#.....#..#..#.#.....#
#######.#.#.#.#######
..........###........
#.#.#.#..#.#....#..#.
#.#..#...##...##...#.
#...#.#####.##.######
#.##...####.....#..#.
#.##..###...#####.#..
........####.#....##.
#######...##...##.###
#.....#..####..#....#
#.###.#.####..#.#.#..
#.###.#....#..###.##.
#.###.#.#.#.#.#.#.#.#
#.....#...##....#..#.
#######.##.##.##..###`.trim().split("\n").map((r) => [...r].map((c) => c === "#"));
  const mask0 = qrMatrix("HELLO WORLD", { mask: 0 });
  let diffs = 0;
  for (let y = 0; y < 21; y++) for (let x = 0; x < 21; x++) if (mask0[y][x] !== REF[y][x]) diffs++;
  check("qr: 'HELLO WORLD' mask 0 matches the reference matrix module-for-module", diffs === 0, diffs + " modules differ");

  const uri = otpauthUri({ secret: newSecret(), label: "someone@example.com", issuer: "Bot You Own" });
  const q = qrMatrix(uri);
  check(`qr: otpauth URI (${uri.length} chars) fits, size ${q.length}`, q.length >= 21 && q.length <= 57 && (q.length - 17) % 4 === 0 && finders(q) && timing(q) && formatIsValidM(q) >= 0);
  const big = qrMatrix("x".repeat(200));
  check("qr: 200 chars fits within version 10 and has version info", big.length <= 57 && finders(big) && (big.length - 17) / 4 >= 7);
  // Version info is two 6×3 blocks mirrored across the diagonal — check the mirror.
  let mirrored = true;
  for (let i = 0; i < 18; i++) { const a = big.length - 11 + (i % 3), b = Math.floor(i / 3); if (big[b][a] !== big[a][b]) mirrored = false; }
  check("qr: version info blocks mirror each other", mirrored);
  const unicode = qrMatrix("héllo wörld ✓");
  check("qr: UTF-8 text encodes (byte mode)", unicode.length === 25 && finders(unicode));
  let threw = false; try { qrMatrix("x".repeat(400)); } catch { threw = true; }
  check("qr: text too long for version 10 throws", threw);
  // All eight masks produce a valid, differently-masked matrix.
  const masks = new Set();
  for (let k = 0; k < 8; k++) masks.add(JSON.stringify(qrMatrix("HELLO WORLD", { mask: k })));
  check("qr: the eight masks give eight different matrices", masks.size === 8);

  // drawQr with a stand-in canvas: sizes it and paints every dark module.
  let rects = 0;
  const canvas = { width: 0, height: 0, getContext: () => ({ fillStyle: "", fillRect: () => { rects++; } }) };
  drawQr(canvas, "HELLO WORLD", { scale: 4, margin: 4 });
  const dark = hello.flat().filter(Boolean).length;
  check("qr: drawQr sizes the canvas (21+8)·4 and paints one rect per dark module", canvas.width === 116 && canvas.height === 116 && rects === dark + 1, `${canvas.width}px, ${rects} rects`);
}

console.log(`\nidentity: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
