// ============================================================================
//  THE TOUR — the five stops a visitor is walked through, and where they are.
//
//  A bot whose project.json has "tour": { "stops": [...] } is the guide (YourBots/tour).
//  The page draws a strip above the chat with the stops; stops are marked done by
//  what the person actually does (sent a message to a sample bot, tripped the
//  firewall, opened the code, clicked deploy or import, clicked the community),
//  kept on this browser AND, once they've signed up, on their row here — so the
//  Sign-ups tab shows how far each person got. That number is the funnel.
//
//    GET  /api/tour?bot=<guide>            → { stops, done, deploy: { allowed, url, why } }
//    POST /api/tour  { bot, stop }         → the same, after marking one stop
//
//  "Deploy your own" is for people on the allowlist (the guide bot's own list or
//  the deployment-wide one). Everyone else is shown the community instead.
// ============================================================================

import { identify } from "../identity/index.js";
import { isAllowed } from "./allowlist.js";
import { CONFIG } from "../../YourBots/config.js";

//  DEPLOY CODES. The owner makes a code under the hood (Sign-ups → Deploy codes), says who
//  it was given to, and hands it over in a DM. A code may be used by any number of email
//  addresses — that's fine, because every use is logged against the code, and the code
//  says who it was given to. Redeeming one unlocks Deploy for that person on this bot.
//    GET  /api/admin/deploy-codes                 the codes, with uses
//    POST /api/admin/deploy-codes  {issuedTo, note, maxUses}   make one
//    POST /api/admin/deploy-codes/<code>/disable  stop it
//    POST /api/tour  { bot, code }                a visitor redeems one
let SCHEMA_OK = false;
async function ensureSchema(env) {
  if (SCHEMA_OK || !env.DB) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS tour_progress (user_id TEXT NOT NULL, bot TEXT NOT NULL, json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (user_id, bot))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS deploy_codes (code TEXT PRIMARY KEY, issued_to TEXT, note TEXT, max_uses INTEGER, disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, created_by TEXT)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS deploy_code_uses (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, user_id TEXT NOT NULL, bot TEXT NOT NULL, email TEXT NOT NULL, ip_hash TEXT, created_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_dcu_code ON deploy_code_uses(code, id)`),
  ]);
  SCHEMA_OK = true;
}
// A key: PREFIX-1234-5678 — the prefix is the owner's (Settings → Workshop keys), the digits are
// random. Easy to read out, easy to type on a phone. Older KXXX-XXXX keys still work.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function newCode(prefix = "SO") { const p = String(prefix || "SO").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 6) || "SO"; const d = [...crypto.getRandomValues(new Uint8Array(8))].map((x) => x % 10).join(""); return `${p}-${d.slice(0, 4)}-${d.slice(4)}`; }
export const cleanCode = (c) => { const s = String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); const m = s.match(/^([A-Z]{1,6})(\d{4})(\d{4})$/); if (m) return `${m[1]}-${m[2]}-${m[3]}`; return s.replace(/^(.{4})(.{4})$/, "$1-$2"); };
const CODE_SHAPE = /^([A-Z]{1,6}-\d{4}-\d{4}|[A-Z2-9]{4}-[A-Z2-9]{4})$/;
export async function listCodes(env) {
  if (!env.DB) return [];
  await ensureSchema(env);
  const codes = (await env.DB.prepare(`SELECT * FROM deploy_codes ORDER BY created_at DESC LIMIT 500`).all()).results || [];
  const uses = (await env.DB.prepare(`SELECT code, COUNT(*) n, COUNT(DISTINCT email) people, MAX(created_at) last FROM deploy_code_uses GROUP BY code`).all()).results || [];
  const by = Object.fromEntries(uses.map((u) => [u.code, u]));
  return codes.map((c) => ({ ...c, disabled: Boolean(c.disabled), uses: by[c.code]?.n || 0, people: by[c.code]?.people || 0, lastUsed: by[c.code]?.last || null }));
}
export async function codeUses(env, code) {
  await ensureSchema(env);
  return (await env.DB.prepare(`SELECT email, bot, ip_hash, created_at FROM deploy_code_uses WHERE code = ? ORDER BY id DESC LIMIT 200`).bind(cleanCode(code)).all()).results || [];
}
export async function createCode(env, { issuedTo = "", note = "", maxUses = null, prefix = "SO" } = {}) {
  await ensureSchema(env);
  const code = newCode(prefix);
  await env.DB.prepare(`INSERT INTO deploy_codes (code, issued_to, note, max_uses, created_at, created_by) VALUES (?, ?, ?, ?, ?, 'admin')`).bind(code, String(issuedTo).slice(0, 120), String(note).slice(0, 300), Number.isFinite(Number(maxUses)) && Number(maxUses) > 0 ? Math.round(Number(maxUses)) : null, new Date().toISOString()).run();
  return code;
}
// A key on its own: active and under its cap? Used by the join route to let a second device in.
export async function keyIsActive(env, raw) {
  await ensureSchema(env);
  const code = cleanCode(raw); if (!CODE_SHAPE.test(code)) return null;
  const row = await env.DB.prepare(`SELECT * FROM deploy_codes WHERE code = ?`).bind(code).first();
  if (!row || row.disabled) return null;
  if (row.max_uses) { const n = (await env.DB.prepare(`SELECT COUNT(*) n FROM deploy_code_uses WHERE code = ?`).bind(code).first())?.n || 0; if (n >= row.max_uses) return null; }
  return row;
}
export async function noteKeyUse(env, code, user, bot) {
  await env.DB.prepare(`INSERT INTO deploy_code_uses (code, user_id, bot, email, ip_hash, created_at) VALUES (?, ?, ?, ?, '', ?)`).bind(cleanCode(code), user.id, bot, user.email, new Date().toISOString()).run();
}
export async function disableCode(env, code, on = true) { await ensureSchema(env); await env.DB.prepare(`UPDATE deploy_codes SET disabled = ? WHERE code = ?`).bind(on ? 1 : 0, cleanCode(code)).run(); }
// A visitor redeems a code: it has to exist, be on, and be under its cap. Every attempt that
// succeeds is logged with who used it; the unlock is written onto their tour row.
async function redeemCode(env, request, guide, user, raw) {
  const code = cleanCode(raw);
  if (!user) return { ok: false, reason: "Sign up first, then enter the code." };
  if (!CODE_SHAPE.test(code)) return { ok: false, reason: "That doesn't look like a key. It looks like SO-1234-5678." };
  const row = await env.DB.prepare(`SELECT * FROM deploy_codes WHERE code = ?`).bind(code).first();
  if (!row || row.disabled) return { ok: false, reason: "That code isn't active." };
  if (row.max_uses) { const n = (await env.DB.prepare(`SELECT COUNT(*) n FROM deploy_code_uses WHERE code = ?`).bind(code).first())?.n || 0; if (n >= row.max_uses) return { ok: false, reason: "That code has been used up." }; }
  const ip = request.headers.get("cf-connecting-ip") || "";
  const ipHash = ip ? [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("code|" + ip)))].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("") : "";
  await env.DB.prepare(`INSERT INTO deploy_code_uses (code, user_id, bot, email, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(code, user.id, guide.id, user.email, ipHash, new Date().toISOString()).run();
  console.log(JSON.stringify({ event: "deploy-code-used", code, issuedTo: row.issued_to, bot: guide.id }));
  return { ok: true, code, issuedTo: row.issued_to };
}
// The deploy button needs the public repo: from the links row (Settings) or the GITHUB_REPO secret. Never from a file in the repo.
export const deployUrl = (env, links) => {
  const code = links?.code || (env?.GITHUB_REPO || CONFIG.github?.repo ? `https://github.com/${env?.GITHUB_REPO || CONFIG.github.repo}` : "");
  return code ? `https://deploy.workers.cloudflare.com/?url=${code}` : "";
};

export async function tourState(env, request, guide, { stop = "", code = "", links = null, reset = false } = {}) {
  const stops = Array.isArray(guide?.tour?.stops) ? guide.tour.stops : [];
  let done = {}, user = null, redeemed = null;
  if (env.DB) {
    await ensureSchema(env);
    try { user = (await identify(request, env, guide)).user; } catch {}
    if (user) {
      const row = await env.DB.prepare(`SELECT json FROM tour_progress WHERE user_id = ? AND bot = ?`).bind(user.id, guide.id).first();
      try { done = row ? JSON.parse(row.json) || {} : {}; } catch { done = {}; }
      let changed = false;
      if (reset) { const keep = done.unlocked ? { unlocked: done.unlocked } : {}; done = keep; changed = true; }   // start the tour over; the key stays
      if (stop && stops.includes(stop) && !done[stop]) { done[stop] = new Date().toISOString(); changed = true; }
      if (code) {
        redeemed = await redeemCode(env, request, guide, user, code);
        if (redeemed.ok) { done.unlocked = { code: redeemed.code, at: new Date().toISOString() }; changed = true; }
      }
      if (changed) await env.DB.prepare(`INSERT INTO tour_progress (user_id, bot, json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, bot) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`).bind(user.id, guide.id, JSON.stringify(done), new Date().toISOString()).run();
    } else if (code) redeemed = { ok: false, reason: "Sign up first, then enter the code." };
  }
  // Deploy: a redeemed code, or on the guide's list, or the list for every bot.
  let deploy = { allowed: false, url: deployUrl(env, links), checklist: links?.checklist || "", why: "", code: done.unlocked?.code || null };
  if (user && env.DB) {
    if (done.unlocked) deploy.allowed = true;
    else { const a = await isAllowed(env, guide.id, user.email); const b = a.ok ? a : await isAllowed(env, "*", user.email); deploy.allowed = Boolean(b.ok); }
    if (!deploy.allowed) deploy.why = "The deploy walkthrough opens with your membership. Got a key? Enter it here.";
  } else deploy.why = "Sign up first. The deploy walkthrough opens with your membership.";
  if (!deploy.allowed) { deploy.url = ""; deploy.checklist = ""; }   // these only leave the server for someone who may deploy
  const { unlocked, ...stopsDone } = done;
  // The code and the prompt library: only for someone with a key (on the list, or a redeemed
  // code) — the same gate as deploy. Not in the page, not in the repo, not for the merely signed-up.
  const out = user && deploy.allowed ? { code: links?.code || "", prompts: links?.prompts || "" } : null;
  const c = CONFIG.community || {};
  return { stops, done: stopsDone, signedUp: Boolean(user), deploy, redeemed, links: out, community: c.show ? { name: c.name, url: c.url, pitch: c.pitch, workshopName: c.workshopName || "the workshop", workshopUrl: c.workshopUrl || c.url, workshopPitch: c.workshopPitch || "", dmName: c.dmName || "", dmUrl: c.dmUrl || "" } : null };
}

// For the Sign-ups tab: how far each person got, keyed by user id. { id: { n, of } }
export async function tourProgressMap(env) {
  if (!env.DB) return {};
  await ensureSchema(env);
  const out = {};
  for (const r of (await env.DB.prepare(`SELECT user_id, bot, json FROM tour_progress`).all()).results || []) {
    try { const { unlocked, ...d } = JSON.parse(r.json) || {}; out[r.user_id] = { n: Object.keys(d).length, bot: r.bot, stops: Object.keys(d), code: unlocked?.code || null }; } catch {}
  }
  return out;
}
