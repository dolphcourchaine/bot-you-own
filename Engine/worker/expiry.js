// ============================================================================
//  WHEN ACCESS RUNS OUT — an end date on a person, a list entry, or a key.
//
//  In plain English:
//   · Nothing here expires unless you say so. Every end date is NULL by default,
//     and NULL means unlimited. A deployment that never opens this screen behaves
//     exactly as it did before.
//   · Three places can carry a date, because there are three different things you
//     might want to time-box:
//       id_users.access_until    THE PERSON. "Amy's twelve weeks end on the 3rd."
//                                Works in every mode where the visitor is identified
//                                — email, allow, key+email, and Plate.
//       allowlist.expires_at     THE INVITATION. "This cohort is on the list until
//                                the course finishes." Only bites in "allow" mode.
//       access_keys.expires_at   THE PASSPHRASE. "The demo key dies on Friday."
//                                Named for the secret it governs (ACCESS_PASSPHRASE,
//                                or a per-bot one like ACCESS_PASSPHRASE_CLIENTX).
//   · When more than one applies, THE EARLIEST WINS, and the answer says which one
//     it was — so "why am I locked out?" has one short answer, not a hunt.
//   · What lapsing DOES is configuration, not code (YourBots/config.js → expiry):
//       "tell"     locked out, told the date it ended and who to ask   (the default)
//       "readonly" they can still read their own history, but not send
//       "silent"   refused exactly as if they had never been let in
//     plus graceDays (days past the date before any of that bites) and warnDays
//     (how long the countdown shows first). A bot can override all of it in its
//     project.json → "expiry", the same way it overrides access.
//
//  This file FAILS OPEN, and that is deliberate — the opposite of access.js.
//  access.js decides whether the door opens at all, so a broken check there must
//  lock. Here the door is already open and we are only asking "is it still in
//  date?"; a database hiccup must not lock out a paying client. A lookup that
//  throws is treated as "no end date set". The one thing that never fails open is
//  the door itself, which has already been decided by the time we are called.
//
//  Every change to a date is written to admin_events with the person's address in
//  the `subject` column, which is what makes the per-person timeline one indexed
//  query instead of a scan: Under the hood → Settings → "Access over time".
// ============================================================================

const DAY_MS = 24 * 60 * 60 * 1000;

export const LAPSE_MODES = ["tell", "readonly", "silent"];
export const LAPSE_LINES = {
  tell: "Locked out, and told the date it ended plus the bot's handoff contact. They come and ask you for more time.",
  readonly: "They can still open the page and read their own history, but the composer is off. Kindest when a coaching block ends.",
  silent: "Refused exactly as if they had never been on the list. Gives nothing away about whether an account existed.",
};

// --- Reading and writing dates. ---------------------------------------------
// A date from a form ("2026-12-31") means THROUGH THE END OF THAT DAY, UTC. A full
// ISO timestamp is kept as it is. Anything unparseable is "no date", never "expired".
export function cleanUntil(v) {
  if (v === null || v === undefined || v === "" || v === "never" || v === "unlimited") return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const t = Date.parse(`${s}T23:59:59.999Z`);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
// The other direction, for a date input.
export const asDateInput = (iso) => (iso ? String(iso).slice(0, 10) : "");
// Whole CALENDAR days apart, in UTC. Using the raw millisecond gap and rounding up
// made "ends on the 13th", read on the 10th, say "4 days" — because the end date is
// stored as the last instant of its day. People count dates on a calendar, not in hours.
const dayNumber = (ms) => Math.floor(ms / DAY_MS);
const daysBetween = (a, b) => dayNumber(a) - dayNumber(b);

// --- The settings. YourBots/config.js < YourBots/settings.json < the D1 row,
//     then the bot's own project.json → "expiry" wins over all three.
const num = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : dflt;
};
export function cleanExpiryConfig(e) {
  if (!e || typeof e !== "object") return null;
  const out = {};
  const m = String(e.onLapse || "").trim().toLowerCase();
  if (LAPSE_MODES.includes(m)) out.onLapse = m;
  if (e.graceDays !== undefined && e.graceDays !== null && e.graceDays !== "") out.graceDays = num(e.graceDays, 0, 365, 0);
  if (e.warnDays !== undefined && e.warnDays !== null && e.warnDays !== "") out.warnDays = num(e.warnDays, 0, 365, 7);
  if (e.defaultDays !== undefined && e.defaultDays !== null && e.defaultDays !== "") out.defaultDays = num(e.defaultDays, 0, 3650, 0);
  return Object.keys(out).length ? out : null;
}
export const EXPIRY_BUILT_IN = { onLapse: "tell", graceDays: 0, warnDays: 7, defaultDays: 0 };

