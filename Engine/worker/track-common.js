// ============================================================================
//  FOOD LOG — the small shared pieces every track-*.js file uses.
//  Config normalising, hashing, dates, random codes, number clamps. Nothing
//  here touches the database or the model.
// ============================================================================

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const EMAIL_SHAPE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

// (The food block itself is normalised by Engine/worker/projects.js → kind "food".)

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

export function hex(bytes) { return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join(""); }

export async function sha256hex(text) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text))));
}

export function nowIso() { return new Date().toISOString(); }
export function todayUtc() { return nowIso().slice(0, 10); }

// A date the client sent, or today. The phone knows its own day better than the server does.
export function pickDate(s) { s = String(s || "").trim(); return DATE_RE.test(s) ? s : todayUtc(); }

export function addDays(date, n) { const d = new Date(date + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

// 6 characters, no 0/O/1/I so it survives being read out loud.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function randomCode(n = 6) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map((x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join("");
}
export function randomId(bytes = 12) { return hex(crypto.getRandomValues(new Uint8Array(bytes))); }

export function clamp(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
export function round1(n) { return Math.round(Number(n) * 10) / 10; }

export function cleanEmail(e) { e = String(e || "").trim().toLowerCase().slice(0, 254); return EMAIL_SHAPE.test(e) ? e : ""; }

export async function readJson(request) { try { return (await request.json()) || {}; } catch { return {}; } }

// Bytes → base64 without blowing the stack on a 2 MB photo.
export function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
