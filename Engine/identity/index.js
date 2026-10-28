// ============================================================================
//  IDENTITY — one front door, shared by every kind of bot.
//
//  identify(request, env, bot) answers "who is this browser?" for a bot:
//    { keyHash, user | null, pending | null }
//  The methods, in the order the join screen offers them (docs/IDENTITY.md):
//    1. passkey                (passkeys.js)  — the phone's own lock, proves it's the same person
//    2. Google/Microsoft/Apple (idtoken.js)   — the provider proves the email
//    3. email + device key     (devices.js)   — always on; the first device just joins
//    4. a second device:  authenticator code (totp.js)  or  the owner's link (devices.js)
//  Routes here, all JSON, device key in x-device-key, the bot id in the body:
//    POST /api/id/passkey/register/options   {bot}                         → options for navigator.credentials.create
//    POST /api/id/passkey/register           {bot, challenge, id, response} → { ok }
//    POST /api/id/passkey/login/options      {bot}                         → options for navigator.credentials.get
//    POST /api/id/passkey/login              {bot, challenge, id, response} → { linked: true } (this device is bound)
//    POST /api/id/totp/setup                 {bot}                         → { secret, uri }  (known device only)
//    POST /api/id/totp/confirm               {bot, code}                   → { ok }
//    POST /api/id/totp/link                  {bot, email, code}            → { linked: true } (an unknown device, six digits)
//    GET  /api/id/methods?bot=<id>                                          → what's on for this bot, and for this device
//    POST /api/id/join                       {bot, email}                  → { linked: true, email } (first device, or a second one
//                                                                            inside the return window — devices.js)
//                                                                            or { linked: false, code, email } (a second device: the
//                                                                            owner links it with the code, or a passkey / six digits do)
//    GET  /api/id/me?bot=<id>                                               → { linked, email } or { linked: false, pending: {code, email} }
//  join/me are what a CHAT bot in "email" mode uses (Engine/worker/index.js); Plate has its
//  own join under /api/apps/<id>/ because it also creates the person's targets row.
//  Never an email is sent. Nothing here can be "reset by email".
// ============================================================================

import { deviceHash, userForDevice, userById, userByEmail, pendingFor, bindDevice, cleanEmail, ensureIdentitySchema, nowIso, deviceCount, join as joinDevice, linkByCode, touch, cleanGrace, DEFAULT_GRACE_MINUTES, recordSignup, cleanPhone, pepperOf, adoptDevice } from "./devices.js";
import { SIGNUP_BUILT_IN } from "../worker/settings.js";
import { redeemInvite } from "../worker/allowlist.js";
import { DISPOSABLE } from "../worker/signups.js";
import { keyIsActive, noteKeyUse } from "../worker/tour.js";

