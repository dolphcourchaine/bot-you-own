// ============================================================================
//  SIGN-UPS — everyone who came through the gate, with the abuse marks.
//
//  One row per person per bot (id_users, Engine/identity/devices.js), plus what
//  the gate collected: name, phone, the boxes they ticked and the exact words,
//  and three keyed hashes — connection (ip_hash), browser (ua_hash), device
//  fingerprint (fp_hash). Hashes only: nothing here can be turned back into an IP.
//
//  The marks, computed on read (nothing is decided at sign-up time):
//    many-from-ip       5+ different emails from one connection in 24 h
//    many-from-device   3+ different emails from one device in 24 h
//    throwaway          a disposable-email domain
//    no-consent         ticked neither box (fine, just not a lead)
//
//  GET /api/admin/signups?project=<id|*>&limit=500 → { rows, totals }
//  GET /api/admin/signups.csv?project=<id|*>        → the same as a spreadsheet
// ============================================================================

export const DISPOSABLE = new Set(["mailinator.com", "guerrillamail.com", "guerrillamail.net", "sharklasers.com", "10minutemail.com", "10minutemail.net", "tempmail.com", "temp-mail.org", "temp-mail.io", "yopmail.com", "yopmail.fr", "dispostable.com", "trashmail.com", "trashmail.me", "getnada.com", "maildrop.cc", "throwawaymail.com", "fakeinbox.com", "mohmal.com", "emailondeck.com", "mailnesia.com", "tempr.email", "discard.email", "spamgourmet.com", "mytemp.email", "burnermail.io", "inboxkitten.com", "tmpmail.org", "tmpmail.net", "moakt.com", "mailsac.com", "harakirimail.com", "33mail.com", "guerrillamailblock.com", "grr.la", "pokemail.net", "spam4.me", "mailcatch.com", "tempinbox.com", "minuteinbox.com", "eyepaste.com", "mintemail.com", "anonbox.net", "mailtemp.net", "tempail.com", "crazymailing.com", "emailfake.com", "generator.email", "fakemail.net", "dropmail.me"]);

const IP_LIMIT = 5, DEVICE_LIMIT = 3;

import { tourProgressMap } from "./tour.js";

export async function listSignups(env, { project = "*", limit = 500 } = {}) {
  if (!env.DB) return { enabled: false, reason: "Sign-ups need the D1 database (wrangler.jsonc → d1_databases).", rows: [], totals: {} };
  const where = project && project !== "*" ? `WHERE bot = ?` : ``;
  const binds = project && project !== "*" ? [project] : [];
  const rows = (await env.DB.prepare(`SELECT id, bot, email, name, phone, marketing, sms, consented_at, consent_text, ip_hash, ua_hash, fp_hash, source, created_at, last_seen FROM id_users ${where} ORDER BY created_at DESC LIMIT ?`).bind(...binds, Math.min(Math.max(1, Number(limit) || 500), 5000)).all()).results || [];
  // Repeats in the last 24 h, across every bot: the same connection or device handing out addresses.
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const byIp = new Map(), byFp = new Map();
  for (const r of (await env.DB.prepare(`SELECT ip_hash, COUNT(DISTINCT email) n FROM id_users WHERE created_at >= ? AND ip_hash IS NOT NULL GROUP BY ip_hash`).bind(since).all()).results || []) byIp.set(r.ip_hash, r.n);
  for (const r of (await env.DB.prepare(`SELECT fp_hash, COUNT(DISTINCT email) n FROM id_users WHERE created_at >= ? AND fp_hash IS NOT NULL AND fp_hash != '' GROUP BY fp_hash`).bind(since).all()).results || []) byFp.set(r.fp_hash, r.n);
  const tour = await tourProgressMap(env);
  const out = rows.map((r) => {
    const domain = String(r.email || "").split("@")[1] || "";
    const marks = [];
    if (r.ip_hash && (byIp.get(r.ip_hash) || 0) >= IP_LIMIT) marks.push("many-from-ip");
    if (r.fp_hash && (byFp.get(r.fp_hash) || 0) >= DEVICE_LIMIT) marks.push("many-from-device");
    if (DISPOSABLE.has(domain)) marks.push("throwaway");
    if (!r.marketing && !r.sms) marks.push("no-consent");
    return { ...r, marketing: Boolean(r.marketing), sms: Boolean(r.sms), domain, marks, tour: tour[r.id] || null, sameIp24h: r.ip_hash ? byIp.get(r.ip_hash) || 0 : 0, sameDevice24h: r.fp_hash ? byFp.get(r.fp_hash) || 0 : 0 };
  });
  const totals = { all: out.length, marketing: out.filter((r) => r.marketing).length, sms: out.filter((r) => r.sms).length, withPhone: out.filter((r) => r.phone).length, flagged: out.filter((r) => r.marks.some((m) => m !== "no-consent")).length };
  return { enabled: true, rows: out, totals };
}

export async function signupsCsv(env, opts) {
  const { rows } = await listSignups(env, { ...opts, limit: 5000 });
  const cols = ["created_at", "bot", "email", "name", "phone", "marketing", "sms", "consented_at", "source", "marks", "same_ip_24h", "same_device_24h", "ip_hash", "fp_hash", "last_seen"];
  const q = (v) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [cols.join(",")].concat(rows.map((r) => [r.created_at, r.bot, r.email, r.name, r.phone, r.marketing ? "yes" : "no", r.sms ? "yes" : "no", r.consented_at, r.source, r.marks.join(" "), r.sameIp24h, r.sameDevice24h, r.ip_hash, r.fp_hash, r.last_seen].map(q).join(",")));
  return new Response(lines.join("\n") + "\n", { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="signups-${new Date().toISOString().slice(0, 10)}.csv"` } });
}