export function expirySettings(config, fileSettings, savedRow) {
  const layers = [cleanExpiryConfig(savedRow?.expiry), cleanExpiryConfig(fileSettings?.expiry), cleanExpiryConfig(config?.expiry)];
  const names = ["saved (Settings screen)", "YourBots/settings.json", "YourBots/config.js"];
  const out = { ...EXPIRY_BUILT_IN }, source = {};
  for (const k of Object.keys(EXPIRY_BUILT_IN)) {
    const i = layers.findIndex((l) => l && l[k] !== undefined);
    out[k] = i === -1 ? EXPIRY_BUILT_IN[k] : layers[i][k];
    source[k] = i === -1 ? "built-in" : names[i];
  }
  return { ...out, source };
}
// What a single bot actually runs on: its own project.json → "expiry" over the deployment's.
export function expiryFor(project, settings) {
  const base = settings?.expiry || EXPIRY_BUILT_IN;
  const own = cleanExpiryConfig(project?.expiry) || {};
  return { onLapse: own.onLapse ?? base.onLapse, graceDays: own.graceDays ?? base.graceDays, warnDays: own.warnDays ?? base.warnDays, defaultDays: own.defaultDays ?? base.defaultDays, fromBot: Object.keys(own) };
}

// --- Schema. Two new columns on tables that already exist, and one new table.
//     SQLite has no ADD COLUMN IF NOT EXISTS, so we look first (PRAGMA is cheap
//     and this runs once per isolate).
const KEYS_TABLE = `CREATE TABLE IF NOT EXISTS access_keys (name TEXT PRIMARY KEY, expires_at TEXT, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT)`;
let SCHEMA_OK = false;
// → true when the column is there afterwards, false when the table itself doesn't
//   exist yet (its own creator hasn't run — we'll try again next time).
async function addColumn(env, table, column, decl) {
  try {
    const info = (await env.DB.prepare(`PRAGMA table_info(${table})`).all()).results || [];
    if (!info.length) return false;
    if (info.some((c) => c.name === column)) return true;
    await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`).run();
    return true;
  } catch (err) { console.warn(`could not add ${table}.${column} — expiry falls back to unlimited`, err?.message || err); return false; }
}
export async function ensureExpirySchema(env) {
  if (SCHEMA_OK || !env.DB) return;
  try {
    await env.DB.prepare(KEYS_TABLE).run();
    const done = [
      await addColumn(env, "id_users", "access_until", "TEXT"),
      await addColumn(env, "allowlist", "expires_at", "TEXT"),
      await addColumn(env, "admin_events", "subject", "TEXT"),
    ];
    try { await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_adminev_subject ON admin_events(subject, id)`).run(); } catch {}
    // Only latch when every table we needed was actually present. A deployment whose
    // identity tables have never been touched will come back through here later.
    SCHEMA_OK = done.every(Boolean);
  } catch (err) { console.error("expiry schema failed — every window is treated as unlimited", err?.message || err); }
}

// --- THE ANSWER. -------------------------------------------------------------
//   stateOf(until, cfg, now) → { state, until, days, graceUntil }
//     unlimited  no date at all
//     active     in date, and further off than warnDays
//     warn       in date, but inside the countdown
//     grace      past the date, inside graceDays
//     lapsed     past the date and past the grace
export function stateOf(until, cfg = EXPIRY_BUILT_IN, now = Date.now()) {
  if (!until) return { state: "unlimited", until: null, days: null, graceUntil: null };
  const end = Date.parse(until);
  if (!Number.isFinite(end)) return { state: "unlimited", until: null, days: null, graceUntil: null };
  const graceUntil = end + (cfg.graceDays || 0) * DAY_MS;
  if (now <= end) {
    const days = daysBetween(end, now);
    return { state: days <= (cfg.warnDays ?? 7) ? "warn" : "active", until, days, graceUntil: new Date(graceUntil).toISOString() };
  }
  return { state: now <= graceUntil ? "grace" : "lapsed", until, days: -daysBetween(now, end), graceUntil: new Date(graceUntil).toISOString() };
}
export const isBlocked = (s) => s === "lapsed";
export const canRead = (s, cfg) => s !== "lapsed" || (cfg?.onLapse || "tell") === "readonly";