// Is this an email someone actually reads? Three checks, cheapest first:
//   1. the domain looks like a domain and isn't a throwaway (if the gate says so)
//   2. a typo of a big provider → say what they probably meant
//   3. the domain accepts mail: an MX (or A) lookup over DNS-over-HTTPS, two seconds, fails OPEN —
//      a DNS hiccup must never keep a real person out
const TYPOS = { "gmial.com": "gmail.com", "gmal.com": "gmail.com", "gamil.com": "gmail.com", "gmail.co": "gmail.com", "gmail.cm": "gmail.com", "gnail.com": "gmail.com", "gmaill.com": "gmail.com", "hotmal.com": "hotmail.com", "hotmial.com": "hotmail.com", "hotmail.co": "hotmail.com", "yaho.com": "yahoo.com", "yahooo.com": "yahoo.com", "yahoo.co": "yahoo.com", "outlok.com": "outlook.com", "outllok.com": "outlook.com", "iclod.com": "icloud.com", "icloud.co": "icloud.com", "protonmai.com": "protonmail.com" };
const MX_CACHE = new Map();
async function domainAcceptsMail(domain) {
  const hit = MX_CACHE.get(domain); if (hit && Date.now() - hit.at < 6 * 3600 * 1000) return hit.ok;
  let ok = true;
  try {
    const q = async (type) => { const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(2000) }); const j = await r.json(); return { status: j.Status, answers: (j.Answer || []).length }; };
    const mx = await q("MX");
    if (mx.status === 3) ok = false;                                            // NXDOMAIN: the domain doesn't exist
    else if (mx.status === 0 && mx.answers === 0) { const a = await q("A"); ok = !(a.status === 0 && a.answers === 0 && (await q("AAAA")).answers === 0); }   // no MX: mail may still land on the A record
  } catch { ok = true; }
  MX_CACHE.set(domain, { ok, at: Date.now() });
  return ok;
}
async function checkEmailReal(email, su) {
  const domain = email.split("@")[1] || "";
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) || domain.includes("..")) return { ok: false, reason: "That doesn't look like a real email address." };
  const local = email.split("@")[0];
  if (/^(test|asdf|qwerty|abc|xyz|aaa|none|no|fake|spam|nope)\d*$/.test(local) && /^(test|example|fake|asdf|abc|xyz|email|mail|domain)\.(com|net|org)$/.test(domain)) return { ok: false, reason: "Please use an email you actually read — that's where the good stuff goes." };
  if (TYPOS[domain]) return { ok: false, reason: `Did you mean ${local}@${TYPOS[domain]}?` };
  if (su.blockThrowaway && DISPOSABLE.has(domain)) return { ok: false, reason: "Throwaway addresses don't work here. Use one you'll keep." };
  if (su.checkMx && !(await domainAcceptsMail(domain))) return { ok: false, reason: `${domain} doesn't seem to accept email. Check the spelling.` };
  return { ok: true };
}

// A short keyed hash: sixteen hex characters of SHA-256 over the pepper and the value.
// Enough to group repeats in the Sign-ups view, not enough to get the value back.
async function hashOf(env, value) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pepperOf(env) + "|" + String(value || "")));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}
// The gate's own rules on a FRESH sign-up. Returns { ok, error, reason } or the cleaned fields.
function checkSignup(su, body) {
  const name = String(body.name || "").trim().slice(0, 80);
  if (su.askName === "required" && !name) return { ok: false, error: "name", reason: "Please add your name." };
  const phoneRaw = String(body.phone || "").trim();
  const phone = su.askPhone === "off" ? "" : cleanPhone(phoneRaw);
  if (su.askPhone === "required" && !phone) return { ok: false, error: "phone", reason: phoneRaw ? "That doesn't look like a mobile number. Include the area code." : "Please add a mobile number we can text." };
  if (su.askPhone === "optional" && phoneRaw && !phone) return { ok: false, error: "phone", reason: "That doesn't look like a mobile number. Include the area code, or leave it blank." };
  const marketing = su.marketing.show ? Boolean(body.marketing) : false;
  if (su.marketing.show && su.marketing.required && !marketing) return { ok: false, error: "marketing", reason: "Please tick the box to continue." };
  const sms = su.sms.show && phone ? Boolean(body.sms) : false;
  if (su.sms.show && su.sms.required && phone && !sms) return { ok: false, error: "sms", reason: "Please tick the texting box to continue." };
  const consent_text = [marketing ? "[x] " + su.marketing.text : su.marketing.show ? "[ ] " + su.marketing.text : "", sms ? "[x] " + su.sms.text : su.sms.show ? "[ ] " + su.sms.text : "", su.privacyLine].filter(Boolean).join("\n");
  return { ok: true, name: su.askName === "off" ? "" : name, phone, marketing, sms, consent_text };
}
// Tell the owner's list tool. Best effort, four seconds, never blocks the join.
async function signupWebhook(url, payload) {
  if (!url) return;
  try { await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(4000) }); }
  catch (err) { console.warn("signup webhook failed", err?.message || err); }
}
export { linkByCode, cleanGrace, DEFAULT_GRACE_MINUTES };
import { verifyRegistration, verifyAssertion, randomChallenge } from "./passkeys.js";
import { newSecret, totp, verifyTotp, otpauthUri } from "./totp.js";

