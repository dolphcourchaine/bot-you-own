// ============================================================================
//  IDENTITY — email + device key. The base every other method builds on.
//
//  In plain English:
//   · A person types their email once. Their browser makes a random 32-byte
//     DEVICE KEY, keeps it in localStorage, and sends it with every request in
//     the x-device-key header. The server keeps only the SHA-256 of that key.
//     That's the whole login: "remembered forever on this browser", no passwords.
//   · The user id is SHA-256(email + FOODLOG_PEPPER + bot id). Same email, same
//     id, on any device — but knowing an email does NOT open anything.
//   · A SECOND browser typing the same email is NOT let in. It gets a
//     6-character code and waits. It gets linked by: a passkey, a Google/
//     Microsoft/Apple sign-in, the six digits from an authenticator app, or the
//     owner (coach) typing the code in. Each of those is its own file here.
//   · THE RETURN WINDOW (v3.9): the one exception. If the same email was active
//     within the last N minutes (YourBots/config.js → identity.graceMinutes,
//     default 60; a bot can set its own in project.json → identity), a new
//     browser typing it is trusted at once — no code — and its history follows.
//     So "I closed my laptop and opened my phone" just works. The trade-off, in
//     one line: inside that window anyone who knows your email can pick up your
//     recent conversation from their own computer. 0 turns it off; passkeys and
//     provider sign-in are trusted on any device with or without it.
//   · Every table carries a `bot` column, so two apps on one deployment keep
//     their people apart: joining "plate" says nothing about "plate-two".
//   · Identity fails CLOSED: a bad or missing device key is a 401, always.
// ============================================================================

export const DEV_PEPPER = "dev-pepper-change-me";     // used only when FOODLOG_PEPPER is unset; the log warns
const DEVICE_KEY_RE = /^[0-9a-f]{64}$/;
const EMAIL_SHAPE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const PENDING_TTL_MS = 7 * 864e5;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // no 0/O/1/I: survives being read out loud