// --- Where the dates come from. Earliest wins, and we keep the reason. --------
//     Fails open: anything that throws contributes no date.
// defaultDays is a POLICY, not a stored date: "everyone gets twelve weeks from the
// day they joined". It is worked out from created_at each time rather than stamped
// on the row, which means changing the number moves everybody who hasn't been given
// a date of their own — and giving someone an explicit date always wins over it.
// Nothing is written on a read path.
async function personUntil(env, bot, email, cfg) {
  if (!email) return null;
  try {
    const r = await env.DB.prepare(`SELECT access_until, created_at FROM id_users WHERE bot = ? AND email = ?`).bind(bot, email).first();
    if (!r) return null;
    if (r.access_until) return r.access_until;
    const days = cfg?.defaultDays || 0;
    if (!days || !r.created_at) return null;
    const from = Date.parse(r.created_at);
    return Number.isFinite(from) ? new Date(from + days * DAY_MS).toISOString() : null;
  } catch { return null; }
}
async function listUntil(env, bot, emailHmac) {
  if (!emailHmac) return null;
  try {
    const rows = (await env.DB.prepare(`SELECT scope, expires_at FROM allowlist WHERE email_hmac = ? AND scope IN (?, ?)`).bind(emailHmac, bot || "-", "*").all()).results || [];
    if (!rows.length) return null;
    // A person on both their bot's list AND the every-bot list is admitted by either,
    // so the one that lets them stay LONGEST is the one that governs. An unlimited
    // row (NULL) beats every dated one.
    if (rows.some((r) => !r.expires_at)) return null;
    return rows.map((r) => r.expires_at).sort().pop();
  } catch { return null; }
}
async function keyUntil(env, name) {
  if (!name) return null;
  try {
    const r = await env.DB.prepare(`SELECT expires_at FROM access_keys WHERE name = ?`).bind(name).first();
    return r?.expires_at || null;
  } catch { return null; }
}

// resolve(env, { bot, email, emailHmac, keyName }, cfg)
//   → { state, until, days, source, onLapse, graceUntil, parts }
// `source` is the human answer to "which one ran out": "person" | "list" | "key".
export async function resolve(env, { bot, email = "", emailHmac = "", keyName = "" } = {}, cfg = EXPIRY_BUILT_IN) {
  const none = { ...stateOf(null, cfg), source: "", onLapse: cfg.onLapse, parts: {} };
  if (!env?.DB) return none;
  try {
    await ensureExpirySchema(env);
    const [person, list, key] = await Promise.all([personUntil(env, bot, email, cfg), listUntil(env, bot, emailHmac), keyUntil(env, keyName)]);
    const parts = { person, list, key };
    // The EARLIEST date wins, and we keep its name — so "why am I locked out?" is
    // answered with one word (person / list / key) rather than a hunt through three tables.
    const dated = Object.entries(parts).filter(([, v]) => Boolean(v)).sort((a, b) => (a[1] < b[1] ? -1 : 1));
    if (!dated.length) return { ...none, parts };
    const [source, until] = dated[0];
    return { ...stateOf(until, cfg), source, onLapse: cfg.onLapse, parts };
  } catch (err) {
    console.error("expiry lookup failed — treating this visitor as unlimited", err?.message || err);
    return none;
  }
}

// --- What the visitor is told. One place, so the page, the widget and the API agree.
export function lapseReply(r, project) {
  const contact = String(project?.handoff || project?.handoffContact || "").trim();
  const when = r.until ? new Date(r.until).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : "";
  if ((r.onLapse || "tell") === "silent") return "This bot is for invited people. Ask the owner to add you.";
  if (r.onLapse === "readonly") return `Your access ended${when ? ` on ${when}` : ""}. You can still read everything you've already asked${contact ? `, and ${contact} can give you more time` : ""}.`;
  return `Your access ended${when ? ` on ${when}` : ""}.${contact ? ` ${contact}` : " Ask the owner for more time."}`;
}
// The countdown, for the page's banner. "" when there is nothing to say.
export function noticeFor(r) {
  if (r.state === "warn") return r.days <= 0 ? "Your access ends today." : `Your access ends in ${r.days} day${r.days === 1 ? "" : "s"}.`;
  if (r.state === "grace") {
    const left = Math.max(0, daysBetween(Date.parse(r.graceUntil), Date.now()));
    return left <= 0 ? "Your access has ended — today is the last day of the grace period." : `Your access ended, but you have ${left} more day${left === 1 ? "" : "s"} to renew.`;
  }
  return "";
}

