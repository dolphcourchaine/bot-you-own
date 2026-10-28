// ============================================================================
//  IDENTITY — ID tokens ("Sign in with Google / Microsoft / Apple").
//
//  Shared by every kind of bot. The page never sends a password. A provider's
//  own button (Google Identity Services, Microsoft MSAL, Sign in with Apple JS)
//  hands the browser a signed ID token — a JWT — that says "this person proved
//  they own this email". The browser posts it here; this file checks the token
//  the proper way and hands back the verified email. What the bot does with
//  that email (link a device, open a door, look up a person) is its business.
//
//  What "checks properly" means, in order:
//    1. the token is three base64url parts and the header says RS256
//    2. the signature verifies against the provider's PUBLISHED public key
//       (fetched from its JWKS URL, cached an hour, refetched once on a new kid)
//    3. iss is one of the provider's issuers
//    4. aud is OUR client id (a token minted for another app is refused)
//    5. exp is in the future (with 60 s of clock slack)
//    6. the email claim is present and verified
//  Every failure is a refusal — identity fails CLOSED.
//
//  Facebook is NOT here: Facebook Login gives an access token, not an OpenID
//  ID token, so verifying it means a Graph API call (/debug_token), which is a
//  different mechanism. Add it as its own function if it's ever wanted.
// ============================================================================

const PROVIDERS = {
  google: {
    issuers: () => ["accounts.google.com", "https://accounts.google.com"],
    jwks: "https://www.googleapis.com/oauth2/v3/certs",
    email: (c) => (c.email_verified === true || c.email_verified === "true") ? c.email : null,
  },
  microsoft: {
    // The v2.0 "common" endpoint issues tokens whose issuer carries the tenant id (tid):
    // personal accounts use the fixed consumers tenant, work accounts their own.
    issuers: (c) => (c.tid ? [`https://login.microsoftonline.com/${c.tid}/v2.0`] : []),
    jwks: "https://login.microsoftonline.com/common/discovery/v2.0/keys",
    email: (c) => c.email || c.preferred_username || null,
  },
  apple: {
    issuers: () => ["https://appleid.apple.com"],
    jwks: "https://appleid.apple.com/auth/keys",
    email: (c) => (c.email_verified === true || c.email_verified === "true") ? c.email : null,
  },
};

export const SIGNIN_PROVIDERS = Object.keys(PROVIDERS);

const JWKS_CACHE = new Map();   // url → { at, keys }
const JWKS_TTL_MS = 60 * 60 * 1000;

// Returns { ok: true, email } or { ok: false, reason }. Never throws.
// `jwksUrl` and `now` exist so the test suite can point it at a local fake and a fixed clock.
export async function verifyIdToken(token, provider, { clientId, jwksUrl = null, now = Date.now(), fetchFn = fetch } = {}) {
  const P = PROVIDERS[String(provider || "").toLowerCase()];
  if (!P) return { ok: false, reason: "unknown provider" };
  if (!clientId) return { ok: false, reason: "provider not configured" };
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return { ok: false, reason: "not a JWT" };
  let header, claims;
  try { header = JSON.parse(b64urlToText(parts[0])); claims = JSON.parse(b64urlToText(parts[1])); } catch { return { ok: false, reason: "unreadable token" }; }
  if (header.alg !== "RS256" || !header.kid) return { ok: false, reason: "unsupported algorithm" };

  // Signature first: nothing in the claims is trusted until it verifies.
  const url = jwksUrl || P.jwks;
  let jwk = await findKey(url, header.kid, fetchFn, now);
  if (!jwk) return { ok: false, reason: "signing key not found" };
  let valid = false;
  try {
    const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch { valid = false; }
  if (!valid) return { ok: false, reason: "bad signature" };

  const issuers = P.issuers(claims);
  if (!issuers.includes(claims.iss)) return { ok: false, reason: "wrong issuer" };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) return { ok: false, reason: "wrong audience" };
  const nowS = Math.floor(now / 1000);
  if (!Number.isFinite(Number(claims.exp)) || Number(claims.exp) + 60 < nowS) return { ok: false, reason: "expired" };
  if (Number.isFinite(Number(claims.nbf)) && Number(claims.nbf) - 60 > nowS) return { ok: false, reason: "not yet valid" };
  const email = String(P.email(claims) || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return { ok: false, reason: "no verified email in token" };
  return { ok: true, email, provider, sub: String(claims.sub || "") };
}

async function findKey(url, kid, fetchFn, now) {
  const cached = JWKS_CACHE.get(url);
  let keys = cached && now - cached.at < JWKS_TTL_MS ? cached.keys : null;
  let hit = keys?.find((k) => k.kid === kid);
  if (hit) return hit;
  // Unknown kid (or cold cache): fetch once. Providers rotate keys; the cache follows.
  try {
    const r = await fetchFn(url, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`jwks ${r.status}`);
    keys = ((await r.json())?.keys || []).filter((k) => k && k.kty === "RSA" && k.n && k.e);
    JWKS_CACHE.set(url, { at: now, keys });
  } catch (err) {
    console.error("jwks fetch failed", url, err?.message || err);
    return null;
  }
  return keys.find((k) => k.kid === kid) || null;
}

export function clearJwksCache() { JWKS_CACHE.clear(); }

function b64urlToBytes(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlToText(s) { return new TextDecoder().decode(b64urlToBytes(s)); }