export const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
export async function sha256hex(text) { return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)))); }
export const nowIso = () => new Date().toISOString();
export function cleanEmail(e) { e = String(e || "").trim().toLowerCase().slice(0, 254); return EMAIL_SHAPE.test(e) ? e : ""; }
export function randomCode(n = 6) { const b = crypto.getRandomValues(new Uint8Array(n)); return [...b].map((x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join(""); }
export const pepperOf = (env) => env.FOODLOG_PEPPER || DEV_PEPPER;
// An existing row wins: people who joined before the pepper was set (or changed) keep their id,
// otherwise a new device hashes to a fresh id, the insert hits idx_id_users_bot_email, and join 500s.
export async function userIdFor(email, env, bot) {
  const prior = env.DB ? await env.DB.prepare(`SELECT id FROM id_users WHERE bot = ? AND email = ?`).bind(bot, email).first() : null;
  return prior?.id || sha256hex(`${email}\n${pepperOf(env)}\n${bot}`);
}

// --- The tables. Created on first use, like the rest of the Worker (Engine/schema.sql lists them too).
let SCHEMA_OK = false;
export async function ensureIdentitySchema(env) {
  if (SCHEMA_OK || !env.DB) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS id_users (id TEXT PRIMARY KEY, bot TEXT NOT NULL, email TEXT NOT NULL, created_at TEXT NOT NULL, last_seen TEXT, access_until TEXT)`),
    env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_id_users_bot_email ON id_users(bot, email)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS id_devices (key_hash TEXT NOT NULL, bot TEXT NOT NULL, user_id TEXT NOT NULL, label TEXT, created_at TEXT NOT NULL, PRIMARY KEY (key_hash, bot))`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_id_devices_user ON id_devices(user_id)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS id_pending (code TEXT PRIMARY KEY, bot TEXT NOT NULL, key_hash TEXT NOT NULL, email TEXT NOT NULL, created_at TEXT NOT NULL)`),
    // passkeys: one row per credential. public_key is a JWK; counter guards against a cloned authenticator.
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS id_passkeys (credential_id TEXT PRIMARY KEY, bot TEXT NOT NULL, user_id TEXT NOT NULL, public_key TEXT NOT NULL, alg TEXT NOT NULL, counter INTEGER DEFAULT 0, label TEXT, created_at TEXT NOT NULL, last_used TEXT)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_id_passkeys_user ON id_passkeys(user_id)`),
    // challenges: what we asked the browser to sign, 5 minutes to answer, used once.
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS id_challenges (challenge TEXT PRIMARY KEY, bot TEXT NOT NULL, kind TEXT NOT NULL, user_id TEXT, key_hash TEXT, expires_at TEXT NOT NULL)`),
    // authenticator app (TOTP): one secret per user; confirmed = they typed a right code once.
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS id_totp (user_id TEXT PRIMARY KEY, bot TEXT NOT NULL, secret TEXT NOT NULL, confirmed INTEGER DEFAULT 0, created_at TEXT NOT NULL)`),
  ]);
  // The sign-up columns (v3.12). SQLite has no ADD COLUMN IF NOT EXISTS: look first.
  try {
    const have = new Set(((await env.DB.prepare(`PRAGMA table_info(id_users)`).all()).results || []).map((c) => c.name));
    const want = [["name", "TEXT"], ["phone", "TEXT"], ["marketing", "INTEGER"], ["sms", "INTEGER"], ["consented_at", "TEXT"], ["consent_text", "TEXT"], ["ip_hash", "TEXT"], ["ua_hash", "TEXT"], ["fp_hash", "TEXT"], ["source", "TEXT"]];
    for (const [col, decl] of want) if (!have.has(col)) await env.DB.prepare(`ALTER TABLE id_users ADD COLUMN ${col} ${decl}`).run();
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_id_users_created ON id_users(created_at)`).run();
  } catch (err) { console.warn("sign-up columns not added (sign-ups will store email only)", err?.message || err); }
  SCHEMA_OK = true;
}

// The device key from the request → its hash, or null when it's missing or malformed.
export async function deviceHash(request) {
  const k = String(request.headers.get("x-device-key") || "");
  return DEVICE_KEY_RE.test(k) ? sha256hex(k) : null;
}

// The same browser on ANY bot of this deployment: one sign-up covers every bot.
export async function userForDeviceAnyBot(env, keyHash) {
  if (!keyHash) return null;
  return (await env.DB.prepare(`SELECT u.* FROM id_devices d JOIN id_users u ON u.id = d.user_id AND u.bot = d.bot WHERE d.key_hash = ? ORDER BY u.created_at LIMIT 1`).bind(keyHash).first()) || null;
}
// A browser already signed up on another bot joins this one silently: same email, same
// device, and the sign-up record (name, number, what they ticked, the hashes) comes along.
export async function adoptDevice(env, bot, keyHash, graceMinutes = DEFAULT_GRACE_MINUTES) {
  const other = await userForDeviceAnyBot(env, keyHash);
  if (!other || other.bot === bot) return null;
  // A browser already trusted on one bot is trusted on the others: no waiting, whatever the return window says.
  const r = await join(env, bot, { email: other.email, keyHash, graceMinutes: ALWAYS });
  if (!r.linked) return null;
  if (r.fresh) { try { await recordSignup(env, bot, r.user.id, { ...other, consented_at: other.consented_at, source: other.source }); } catch {} }
  console.log(JSON.stringify({ event: "identity-adopt", from: other.bot, to: bot }));
  return userById(env, bot, r.user.id);
}
export async function userForDevice(env, bot, keyHash) {
  if (!keyHash) return null;
  const r = await env.DB.prepare(`SELECT u.* FROM id_devices d JOIN id_users u ON u.id = d.user_id WHERE d.key_hash = ? AND d.bot = ?`).bind(keyHash, bot).first();
  return r || null;
}
export async function userById(env, bot, id) { return (await env.DB.prepare(`SELECT * FROM id_users WHERE id = ? AND bot = ?`).bind(id, bot).first()) || null; }
export async function userByEmail(env, bot, email) { return (await env.DB.prepare(`SELECT * FROM id_users WHERE bot = ? AND email = ?`).bind(bot, email).first()) || null; }
export function touch(env, user) { env.DB.prepare(`UPDATE id_users SET last_seen = ? WHERE id = ?`).bind(nowIso(), user.id).run().catch(() => {}); }
export async function deviceCount(env, userId) { return (await env.DB.prepare(`SELECT COUNT(*) n FROM id_devices WHERE user_id = ?`).bind(userId).first())?.n || 0; }
export async function listDevices(env, userId) { return (await env.DB.prepare(`SELECT label, created_at FROM id_devices WHERE user_id = ? ORDER BY created_at`).bind(userId).all()).results || []; }

// Make the user row if it's new, and bind this device to it. The one write every method ends with.
export async function bindDevice(env, bot, { userId, email, keyHash, label }) {
  const now = nowIso();
  const ops = [
    env.DB.prepare(`INSERT OR IGNORE INTO id_users (id, bot, email, created_at, last_seen) VALUES (?, ?, ?, ?, ?)`).bind(userId, bot, email, now, now),
    // A device already bound to a real person stays theirs; one bound to an id with no user row
    // (left by the pre-5ee4d36 pepper bug) is re-pointed, or /me and /day 401 while /join says linked.
    env.DB.prepare(`INSERT INTO id_devices (key_hash, bot, user_id, label, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key_hash, bot) DO UPDATE SET user_id = excluded.user_id, label = excluded.label
      WHERE id_devices.user_id NOT IN (SELECT id FROM id_users)`).bind(keyHash, bot, userId, String(label || "device").slice(0, 60), now),
    env.DB.prepare(`DELETE FROM id_pending WHERE key_hash = ? AND bot = ?`).bind(keyHash, bot),
  ];
  await env.DB.batch(ops);
  return userById(env, bot, userId);
}

// --- JOIN: the first device creates the person; a second device gets a code instead —
//     unless the person was active within the return window (graceMinutes), in which
//     case the new device is bound at once. ---
//   → { linked: true, user, fresh }  ·  { linked: true, user, grace: true }  ·  { linked: false, code, email }
export const DEFAULT_GRACE_MINUTES = 60;
// 0 = a second device always waits for the owner; up to a week in minutes; ALWAYS (-1) = never block a second device.
export const ALWAYS = -1;
export function cleanGrace(v, fallback = DEFAULT_GRACE_MINUTES) { const n = Number(v); if (n === ALWAYS || v === "always") return ALWAYS; return Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), 7 * 24 * 60) : fallback; }
export async function join(env, bot, { email, keyHash, graceMinutes = DEFAULT_GRACE_MINUTES }) {
  const known = await userForDevice(env, bot, keyHash);
  if (known) return { linked: true, user: known };                          // reload of a known browser
  const userId = await userIdFor(email, env, bot);
  const exists = await userById(env, bot, userId);
  if (!exists) {
    const user = await bindDevice(env, bot, { userId, email, keyHash, label: "first device" });
    console.log(JSON.stringify({ event: "identity-join", bot, userId: userId.slice(0, 8) }));
    return { linked: true, user, fresh: true };
  }
  // The return window: last seen within N minutes → this is them, on another machine.
  const grace = cleanGrace(graceMinutes);
  const seen = Date.parse(exists.last_seen || exists.created_at || "") || 0;
  if (grace === ALWAYS || (grace > 0 && seen && Date.now() - seen < grace * 60 * 1000)) {
    const user = await bindDevice(env, bot, { userId, email, keyHash, label: "return window" });
    console.log(JSON.stringify({ event: "identity-join-grace", bot, userId: userId.slice(0, 8), minutesSinceSeen: Math.round((Date.now() - seen) / 60000) }));
    return { linked: true, user, grace: true };
  }
  return { linked: false, ...(await pendingCode(env, bot, { email, keyHash })) };
}
// The waiting-room code for an unknown device. Reused while it's valid (7 days).
export async function pendingCode(env, bot, { email, keyHash }) {
  await env.DB.prepare(`DELETE FROM id_pending WHERE created_at < ?`).bind(new Date(Date.now() - PENDING_TTL_MS).toISOString()).run();
  const prior = await env.DB.prepare(`SELECT code, email FROM id_pending WHERE key_hash = ? AND bot = ?`).bind(keyHash, bot).first();
  if (prior && prior.email === email) return { code: prior.code, email };
  if (prior) await env.DB.prepare(`DELETE FROM id_pending WHERE code = ?`).bind(prior.code).run();
  const code = randomCode(6);
  await env.DB.prepare(`INSERT INTO id_pending (code, bot, key_hash, email, created_at) VALUES (?, ?, ?, ?, ?)`).bind(code, bot, keyHash, email, nowIso()).run();
  return { code, email };
}
export async function pendingFor(env, bot, keyHash) {
  return keyHash ? (await env.DB.prepare(`SELECT code, email FROM id_pending WHERE key_hash = ? AND bot = ?`).bind(keyHash, bot).first()) || null : null;
}
// Everyone waiting for the owner's approval, newest first (the code stays server-side; the page shows email + when).
export async function listPending(env) { return (await env.DB.prepare(`SELECT code, bot, email, created_at FROM id_pending ORDER BY created_at DESC LIMIT 100`).all()).results || []; }
export async function pendingByEmail(env, bot, email) { return (await env.DB.prepare(`SELECT code, created_at FROM id_pending WHERE bot = ? AND email = ?`).bind(bot, email).all()).results || []; }

// --- THE OWNER LINKS A DEVICE (the coach's button): the code AND the email must match. ---
export async function linkByCode(env, bot, { email, code }) {
  code = String(code || "").trim().toUpperCase();
  const pend = await env.DB.prepare(`SELECT * FROM id_pending WHERE code = ? AND bot = ?`).bind(code, bot).first();
  if (!pend) return { ok: false, status: 404, error: "no such code", reason: "No device is waiting with that code. Codes expire after 7 days." };
  if (pend.email !== email) return { ok: false, status: 409, error: "email mismatch", reason: "That code was requested for a different email. Both must match — that's the point." };
  const user = await userByEmail(env, bot, email);
  if (!user) return { ok: false, status: 404, error: "no such person" };
  await bindDevice(env, bot, { userId: user.id, email, keyHash: pend.key_hash, label: "linked by the owner" });
  return { ok: true, linked: true, userId: user.id };
}

// What the sign-up gate collected, written once onto a fresh person's row. The words
// they ticked are kept verbatim: that is the consent record. Hashes only, never the IP.
export async function recordSignup(env, bot, userId, f) {
  await env.DB.prepare(`UPDATE id_users SET name = ?, phone = ?, marketing = ?, sms = ?, consented_at = ?, consent_text = ?, ip_hash = ?, ua_hash = ?, fp_hash = ?, source = ? WHERE id = ? AND bot = ?`)
    .bind(f.name || null, f.phone || null, f.marketing ? 1 : 0, f.sms ? 1 : 0, f.consented_at || null, f.consent_text || null, f.ip_hash || null, f.ua_hash || null, f.fp_hash || null, f.source || null, userId, bot).run();
}
// A phone number as digits with a leading +. Accepts what people type: (303) 555-0142,
// 303.555.0142, +44 20 7946 0958. A bare 10-digit number is taken as North American.
// Returns "+digits" for a number that could be real, or "" for one that can't be:
//   - 10 digits, or 11 starting with 1 → North American: area code and exchange must start
//     2-9, and 555-01xx is the block reserved for fiction
//   - otherwise 8-15 digits with a leading + or 00 → international, country code not 0
//   - never all one digit, never a straight run (1234567890), never a well-known fake
export function cleanPhone(v) {
  const raw = String(v || "").trim(); if (!raw) return "";
  const intl = /^\s*(\+|00)/.test(raw);
  const digits = raw.replace(/[^\d]/g, "").replace(/^00/, "");
  if (digits.length < 8 || digits.length > 15) return "";
  if (/^(\d)\1+$/.test(digits)) return "";                                       // 0000000000, 5555555555
  if ("01234567890123456789".includes(digits) || "98765432109876543210".includes(digits)) return "";
  if (["1234567890", "0123456789", "1111111111", "1112223333", "1231231234", "2125551212", "8005551212"].includes(digits.replace(/^1(?=\d{10}$)/, ""))) return "";
  const nanp = !intl && (digits.length === 10 || (digits.length === 11 && digits[0] === "1"));
  if (nanp) {
    const n = digits.length === 11 ? digits.slice(1) : digits;
    if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(n)) return "";                            // area code / exchange can't start 0 or 1
    if (/^\d{3}55501\d{2}$/.test(n)) return "";                                  // 555-0100..0199: fiction
    if (/^\d{3}(\d)\1{6}$/.test(n)) return "";                                   // 303 7777777
    return "+1" + n;
  }
  if (!intl && digits.length !== 10) return "";                                   // a bare 12-digit string is not a number
  if (digits[0] === "0") return "";                                               // no country code starts with 0
  return "+" + digits;
}