// --- THE OWNER'S SIDE. Every write goes through here so every write is audited. ---
//     `log` is index.js's logAdminEvent, passed in so this file never imports it back.
export async function setPersonUntil(env, { bot, email, until, who = "admin", log = null, request = null }) {
  await ensureExpirySchema(env);
  const iso = cleanUntil(until);
  const before = await env.DB.prepare(`SELECT access_until FROM id_users WHERE bot = ? AND email = ?`).bind(bot, email).first();
  if (!before) return { ok: false, status: 404, error: `${email} hasn't joined ${bot} yet — there's no person to date.` };
  await env.DB.prepare(`UPDATE id_users SET access_until = ? WHERE bot = ? AND email = ?`).bind(iso, bot, email).run();
  const was = before.access_until || null;
  const action = !iso ? "access-unlimited" : !was ? "access-grant" : Date.parse(iso) > Date.parse(was) ? "access-extend" : "access-shorten";
  if (log) await log(env, request, action, bot, describe(was, iso), email);
  return { ok: true, bot, email, until: iso, was, action };
}
export async function setKeyUntil(env, { name, until, note = "", who = "admin", log = null, request = null }) {
  await ensureExpirySchema(env);
  const iso = cleanUntil(until);
  const now = new Date().toISOString();
  const before = await env.DB.prepare(`SELECT expires_at FROM access_keys WHERE name = ?`).bind(name).first();
  await env.DB.prepare(`INSERT INTO access_keys (name, expires_at, note, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET expires_at = excluded.expires_at, note = excluded.note, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .bind(name, iso, String(note || "").slice(0, 200), now, now, String(who).slice(0, 60)).run();
  const was = before?.expires_at || null;
  if (log) await log(env, request, was || iso ? "access-key-date" : "access-key-date", name, describe(was, iso), "");
  return { ok: true, name, until: iso, was };
}
const fmt = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : "unlimited");
const describe = (was, now) => `${fmt(was)} → ${fmt(now)}`;

// The keys the owner can put a date on: every ACCESS_PASSPHRASE* secret that is
// actually set, plus any row we hold for a secret that ISN'T — an orphan row can
// otherwise sit there governing nothing, which is the one trap in this design.
export async function keyRows(env) {
  await ensureExpirySchema(env);
  const set = Object.keys(env).filter((k) => k === "ACCESS_PASSPHRASE" || /^ACCESS_PASSPHRASE_[A-Z0-9_]+$/.test(k));
  let rows = [];
  try { rows = (await env.DB.prepare(`SELECT name, expires_at, note, updated_at FROM access_keys`).all()).results || []; } catch {}
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  const out = set.map((name) => ({ name, secretSet: true, expires_at: byName[name]?.expires_at || null, note: byName[name]?.note || "", ...stateOf(byName[name]?.expires_at || null) }));
  for (const r of rows) if (!set.includes(r.name)) out.push({ name: r.name, secretSet: false, expires_at: r.expires_at, note: r.note, ...stateOf(r.expires_at), orphan: true });
  return out;
}

// --- THE TIMELINE. "What happened to this person over time." One indexed read.
export async function timelineFor(env, email, limit = 100) {
  await ensureExpirySchema(env);
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  try {
    const rows = (await env.DB.prepare(`SELECT id, action, target, detail, who, created_at FROM admin_events WHERE subject = ? ORDER BY id DESC LIMIT ?`).bind(String(email || "").toLowerCase(), n).all()).results || [];
    return { ok: true, email, events: rows };
  } catch (err) { return { ok: false, email, events: [], error: err?.message || "the record couldn't be read" }; }
}
// Everyone who has a date on them, for the Settings table.
export async function datedPeople(env, bot = "") {
  await ensureExpirySchema(env);
  try {
    const sql = bot
      ? `SELECT bot, email, access_until, created_at, last_seen FROM id_users WHERE access_until IS NOT NULL AND bot = ? ORDER BY access_until`
      : `SELECT bot, email, access_until, created_at, last_seen FROM id_users WHERE access_until IS NOT NULL ORDER BY access_until`;
    const st = bot ? env.DB.prepare(sql).bind(bot) : env.DB.prepare(sql);
    const rows = (await st.all()).results || [];
    return rows.map((r) => ({ ...r, ...stateOf(r.access_until) }));
  } catch { return []; }
}