export { verifyIdToken, SIGNIN_PROVIDERS } from "./idtoken.js";
export { totp, verifyTotp };

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

// Who is this browser, for this bot? Fails closed: no key, malformed key, unknown key → user null.
// A known person gets their last_seen bumped: that is what the return window measures.
export async function identify(request, env, bot) {
  await ensureIdentitySchema(env);
  const keyHash = await deviceHash(request);
  // Known here? If not, known on another bot of this deployment? One sign-up, every bot.
  let user = keyHash ? await userForDevice(env, bot.id, keyHash) : null;
  if (!user && keyHash) { try { user = await adoptDevice(env, bot.id, keyHash); } catch (err) { console.warn("adopt failed", err?.message || err); } }
  if (user) touch(env, user);
  const pending = user ? null : await pendingFor(env, bot.id, keyHash);
  return { keyHash, user, pending };
}

// The return window for a bot: the bot's own number, else the deployment's (settings), else 60.
export function graceMinutesFor(bot, globalMinutes) {
  const own = bot?.identity?.graceMinutes;
  return cleanGrace(own !== undefined && own !== null && own !== "" ? own : globalMinutes);
}

// The methods a bot has switched on. What the join screen draws, and what Settings lists.
export function signInMethods(bot, env = {}) {
  const f = bot.food || {};
  const providers = (Array.isArray(f.signIn) ? f.signIn : []).map((s) => ({ provider: s.provider, clientId: s.clientId || env[`${String(s.provider).toUpperCase()}_CLIENT_ID`] || "" })).filter((s) => s.clientId);
  return {
    passkeys: f.passkeys !== false,
    providers,                                  // [{ provider, clientId }] — only the ones with a client id
    device: true,                               // email + device key: always
    totp: f.totp !== false,
    ownerLink: true,                            // the coach's / owner's code
  };
}

// rpId for WebAuthn = the host the page was served from. A custom domain later
// changes it, and every passkey made under the old host stops working — that is
// how WebAuthn is designed, not a bug here (docs/IDENTITY.md).
function rpOf(request) { const u = new URL(request.url); return { id: u.hostname, origin: u.origin }; }

// --- The admin's second factor. ADMIN_TOTP_SECRET set → /api/admin/unlock needs {passphrase, code}.
export const adminNeedsCode = (env) => Boolean(env.ADMIN_TOTP_SECRET);
export async function adminCodeOk(env, code) {
  if (!env.ADMIN_TOTP_SECRET) return true;
  try { return (await verifyTotp(env.ADMIN_TOTP_SECRET, String(code || ""), { window: 1 })).ok; } catch { return false; }
}

// --- The routes. `bot` is already resolved by the caller; `allowed` is the rate limiter. ----
export async function handleIdentity(request, env, url, { bot, allowed = async () => true, unlockAllowed = async () => true, graceMinutes = DEFAULT_GRACE_MINUTES, signup = SIGNUP_BUILT_IN }) {
  if (!env.DB) return json({ error: "Identity needs the D1 database (wrangler.jsonc → d1_databases)." }, 503);
  await ensureIdentitySchema(env);
  const path = url.pathname.slice("/api/id/".length);
  const methods = signInMethods(bot, env);
  const keyHash = await deviceHash(request);
  let me = keyHash ? await userForDevice(env, bot.id, keyHash) : null;
  if (!me && keyHash) { try { me = await adoptDevice(env, bot.id, keyHash); } catch {} }

  if (path === "methods") {
    let totpSet = false, passkeys = 0;
    if (me) {
      totpSet = Boolean((await env.DB.prepare(`SELECT confirmed FROM id_totp WHERE user_id = ?`).bind(me.id).first())?.confirmed);
      passkeys = (await env.DB.prepare(`SELECT COUNT(*) n FROM id_passkeys WHERE user_id = ?`).bind(me.id).first())?.n || 0;
    }
    return json({ bot: bot.id, ...methods, providers: methods.providers.map((p) => p.provider), me: me ? { totp: totpSet, passkeys, devices: await deviceCount(env, me.id) } : null });
  }
  if (path === "me") {
    if (me) return json({ linked: true, email: me.email, name: me.name || "" });
    const pending = keyHash ? await pendingFor(env, bot.id, keyHash) : null;
    return json({ linked: false, pending: pending ? { code: pending.code, email: pending.email } : null });
  }
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  if (!keyHash) return json({ error: "no device key", reason: "This browser didn't send a device key. Reload the page." }, 400);
  if (!(await allowed(env, request))) return json({ error: "rate-limited", reason: "Too many tries. Give it a minute." }, 429);
  let body = {}; try { body = (await request.json()) || {}; } catch {}
  const rp = rpOf(request);

  try {
    // ---- ERASE: everything about this person, on every bot of this deployment, right now. ----
    //   Their chats (which is where an attached file's text lives), their sign-up rows, their
    //   devices, passkeys, authenticator, tour progress, lead summaries. The owner's audit log
    //   keeps its rows (asked/answered, no files); a deploy-code use keeps the code but loses the
    //   email. A demo where people upload their own material owes them this button.
    if (path === "erase") {
      if (!me) return json({ error: "unknown device", reason: "This browser isn't signed in." }, 401);
      const people = (await env.DB.prepare(`SELECT id, bot FROM id_users WHERE email = ?`).bind(me.email).all()).results || [];
      const ids = people.map((p) => p.id);
      const ops = [];
      const del = (sql, ...b) => ops.push(env.DB.prepare(sql).bind(...b));
      for (const id of ids) {
        del(`DELETE FROM chat_threads WHERE user_id = ?`, id);
        del(`DELETE FROM tour_progress WHERE user_id = ?`, id);
        del(`DELETE FROM id_devices WHERE user_id = ?`, id);
        del(`DELETE FROM id_passkeys WHERE user_id = ?`, id);
        del(`DELETE FROM id_totp WHERE user_id = ?`, id);
        del(`UPDATE deploy_code_uses SET email = 'erased' WHERE user_id = ?`, id);
      }
      del(`DELETE FROM id_pending WHERE email = ?`, me.email);
      del(`DELETE FROM leads WHERE visitor = ?`, me.email);
      del(`DELETE FROM id_users WHERE email = ?`, me.email);
      let erased = 0;
      for (const op of ops) { try { await op.run(); erased++; } catch (err) { /* a table that doesn't exist yet on this deployment: nothing to erase there */ } }
      console.log(JSON.stringify({ event: "visitor-erase", bots: people.map((p) => p.bot), statements: erased }));
      return json({ ok: true, bots: people.length });
    }

    // ---- INVITE: a code the owner handed out. This person, already joined by email, goes on the list. ----
    if (path === "invite") {
      if (!me) return json({ error: "who", reason: "Sign in with your email first, then use the invite code." }, 401);
      const r = await redeemInvite(env, { bot: bot.id, email: me.email, code: body.code });
      if (!r.ok) return json({ error: "invite", reason: r.reason }, 403);
      console.log(JSON.stringify({ event: "invite-redeemed", bot: bot.id, code: r.code, scope: r.scope }));
      return json({ ok: true, scope: r.scope, until: r.until });
    }
    // ---- JOIN: email + this device. The first device just joins; a second one waits for a link. ----
    if (path === "join") {
      const email = cleanEmail(body.email);
      if (!email) return json({ error: "email", reason: "That doesn't look like an email address." }, 400);
      if (me && me.email !== email) return json({ error: "different person", reason: "This browser is already linked to a different email. Sign out first." }, 409);
      // A NEW person meets the gate's rules (name, number, the boxes). Someone already
      // signed up on another device only has to prove it's them, so the rules don't re-run.
      const fresh = !(await userByEmail(env, bot.id, email));
      const gate = fresh ? checkSignup(signup, body) : { ok: true };
      if (!gate.ok) return json({ error: gate.error, reason: gate.reason }, 400);
      if (fresh) { const real = await checkEmailReal(email, signup); if (!real.ok) return json({ error: "email", reason: real.reason }, 400); }
      const r = await joinDevice(env, bot.id, { email, keyHash, graceMinutes });
      if (r.linked && r.fresh) {
        const now = nowIso();
        const ip = request.headers.get("cf-connecting-ip") || "";
        const rec = {
          name: gate.name, phone: gate.phone, marketing: gate.marketing, sms: gate.sms, consented_at: now, consent_text: gate.consent_text,
          ip_hash: ip ? await hashOf(env, ip) : "", ua_hash: await hashOf(env, (request.headers.get("user-agent") || "") + "|" + (request.headers.get("accept-language") || "")),
          fp_hash: body.fp ? await hashOf(env, String(body.fp).slice(0, 400)) : "", source: String(body.source || "").slice(0, 80),
        };
        try { await recordSignup(env, bot.id, r.user.id, rec); } catch (err) { console.warn("recordSignup failed", err?.message || err); }
        console.log(JSON.stringify({ event: "signup", bot: bot.id, marketing: rec.marketing, sms: rec.sms, phone: Boolean(rec.phone), ip_hash: rec.ip_hash, fp_hash: rec.fp_hash }));
        await signupWebhook(signup.webhook, { event: "signup", bot: { id: bot.id, name: bot.name }, when: now, email, name: rec.name, phone: rec.phone, marketing: rec.marketing, sms: rec.sms, consent_text: rec.consent_text, source: rec.source, ip_hash: rec.ip_hash, fp_hash: rec.fp_hash, country: request.headers.get("cf-ipcountry") || "" });
      }
      if (r.linked) return json({ ok: true, linked: true, email: r.user.email, name: (r.fresh ? gate.name : r.user.name) || "", fresh: Boolean(r.fresh), ...(r.grace ? { grace: true } : {}) });
      // A second device holding a live workshop key: the key is proof enough. Link it now, no owner needed.
      if (body.key) {
        const k = await keyIsActive(env, String(body.key));
        if (!k) return json({ ok: true, linked: false, code: r.code, email: r.email, keyRejected: true, reason: "That key isn't active. Wait for the owner, or use a different email." });
        const existing = await userByEmail(env, bot.id, email);
        const user = await bindDevice(env, bot.id, { userId: existing.id, email, keyHash, label: "workshop key" });
        try { await noteKeyUse(env, k.code, user, bot.id); } catch {}
        console.log(JSON.stringify({ event: "identity-join-key", bot: bot.id, code: k.code, issuedTo: k.issued_to }));
        return json({ ok: true, linked: true, email: user.email, name: user.name || "", byKey: true });
      }
      return json({ ok: true, linked: false, code: r.code, email: r.email, reason: "This email is already in use on another device. The owner can link this one with the code." });
    }

    // ---- PASSKEYS ------------------------------------------------------------------
    if (path.startsWith("passkey/")) {
      if (!methods.passkeys) return json({ error: "passkeys are off for this bot" }, 404);
      if (path === "passkey/register/options") {
        if (!me) return json({ error: "unknown device", reason: "Join with your email first; then set up a passkey." }, 401);
        const challenge = await newChallenge(env, bot.id, "register", { userId: me.id, keyHash });
        return json({
          challenge, rp: { id: rp.id, name: bot.name }, user: { id: me.id, name: me.email, displayName: me.email },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
          authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" }, attestation: "none", timeout: 120000,
          excludeCredentials: ((await env.DB.prepare(`SELECT credential_id FROM id_passkeys WHERE user_id = ?`).bind(me.id).all()).results || []).map((r) => ({ type: "public-key", id: r.credential_id })),
        });
      }
      if (path === "passkey/register") {
        if (!me) return json({ error: "unknown device" }, 401);
        const c = await takeChallenge(env, bot.id, "register", body.challenge);
        if (!c || c.user_id !== me.id) return json({ error: "refused", reason: "That request expired or wasn't yours. Try again." }, 401);
        const v = await verifyRegistration({ clientDataJSON: body.response?.clientDataJSON, attestationObject: body.response?.attestationObject, expectedChallenge: c.challenge, expectedOrigin: rp.origin, rpId: rp.id });
        if (!v.ok) { console.warn("passkey register refused", v.reason); return json({ error: "refused", reason: `Passkey refused: ${v.reason}.` }, 401); }
        await env.DB.prepare(`INSERT OR REPLACE INTO id_passkeys (credential_id, bot, user_id, public_key, alg, counter, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(v.credentialId, bot.id, me.id, JSON.stringify(v.publicKey), v.alg, v.counter, String(body.label || "passkey").slice(0, 60), nowIso()).run();
        console.log(JSON.stringify({ event: "passkey-registered", bot: bot.id, userId: me.id.slice(0, 8), alg: v.alg }));
        return json({ ok: true, credentialId: v.credentialId, alg: v.alg });
      }
      if (path === "passkey/login/options") {
        const challenge = await newChallenge(env, bot.id, "login", { keyHash });
        return json({ challenge, rpId: rp.id, userVerification: "preferred", timeout: 120000, allowCredentials: [] });
      }
      if (path === "passkey/login") {
        const c = await takeChallenge(env, bot.id, "login", body.challenge);
        if (!c || c.key_hash !== keyHash) return json({ error: "refused", reason: "That request expired or came from another browser. Try again." }, 401);
        const row = await env.DB.prepare(`SELECT * FROM id_passkeys WHERE credential_id = ? AND bot = ?`).bind(String(body.id || ""), bot.id).first();
        if (!row) return json({ error: "refused", reason: "No passkey with that id here." }, 401);
        let publicKey; try { publicKey = JSON.parse(row.public_key); } catch { return json({ error: "refused", reason: "stored key unreadable" }, 401); }
        const v = await verifyAssertion({ clientDataJSON: body.response?.clientDataJSON, authenticatorData: body.response?.authenticatorData, signature: body.response?.signature, expectedChallenge: c.challenge, expectedOrigin: rp.origin, rpId: rp.id, publicKey, alg: row.alg, storedCounter: Number(row.counter) || 0 });
        if (!v.ok) { console.warn("passkey login refused", v.reason); return json({ error: "refused", reason: `Passkey refused: ${v.reason}.` }, 401); }
        const user = await userById(env, bot.id, row.user_id);
        if (!user) return json({ error: "refused", reason: "That passkey's person is gone." }, 401);
        if (me && me.id !== user.id) return json({ error: "different person", reason: "This browser is already linked to a different email." }, 409);
        await env.DB.prepare(`UPDATE id_passkeys SET counter = ?, last_used = ? WHERE credential_id = ?`).bind(v.counter, nowIso(), row.credential_id).run();
        await bindDevice(env, bot.id, { userId: user.id, email: user.email, keyHash, label: "linked with a passkey" });
        console.log(JSON.stringify({ event: "passkey-login", bot: bot.id, userId: user.id.slice(0, 8) }));
        return json({ ok: true, linked: true, userId: user.id, email: user.email });
      }
    }
    // ---- AUTHENTICATOR APP (TOTP) ---------------------------------------------------
    if (path.startsWith("totp/")) {
      if (!methods.totp) return json({ error: "authenticator codes are off for this bot" }, 404);
      if (path === "totp/setup") {
        if (!me) return json({ error: "unknown device", reason: "Join with your email first." }, 401);
        // A confirmed authenticator is never replaced by accident: a second device pressing
        // "Set up" would otherwise silently break the codes on the phone that already works.
        // The page sends { replace: true } only after the person has said so.
        const have = await env.DB.prepare(`SELECT confirmed FROM id_totp WHERE user_id = ?`).bind(me.id).first();
        if (have?.confirmed && body.replace !== true) return json({ error: "already set up", confirmed: true, reason: "An authenticator app is already set up for this email. Replacing it stops the old app's codes working." }, 409);
        const secret = newSecret();
        await env.DB.prepare(`INSERT OR REPLACE INTO id_totp (user_id, bot, secret, confirmed, created_at) VALUES (?, ?, ?, 0, ?)`).bind(me.id, bot.id, secret, nowIso()).run();
        return json({ ok: true, secret, uri: otpauthUri({ secret, label: me.email, issuer: bot.name }) });
      }
      if (path === "totp/confirm") {
        if (!me) return json({ error: "unknown device" }, 401);
        const row = await env.DB.prepare(`SELECT secret FROM id_totp WHERE user_id = ?`).bind(me.id).first();
        if (!row) return json({ error: "not set up", reason: "Press Set up first." }, 400);
        if (!(await unlockAllowed(env, request))) return json({ error: "rate-limited", reason: "Too many codes. Wait a minute." }, 429);
        const v = await verifyTotp(row.secret, body.code);
        if (!v.ok) return json({ error: "wrong code", reason: "That code didn't match. Check the phone's clock and try the next one." }, 401);
        await env.DB.prepare(`UPDATE id_totp SET confirmed = 1 WHERE user_id = ?`).bind(me.id).run();
        return json({ ok: true, confirmed: true });
      }
      if (path === "totp/link") {
        if (me) return json({ ok: true, linked: true, userId: me.id, email: me.email });       // already in
        if (!(await unlockAllowed(env, request))) return json({ error: "rate-limited", reason: "Too many codes. Wait a minute." }, 429);
        const email = cleanEmail(body.email);
        if (!email) return json({ error: "email", reason: "That doesn't look like an email address." }, 400);
        const user = await userByEmail(env, bot.id, email);
        const row = user ? await env.DB.prepare(`SELECT secret, confirmed FROM id_totp WHERE user_id = ?`).bind(user.id).first() : null;
        // One answer for "no such person", "no authenticator" and "wrong code": nothing to learn from it.
        const v = row?.confirmed ? await verifyTotp(row.secret, body.code) : { ok: false };
        if (!v.ok) return json({ error: "wrong code", reason: "That code didn't match, or this email has no authenticator set up." }, 401);
        await bindDevice(env, bot.id, { userId: user.id, email, keyHash, label: "linked with an authenticator code" });
        console.log(JSON.stringify({ event: "totp-link", bot: bot.id, userId: user.id.slice(0, 8) }));
        return json({ ok: true, linked: true, userId: user.id, email });
      }
    }
  } catch (err) {
    console.error("identity request failed — refusing", err?.message || err);
    return json({ error: "refused", reason: "Something went wrong checking that. Nothing was linked." }, 401);
  }
  return json({ error: "not found" }, 404);
}

async function newChallenge(env, bot, kind, { userId = null, keyHash = null } = {}) {
  const challenge = randomChallenge();
  await env.DB.prepare(`DELETE FROM id_challenges WHERE expires_at < ?`).bind(nowIso()).run();
  await env.DB.prepare(`INSERT INTO id_challenges (challenge, bot, kind, user_id, key_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(challenge, bot, kind, userId, keyHash, new Date(Date.now() + CHALLENGE_TTL_MS).toISOString()).run();
  return challenge;
}
// A challenge is answered once: read it, delete it, and only honour it if it hasn't expired.
async function takeChallenge(env, bot, kind, challenge) {
  challenge = String(challenge || "");
  if (!challenge) return null;
  const row = await env.DB.prepare(`SELECT * FROM id_challenges WHERE challenge = ? AND bot = ? AND kind = ?`).bind(challenge, bot, kind).first();
  if (row) await env.DB.prepare(`DELETE FROM id_challenges WHERE challenge = ?`).bind(challenge).run();
  return row && row.expires_at > nowIso() ? row : null;
}
