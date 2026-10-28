// ============================================================================
//  FOOD LOG — /food. A photo food log a coach deploys for their clients.
//
//  Not a chat bot: a page with a camera button. Snap the plate, the vision
//  model names the foods and guesses the numbers, the person fixes the
//  portion with a tap, the day shows a ring and three bars. Also: type a
//  meal, scan a barcode, read a nutrition label, scan a receipt, weigh in,
//  share a household with a spouse. The coach sees every client at /food/coach.
//
//  IDENTITY lives in Engine/identity/ (docs/IDENTITY.md) and is shared by every
//  kind of bot: email + device key, passkeys, Google/Microsoft/Apple, an
//  authenticator code, or the coach's link for a second device. This file only
//  asks "who is this browser?" and keeps the food side of a person (targets).
//  Identity fails CLOSED (unknown device = 401); features fail OPEN (no
//  thumbnail, no barcode database, no model → the page still works, with less).
//
//  A food log is a bot of kind "food" (YourBots/<id>/project.json). It lives at
//  /apps/<id> with its API at /api/apps/<id>/… and the coach at /api/admin/apps/<id>/….
//  /food and /api/food/… are aliases for the bot whose id is "plate" (one release).
//
//  ROUTES (under /api/apps/<id>/, device key in the x-device-key header):
//   GET  config                       what the page needs (coach name, sign-in buttons)
//   POST join {email}                 → { linked, userId } or { linked:false, code, message }
//   GET  me                           who am I, my targets, my household, still pending?
//   POST signin {provider, idToken}   link this device by proving the email (passkeys, codes: /api/id/*)
//   GET/POST targets                  daily kcal + macros (+ unit, name)
//   POST photo (multipart)            photo, thumb, kind=food|barcode|label|receipt, date, correction, mealId
//   POST text {text, date, correction, mealId}
//   POST meal {date, items, source}   · PATCH meal/<id> {items} · DELETE meal/<id>
//   GET  day?date=&user=              · GET week?end=&user=   (user= a household member, read-only)
//   POST barcode {code}               · POST weight {date, value, unit}
//   GET/POST household, POST household/join, POST household/leave
//   GET  receipts · DELETE receipt/<id>
//  Admin (x-admin-token): GET /api/admin/apps/<id>/clients · GET client/<uid> ·
//   GET export.csv · POST link {email, deviceCode} · GET client/<id>/summary?kind=week&end=
//   The day as a conversation, summaries, favourites (v3.10 — Engine/worker/track-day.js):
//   GET chat?date= · POST say {date,text,hour,tz} · GET favourites?hour=&date= · POST repeat {favouriteId|fromDate,date,mult}
//   POST favourite/name {id,name} · DELETE favourite/<id> · GET summary?date=&kind=day|week
//   POST transcribe (multipart "audio") → { text }   the mic: Whisper on Workers AI, never the browser's own
//  Pages: /apps/<id> (the app) · /apps/<id>/coach (the coach view). Both are the
//  static files in Engine/public/food/, served through here per bot.
// ============================================================================

import { json, nowIso, pickDate, addDays, todayUtc, clamp, round1, cleanEmail, readJson, toBase64, randomId } from "./track-common.js";
import { CONFIG } from "../../YourBots/config.js";
import { identify, signInMethods, verifyIdToken } from "../identity/index.js";
import { resolve as resolveExpiry, lapseReply, noticeFor, EXPIRY_BUILT_IN } from "./expiry.js";
import { join as idJoin, userIdFor, userById as idUserById, bindDevice, linkByCode, deviceCount, listDevices, pendingByEmail, touch as idTouch, DEV_PEPPER, pepperOf } from "../identity/devices.js";
import { applyLabelMath, scaleGrams } from "./track-yield.js";
import { runVision, streamVision, PROMPTS, labelTurn, extractJson, withBrands, sanitiseItems, sanitiseLabel, sanitiseReceipt, totalsOf, imageSize, mergeCorrection } from "./track-vision.js";
import { lookupBarcode, useBarcodes, rememberLabel, saveReceipt, listReceipts, deleteReceipt, setWeight, listWeights, importWeights, householdOf, createHousehold, joinHousehold, leaveHousehold, canView } from "./track-extras.js";
import { clefTurn, orientMode, logOrient, costOf, ORIENT_LOG_SQL, shapeOf, CLEF_MODEL } from "./track-orient.js";
import { ensureDaySchema, dayChat, addWords, afterMeal, editedMeal, confirmedMeal, removedMeal, listFavourites, nameFavourite, forgetFavourite, matchFavourite, recentTwin, steadyItems, repeatMeals, retimeFavourite, localHour, askDay, summaryFor, classifySay, looksLikeFood, isLogAsk, stripLogAsk } from "./track-day.js";

const THUMB_MAX_PX = 256, THUMB_MAX_BYTES = 48 * 1024;
let HONESTY = "Photo estimates are typically within about 30%. Fix the portion when it's off.";   // per bot: project.json → food.honesty

// --- The tables. Created on first use, like the rest of the Worker. ------------
let TRACK_SCHEMA_OK = false;
export async function ensureTrackSchema(env) {
  if (TRACK_SCHEMA_OK || !env.DB) return;
  await env.DB.batch([
    // The food side of a person: targets. Who they ARE (email, devices) is Engine/identity/ (id_users, id_devices …).
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS track_users (id TEXT PRIMARY KEY, email TEXT, targets_json TEXT, created_at TEXT NOT NULL, last_seen TEXT)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS track_meals (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, date TEXT NOT NULL, time TEXT, items_json TEXT NOT NULL, kcal REAL, protein_g REAL, carbs_g REAL, fat_g REAL, thumb TEXT, source TEXT, created_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_track_meals_day ON track_meals(user_id, date)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS track_usage (user_id TEXT NOT NULL, date TEXT NOT NULL, photos INTEGER DEFAULT 0, PRIMARY KEY (user_id, date))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS track_products (code TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS track_receipts (id TEXT PRIMARY KEY, household_id TEXT, user_id TEXT NOT NULL, store TEXT, date TEXT, total REAL, currency TEXT, items_json TEXT, thumb TEXT, created_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_track_receipts_h ON track_receipts(household_id, date)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS track_weights (user_id TEXT NOT NULL, date TEXT NOT NULL, kg REAL NOT NULL, PRIMARY KEY (user_id, date))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS track_households (id TEXT PRIMARY KEY, name TEXT, code TEXT UNIQUE, created_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS track_members (household_id TEXT NOT NULL, user_id TEXT PRIMARY KEY, name TEXT, joined_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_track_members_h ON track_members(household_id)`),
    // A meal's photos when no R2 bucket is bound (the default): base64 in pieces, so a big photo never meets D1's row limit.
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS track_photo_parts (meal_id TEXT NOT NULL, i INTEGER NOT NULL, part INTEGER NOT NULL, user_id TEXT NOT NULL, mime TEXT, data TEXT NOT NULL, PRIMARY KEY (meal_id, i, part))`),
    // Which way is up, Clef's second opinion (Engine/worker/track-orient.js): one row per photo looked at, or turned by hand.
    env.DB.prepare(ORIENT_LOG_SQL),
  ]);
  // Where the person WAS when they logged (v3.13): the zone's name and the browser's UTC offset, so a lunch
  // eaten at noon in New York still reads "12:00 EDT" two weeks later from Denver. `time` became the LOCAL clock
  // at the same moment; rows from before carry no zone and the page shows those in the viewer's own zone.
  // SQLite has no ADD COLUMN IF NOT EXISTS: look first.
  try {
    const have = new Set(((await env.DB.prepare(`PRAGMA table_info(track_meals)`).all()).results || []).map((c) => c.name));
    // planned (v3.13): a meal that has not happened yet. Counts against the day's budget, never as eaten.
    for (const [col, decl] of [["tz", "TEXT"], ["tz_offset", "INTEGER"], ["planned", "INTEGER DEFAULT 0"], ["photos", "INTEGER DEFAULT 0"]]) if (!have.has(col)) await env.DB.prepare(`ALTER TABLE track_meals ADD COLUMN ${col} ${decl}`).run();
    // peeks (v3.14): quick per-photo looks today (the page's live build-up), capped apart from the photo reads.
    const usage = new Set(((await env.DB.prepare(`PRAGMA table_info(track_usage)`).all()).results || []).map((c) => c.name));
    if (!usage.has("peeks")) await env.DB.prepare(`ALTER TABLE track_usage ADD COLUMN peeks INTEGER DEFAULT 0`).run();
    // rotated (v3.14): a photo kept in D1 that the person turned by hand — the same flag R2 keeps in its metadata.
    const parts = new Set(((await env.DB.prepare(`PRAGMA table_info(track_photo_parts)`).all()).results || []).map((c) => c.name));
    if (!parts.has("rotated")) await env.DB.prepare(`ALTER TABLE track_photo_parts ADD COLUMN rotated TEXT`).run();
  } catch (err) { console.warn("meal zone columns not added (times will show in UTC)", err?.message || err); }
  await ensureDaySchema(env);
  TRACK_SCHEMA_OK = true;
}
// A zone name as the browser reports it ("America/New_York"), or null. The offset is getTimezoneOffset(): minutes WEST of UTC.
const cleanZone = (z) => { const s = String(z || "").trim(); return /^[A-Za-z_][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+){0,3}$/.test(s) && s.length <= 64 ? s : null; };
const cleanFlag = (v) => v === true || v === 1 || v === "1" || v === "true";
// Not said → a meal on a day after today is a plan; said → as said.
const cleanPlanned = (v, date) => (v === undefined || v === null || v === "" ? date > todayUtc() : cleanFlag(v));
const cleanOffset = (o) => { const n = Number(o); return Number.isFinite(n) && Math.abs(n) <= 16 * 60 ? Math.round(n) : null; };
// The clock on the person's wall at a UTC instant, "HH:MM".
const localClock = (iso, offsetMin) => new Date(Date.parse(iso) - (offsetMin || 0) * 60000).toISOString().slice(11, 16);

// --- The router. Called from index.js for one food bot: the app's page, its API, its coach API.
//     `bot` is the resolved project (kind food); api/page/admin are the path prefixes it answers on
//     ("/api/apps/plate/", "/apps/plate", "/api/admin/apps/plate/" — or the /food aliases).
export async function handleTrack(request, env, url, { ctx = null, bot, api, page, admin, isAdmin = false, adminEnabled = false, allowed = async () => true, graceMinutes = 60, expiry: expCfg = EXPIRY_BUILT_IN } = {}) {
  const cfg = foodConfig(bot, env);
  HONESTY = cfg.honesty;
  const p = url.pathname;

  // The pages. /apps/<id> → the app; /apps/<id>/coach → the coach view. Static files in Engine/public/food/.
  if (p === page || p === page + "/") return env.ASSETS.fetch(new Request(`${url.origin}/food/`, { headers: request.headers }));
  // Every screen has an address (/day/2026-09-20, /weight/new, /coach/<client>…): a path with no
  // file extension is the app, or the coach page under /coach; anything with one is a static file.
  if (p.startsWith(page + "/")) {
    const rest = p.slice(page.length + 1);
    const file = /^coach(\/|$)/.test(rest) ? "coach" : /\.[a-z0-9]+$/i.test(rest) ? rest : "";
    return env.ASSETS.fetch(new Request(`${url.origin}/food/${file}`, { headers: request.headers }));
  }

  if (p.startsWith(admin)) {
    if (!isAdmin) return json({ error: "admin only" }, adminEnabled ? 401 : 404);
    if (!env.DB) return json({ error: "No D1 database is bound (wrangler.jsonc → d1_databases)." }, 503);
    await ensureTrackSchema(env);
    return handleCoach(request, env, url, cfg, p.slice(admin.length));
  }

  if (p === api + "config") return json({ enabled: true, id: bot.id, name: cfg.name, coachName: cfg.coachName, honesty: cfg.honesty, signIn: cfg.signIn, methods: { passkeys: cfg.methods.passkeys, totp: cfg.methods.totp, providers: cfg.signIn.map((s) => s.provider) }, dailyPhotoLimit: cfg.dailyPhotoLimit, maxPhotoBytes: cfg.maxPhotoBytes, photosKept: Boolean(env.PHOTOS || env.DB), api, page });
  if (!env.DB) return json({ error: "The food log needs the D1 database (wrangler.jsonc → d1_databases)." }, 503);
  await ensureTrackSchema(env);
  if (cfg.pepper === DEV_PEPPER) console.warn("FOODLOG_PEPPER is not set — user ids use the dev pepper. Set it before real people use this: npx wrangler secret put FOODLOG_PEPPER");

  // The orientation eval (Engine/tests/orient-eval.py): Clef's verdict on one photo, with every probability. Only on a
  // local `wrangler dev` started with ORIENT_EVAL=1 — never on a deployed worker (the var is never set there, and the
  // host must be this machine).
  if (p === api + "orient-eval" && env.ORIENT_EVAL === "1" && ["localhost", "127.0.0.1"].includes(url.hostname) && request.method === "POST") {
    let form; try { form = await request.formData(); } catch { return json({ error: "bad request" }, 400); }
    const f = form.get("photo"), cw = form.get("cw");
    if (!f || typeof f.arrayBuffer !== "function") return json({ error: "no photo" }, 400);
    const bytes = await f.arrayBuffer(), size = imageSize(bytes);
    if (!size?.w) return json({ error: "not a JPEG or PNG" }, 400);
    const model = form.get("model") === "clef-flash" ? "clef-flash" : "clef";
    const r = await clefTurn(env, { bytes, cw: cw && typeof cw.arrayBuffer === "function" ? await cw.arrayBuffer() : null, w: size.w, h: size.h, mime: size.type === "png" ? "image/png" : "image/jpeg", model });
    const tokens = r.looks.reduce((a, l) => a + (l.tokens || 0), 0);
    return json({ ok: true, w: size.w, h: size.h, ...r, tokens, cost_usd: costOf(tokens, model === "clef-flash" ? "@cf/cloudflare/clef-flash" : CLEF_MODEL) });
  }

  // Who is this browser? Engine/identity/index.js — fails closed.
  const who = await identify(request, env, bot);
  const keyHash = who.keyHash;

  if (p === api + "join") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    if (!(await allowed(env, request))) return json({ error: "rate-limited", reason: "Too many tries. Give it a minute." }, 429);
    if (!keyHash) return json({ error: "no device key", reason: "This browser didn't send a device key. Reload the page." }, 400);
    return join(env, cfg, await readJson(request), keyHash, graceMinutes);
  }

  // Everything below needs a known device. Unknown → 401, no exceptions.
  const me = who.user ? await withProfile(env, who.user) : null;
  if (p === api + "signin") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    if (!(await allowed(env, request))) return json({ error: "rate-limited" }, 429);
    if (!keyHash) return json({ error: "no device key" }, 400);
    return signIn(env, cfg, await readJson(request), keyHash, me);
  }
  // --- IS THIS PERSON STILL IN DATE? (Engine/worker/expiry.js) ------------------
  //     A coaching block ends and the client's log should stop taking new meals.
  //     What that looks like is the owner's choice, the same three words as a chat
  //     bot: tell / readonly / silent. "readonly" is the one that matters here —
  //     a client whose twelve weeks are up can still open their whole history.
  //     The admin is never time-boxed, and every lookup fails open.
  const expiry = isAdmin || !me ? null : await resolveExpiry(env, { bot: bot.id, email: me.email || "", emailHmac: "", keyName: "" }, expCfg);
  const lapsed = Boolean(expiry && expiry.state === "lapsed");
  const readOnly = lapsed && expCfg.onLapse === "readonly";

  if (p === api + "me") {
    if (me) {
      // A lapsed person must be turned away HERE too, not only on the writes below —
      // /me is what the page boots from, so letting it through would open the app as
      // if nothing had happened. "readonly" is the one mode that deliberately says yes:
      // reading their own log is the whole point of it.
      if (lapsed && !readOnly) {
        // Under "silent" we say nothing that confirms the account exists — not even
        // linked:true — which is the difference between "silent" and "tell".
        const quiet = expCfg.onLapse === "silent";
        return json(quiet ? { linked: false, reason: lapseReply(expiry, bot) } : { linked: true, error: "expired", reason: lapseReply(expiry, bot) }, 403);
      }
      return json({ linked: true, ...(await profile(env, me)), access: expiry ? { until: expiry.until, state: expiry.state, days: expiry.days, notice: noticeFor(expiry), readOnly } : null });
    }
    return json(who.pending ? { linked: false, code: who.pending.code, email: who.pending.email, message: PENDING_MESSAGE } : { linked: false }, 401);
  }
  if (!me) return json({ error: "unknown device", reason: "This browser isn't linked to a log. Enter your email to start." }, 401);
  if (lapsed && !readOnly) return json({ error: "expired", reason: lapseReply(expiry, bot) }, 403);
  touch(env, me);

  const sub = p.slice(api.length);
  // readonly: GET still works, so the day, the week and every photo they ever logged
  // are all still there. Anything that changes the log is refused with the same line.
  if (readOnly && request.method !== "GET") return json({ error: "expired", reason: lapseReply(expiry, bot), readOnly: true }, 403);
  const body = request.method === "POST" || request.method === "PATCH" ? await readJson(request.clone()) : {};

  if (sub === "targets") {
    if (request.method === "GET") return json({ targets: me.targets });
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    const t = cleanTargets(body.targets || body);
    await env.DB.prepare(`UPDATE track_users SET targets_json = ? WHERE id = ?`).bind(JSON.stringify(t), me.id).run();
    return json({ ok: true, targets: t });
  }
  // Which way is up? Small copies of the photos (the page makes them, ≤512 px); the answer is how far to turn
  // each one clockwise so its printed words and numbers read upright. The page turns them before the real read —
  // a sideways OXO display read as 8.8 oz (or not at all); upright, 8 1/8 every time. One quick call per photo,
  // in parallel; 0 when nothing has a say. Fails open. The answers line up with the photos sent, one for one.
  if (sub === "orient") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    if (!(await allowed(env, request))) return json({ error: "rate-limited" }, 429);
    let form; try { form = await request.formData(); } catch { return json({ error: "bad request" }, 400); }
    const usable = (f) => f && typeof f.arrayBuffer === "function" && f.size > 0 && f.size <= 300 * 1024;
    const files = form.getAll("photo").slice(0, MAX_PHOTOS);
    const hand = handOf(form.get("hand"));                    // turned by the person (↻): never turned again
    const bytesOf = await Promise.all(files.map((f) => (usable(f) ? f.arrayBuffer() : null)));
    // Clef's second opinion (track-orient.js), asked alongside the rules below. "shadow": logged, never acted on.
    const { mode, sample } = orientMode(env);
    const asks = bytesOf.map((bytes, i) => {
      const size = bytes ? imageSize(bytes) : null;
      if (!size?.w || mode === "off" || (mode === "shadow" && Math.random() >= sample)) return null;
      const cwf = form.get("cw" + i);                          // the page's 90° clockwise copy of a landscape photo
      return (async () => ({ size, ...(await clefTurn(env, { bytes, cw: usable(cwf) ? await cwf.arrayBuffer() : null, w: size.w, h: size.h, mime: size.type === "png" ? "image/png" : "image/jpeg" })) }))();
    });
    // Two landmarks, in order: a scale's display (bottom), else a Nutrition Facts heading (top of its panel,
    // Engine/worker/track-vision.js → labelTurn). A photo with neither — a barcode alone, the front of a
    // can, a plate — is left as it is: on those, the rules have no say.
    const TURN = { bottom: 0, none: 0, left: 270, right: 90, top: 180 };
    const looks = await Promise.all(bytesOf.map(async (bytes) => {
      if (!bytes) return { turn: 0, scale: false, by: "" };
      let edge = "none";
      try {
        const out = await runVision(env, cfg, { images: [{ bytes, mime: "image/jpeg" }], prompt: PROMPTS.scaleEdge(), maxTokens: 12, temperature: 0 });
        edge = (String(out.text || "").toLowerCase().match(/\b(top|bottom|left|right|none)\b/) || [])[1] || "none";
      } catch {}
      if (edge !== "none") return { turn: TURN[edge] ?? 0, scale: true, by: "scale" };
      const t = await labelTurn(env, cfg, bytes);
      return t === null ? { turn: 0, scale: false, by: "" } : { turn: t, scale: false, by: "label" };
    }));
    // What the page does with each photo today, next to what Clef would have done: one log row per photo.
    const now = looks.map((l, i) => (hand.has(i) ? { turn: 0, by: "hand" } : { turn: l.turn, by: l.by || "none" }));
    const record = async () => {
      const said = await Promise.all(asks.map((a) => a || null));
      for (let i = 0; i < said.length; i++) {
        const v = said[i]; if (!v) continue;
        const id = randomId(), tokens = v.looks.reduce((a, l) => a + (l.tokens || 0), 0);
        const agree = v.verdict === "error" ? null : now[i].turn === v.turn ? 1 : 0;
        // A disagreement keeps its small copy, to be looked at by eye (Engine/tests/orient-report.mjs --fetch).
        let imageKey = null;
        if (agree === 0 && env.PHOTOS) { imageKey = `orient-shadow/${id}.jpg`; try { await env.PHOTOS.put(imageKey, bytesOf[i], { httpMetadata: { contentType: "image/jpeg" }, customMetadata: { user: me.id } }); } catch { imageKey = null; } }
        await logOrient(env, {
          id, at: nowIso(), user_id: me.id, source: "orient", mode, shape: v.shape, w: v.size.w, h: v.size.h, hand: hand.has(i) ? 1 : 0,
          cur_turn: now[i].turn, cur_by: now[i].by, clef_turn: v.turn, clef_verdict: v.verdict,
          probs_json: JSON.stringify({ looks: v.looks.map((l) => ({ asked: l.asked, ms: l.ms, p: Object.fromEntries(Object.entries(l.p).map(([k, x]) => [k, Math.round(x * 1000) / 1000])) })), ...(v.error ? { error: v.error } : {}) }),
          ms: v.looks.reduce((a, l) => a + (l.ms || 0), 0), tokens, cost_usd: costOf(tokens), agree, image_key: imageKey,
        });
      }
      return said;
    };
    if (mode === "live") {
      // Live: the landmark rules first (never wrong on the owner's photos); Clef only where they had no say.
      const said = await record();
      said.forEach((v, i) => { if (v && v.turn && !hand.has(i) && !looks[i].by) Object.assign(looks[i], { turn: v.turn, by: "clef" }); });
    } else if (asks.some(Boolean)) {
      const job = record().catch((err) => console.warn("orient shadow failed", err?.message || err));
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(job);
    }
    hand.forEach((_, i) => { if (looks[i]) Object.assign(looks[i], { turn: 0, by: "hand" }); });
    return json({ ok: true, turn: looks.map((l) => l.turn), scale: looks.map((l) => l.scale), by: looks.map((l) => l.by) });
  }
  // The quick look: every photo read ON ITS OWN, in parallel, each answer streamed back the moment it lands (one JSON
  // object per line). The page builds the meal up from these while the full read — all the photos together, the one
  // that is saved — is still running. Small copies (≤512 px, the ones made for orient). Capped per day apart from
  // the photo reads; any failure is just a line that says so. Nothing is stored.
  if (sub === "peek") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    if (!(await allowed(env, request))) return json({ error: "rate-limited" }, 429);
    let form; try { form = await request.formData(); } catch { return json({ error: "bad request" }, 400); }
    const files = form.getAll("photo").slice(0, MAX_PHOTOS);
    const peeks = (await env.DB.prepare(`SELECT peeks FROM track_usage WHERE user_id = ? AND date = ?`).bind(me.id, todayUtc()).first().catch(() => null))?.peeks || 0;
    if (peeks + files.length > cfg.dailyPhotoLimit * MAX_PHOTOS) return json({ error: "daily-limit" }, 429);
    await env.DB.prepare(`INSERT INTO track_usage (user_id, date, photos, peeks) VALUES (?, ?, 0, ?) ON CONFLICT(user_id, date) DO UPDATE SET peeks = COALESCE(peeks, 0) + excluded.peeks`).bind(me.id, todayUtc(), files.length).run().catch(() => {});
    const { readable, writable } = new TransformStream();
    const out = writable.getWriter(), enc = new TextEncoder();
    const line = (o) => out.write(enc.encode(JSON.stringify(o) + "\n")).catch(() => {});
    const t0 = Date.now();
    const work = (async () => {
      await Promise.all(files.map(async (f, i) => {
        if (!f || typeof f.arrayBuffer !== "function" || !f.size || f.size > 300 * 1024) return line({ i, error: "skipped" });
        try {
          // Streamed: what the photo shows as soon as it is written, then each food the moment its entry is complete,
          // then the whole answer (with the label and the scale) once it is done.
          let head = false, sent = 0;
          const text = await streamVision(env, cfg, { images: [{ bytes: await f.arrayBuffer(), mime: "image/jpeg" }], prompt: PROMPTS.peek(), maxTokens: 700, temperature: 0 }, (t) => {
            if (!head) { const sv = salvagePeek(t); if (sv.shows && /"kind"\s*:\s*"[a-z]+"/.test(t)) { head = true; line({ i, part: "head", ms: Date.now() - t0, shows: sv.shows.slice(0, 60) }); } }
            const items = salvagePeek(t).items;
            for (; sent < items.length; sent++) { const one = cleanPeek({ items: [items[sent]] }).items[0]; if (one) line({ i, part: "item", ms: Date.now() - t0, item: one }); }
          });
          await line({ i, ms: Date.now() - t0, ...cleanPeek(extractJson(text) || salvagePeek(text)) });
        } catch (err) { console.warn("peek failed", err?.message || err); await line({ i, error: "model" }); }
      }));
      await line({ done: true, ms: Date.now() - t0 });
      await out.close().catch(() => {});
    })();
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(work);
    return new Response(readable, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  }
  if (sub === "photo") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    if (!(await allowed(env, request))) return json({ error: "rate-limited", reason: "You're sending photos faster than I can look. Give me a moment." }, 429);
    return photo(request, env, cfg, me);
  }
  if (sub === "text") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    if (!(await allowed(env, request))) return json({ error: "rate-limited", reason: "Give me a moment and try again." }, 429);
    return textMeal(env, cfg, me, body);
  }
  if (sub === "meal" && request.method === "POST") return saveMeal(env, me, body);
  const pm = sub.match(/^meal\/([^/]+)\/photo\/(\d{1,2})$/);
  if (pm) {
    const row = await env.DB.prepare(`SELECT user_id FROM track_meals WHERE id = ?`).bind(pm[1]).first();
    if (!row || (row.user_id !== me.id && !(await canView(env, me.id, row.user_id)))) return json({ error: "no such photo" }, 404);
    return servePhoto(env, row.user_id, pm[1], pm[2]);
  }
  // ↻ on a saved photo (the viewer): the page turns the picture itself and sends the turned bytes (a Worker can't
  // draw). The untouched original is kept once as <i>-orig.jpg and never overwritten; the photo carries
  // rotated=<degrees>, so nothing automatic turns it again. A new card picture comes with it when the card showed
  // this photo. Owner only.
  const rm = sub.match(/^meal\/([^/]+)\/photo\/(\d{1,2})\/rotate$/);
  if (rm && request.method === "POST") {
    const row = await env.DB.prepare(`SELECT user_id, thumb FROM track_meals WHERE id = ?`).bind(rm[1]).first();
    if (!row || row.user_id !== me.id) return json({ error: "no such meal" }, 404);
    let form; try { form = await request.formData(); } catch { return json({ error: "bad request" }, 400); }
    const f = form.get("photo"), deg = Number(form.get("deg"));
    if (![90, 180, 270].includes(deg) || !f || typeof f.arrayBuffer !== "function" || !f.size || f.size > cfg.maxPhotoBytes) return json({ error: "bad request", reason: "That turn couldn't be saved." }, 400);
    const i = Number(rm[2]), was = await getPhoto(env, me.id, rm[1], i);
    if (!was) return json({ error: "no such photo" }, 404);
    const bytes = await f.arrayBuffer();
    const a = imageSize(was.bytes), b = imageSize(bytes);
    // The new picture must be the old one turned: a quarter turn swaps width and height, a half turn keeps them.
    const fits = a?.w && b?.w && (deg === 180 ? Math.abs(a.w - b.w) <= 2 && Math.abs(a.h - b.h) <= 2 : Math.abs(a.w - b.h) <= 2 && Math.abs(a.h - b.w) <= 2);
    if (!fits) return json({ error: "bad photo", reason: "That turn couldn't be saved — reload and try again." }, 400);
    await keepOriginal(env, me.id, rm[1], i, was);
    const rotated = String(((Number(was.meta.rotated) || 0) + deg) % 360);
    await putPhoto(env, me.id, rm[1], i, bytes, "image/jpeg", { ...was.meta, rotated });
    let thumb = null;
    if (form.get("thumb")) {
      thumb = await cleanThumb(form.get("thumb"));
      if (thumb) {
        await env.DB.prepare(`UPDATE track_meals SET thumb = ? WHERE id = ?`).bind(thumb, rm[1]).run();
        // A favourite learned from this meal carries the same picture: it turns too.
        if (row.thumb) await env.DB.prepare(`UPDATE track_favourites SET thumb = ? WHERE user_id = ? AND thumb = ?`).bind(thumb, me.id, row.thumb).run().catch(() => {});
      }
    }
    await logOrient(env, { id: randomId(), at: nowIso(), user_id: me.id, source: "rotate", shape: shapeOf(b.w, b.h), w: b.w, h: b.h, hand: deg });
    return json({ ok: true, rotated: Number(rotated), thumb });
  }
  // The meal's picture (the thumbnail on its card), set from one of its own photos. The page makes the
  // small JPEG itself (≤256 px); cleanThumb checks it. Owner only.
  const tm = sub.match(/^meal\/([^/]+)\/thumb$/);
  if (tm && request.method === "POST") {
    const row = await env.DB.prepare(`SELECT user_id FROM track_meals WHERE id = ?`).bind(tm[1]).first();
    if (!row || row.user_id !== me.id) return json({ error: "no such meal" }, 404);
    let form; try { form = await request.formData(); } catch { return json({ error: "bad request" }, 400); }
    const thumb = await cleanThumb(form.get("thumb"));
    if (!thumb) return json({ error: "bad picture", reason: "That picture couldn't be used. Try another." }, 400);
    await env.DB.prepare(`UPDATE track_meals SET thumb = ? WHERE id = ?`).bind(thumb, tm[1]).run();
    return json({ ok: true, thumb });
  }
  if (sub.startsWith("meal/")) {
    const id = sub.slice(5);
    const row = await env.DB.prepare(`SELECT id, user_id FROM track_meals WHERE id = ?`).bind(id).first();
    if (!row) return json({ error: "no such meal", reason: "That meal isn't there any more." }, 404);
    // A meal's own link (/food/meal/<id>): its owner, and anyone who may see the owner's days (household),
    // can open it. Anyone else is told it doesn't exist, so a link never confirms someone else's meal.
    if (request.method === "GET") {
      const mine = row.user_id === me.id;
      if (!mine && !(await canView(env, me.id, row.user_id))) return json({ error: "no such meal", reason: "That meal isn't yours or your household's." }, 404);
      const owner = mine ? null : await env.DB.prepare(`SELECT name FROM track_members WHERE user_id = ?`).bind(row.user_id).first();
      return json({ ok: true, meal: await readMeal(env, id), mine, owner: row.user_id, ownerName: owner?.name || "" });
    }
    if (row.user_id !== me.id) return json({ error: "not yours", reason: "You can look at a household member's day, but only they can change it." }, 403);
    if (request.method === "DELETE") { await forgetPhotos(env, me.id, id); await removedMeal(env, me, id); await env.DB.prepare(`DELETE FROM track_meals WHERE id = ?`).bind(id).run(); return json({ ok: true }); }
    if (request.method === "PATCH") {
      const items = sanitiseItems(body.items);
      if (!items.length) return json({ error: "no items", reason: "A meal needs at least one food. Delete it instead." }, 400);
      const t = totalsOf(items);
      await env.DB.prepare(`UPDATE track_meals SET items_json = ?, kcal = ?, protein_g = ?, carbs_g = ?, fat_g = ? WHERE id = ?`).bind(JSON.stringify(items), t.kcal, t.protein_g, t.carbs_g, t.fat_g, id).run();
      // A plan becoming a meal ("Had it"), or the other way. Confirming without a time means it happened now.
      const was = Boolean((await env.DB.prepare(`SELECT planned FROM track_meals WHERE id = ?`).bind(id).first())?.planned);
      const wantPlanned = body.planned === undefined ? was : cleanFlag(body.planned);
      if (wantPlanned !== was) await env.DB.prepare(`UPDATE track_meals SET planned = ? WHERE id = ?`).bind(wantPlanned ? 1 : 0, id).run();
      const confirming = was && !wantPlanned;
      const moved = await retimeMeal(env, me, id, confirming && !body.time ? { ...body, time: localClock(nowIso(), cleanOffset(body.tz) ?? 0) } : body);
      const meal = await readMeal(env, id);
      const after = confirming ? await confirmedMeal(env, me, meal, { tzOffsetMin: body.tz }) : await editedMeal(env, me, meal, { tzOffsetMin: body.tz });
      if (moved && !confirming) await retimeFavourite(env, me, meal, moved.from, moved.to);
      return json({ ok: true, meal, totals: after.totals, planned: after.planned, favourite: after.favourite, moved, confirmed: confirming });
    }
    return json({ error: "PATCH or DELETE" }, 405);
  }
  if (sub === "day" || sub === "week") {
    const target = String(url.searchParams.get("user") || me.id);
    if (target !== me.id && !(await canView(env, me.id, target))) return json({ error: "not allowed", reason: "You can only see days of people in your household." }, 403);
    const who = target === me.id ? me : await userById(env, me.bot, target);
    if (!who) return json({ error: "no such user" }, 404);
    return json(sub === "day" ? await dayView(env, who, pickDate(url.searchParams.get("date")), { readOnly: target !== me.id }) : await weekView(env, who, pickDate(url.searchParams.get("end"))));
  }
  // --- The day as a conversation (Engine/worker/track-day.js). ---------------------------
  if (sub === "chat") {
    const target = String(url.searchParams.get("user") || me.id);
    if (target !== me.id && !(await canView(env, me.id, target))) return json({ error: "not allowed" }, 403);
    const who = target === me.id ? me : await userById(env, me.bot, target);
    if (!who) return json({ error: "no such user" }, 404);
    return json({ ...(await dayChat(env, who, pickDate(url.searchParams.get("date")))), readOnly: target !== me.id });
  }
  if (sub === "say") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    if (!(await allowed(env, request))) return json({ error: "rate-limited", reason: "Give me a moment and try again." }, 429);
    return say(env, cfg, me, body);
  }
  if (sub === "favourites") return json(await listFavourites(env, me, { hour: url.searchParams.get("hour"), date: pickDate(url.searchParams.get("date")) }));
  if (sub === "transcribe") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    if (!(await allowed(env, request))) return json({ error: "rate-limited", reason: "Give me a moment and try again." }, 429);
    return transcribe(request, env);
  }
  if (sub === "repeat") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    const date = pickDate(body.date);
    const r = await repeatMeals(env, me, { favouriteId: body.favouriteId, fromDate: body.fromDate, date, mult: body.mult, insertMeal: (m) => insertMeal(env, me, { ...m, tz: body.tz, zone: body.zone, planned: body.planned }) });
    if (!r.ok) return json(r, r.status || 400);
    let totals = null;
    for (const m of r.meals) totals = (await afterMeal(env, me, m, { repeat: true, favouriteName: r.favourite?.name || "", tzOffsetMin: body.tz })).totals;
    return json({ ...r, totals });
  }
  if (sub === "favourite/name") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    const r = await nameFavourite(env, me, body.id, body.name); return json(r, r.ok ? 200 : r.status || 400);
  }
  if (sub.startsWith("favourite/") && request.method === "DELETE") return json(await forgetFavourite(env, me, sub.slice(10)));
  if (sub === "summary") {
    const target = String(url.searchParams.get("user") || me.id);
    if (target !== me.id && !(await canView(env, me.id, target))) return json({ error: "not allowed" }, 403);
    const who = target === me.id ? me : await userById(env, me.bot, target);
    if (!who) return json({ error: "no such user" }, 404);
    const kind = url.searchParams.get("kind") === "week" ? "week" : "day";
    if (!(await allowed(env, request))) return json({ error: "rate-limited" }, 429);
    return json(await summaryFor(env, who, { date: pickDate(url.searchParams.get("date")), kind, coachName: cfg.coachName, force: url.searchParams.get("refresh") === "1" }));
  }
  if (sub === "barcode") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    const out = await lookupBarcode(env, body.code);
    return json(out, out.ok ? 200 : 404);
  }
  if (sub === "weight/import") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    const out = await importWeights(env, me, body.rows);
    return json(out.ok ? { ...out, trend: await listWeights(env, me.id, 0) } : out, out.ok ? 200 : 400);
  }
  if (sub === "weight") {
    // GET ?days=N (default 30; 0 = all of it) — the weight screen asks for the range it shows.
    if (request.method === "GET") return json(await listWeights(env, me.id, url.searchParams.has("days") ? Number(url.searchParams.get("days")) : 30));
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    const out = await setWeight(env, me, body);
    if (out.ok && out.unit !== (me.targets?.unit || "kg")) await env.DB.prepare(`UPDATE track_users SET targets_json = ? WHERE id = ?`).bind(JSON.stringify({ ...(me.targets || {}), unit: out.unit }), me.id).run();
    return json(out.ok ? { ...out, trend: await listWeights(env, me.id, 30) } : out, out.ok ? 200 : 400);
  }
  if (sub === "household") {
    if (request.method === "GET") return json({ household: await householdView(env, me) });
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    const out = await createHousehold(env, me, body);
    return json(out.ok ? { ok: true, household: await householdView(env, me) } : out, out.ok ? 200 : 400);
  }
  if (sub === "household/join") { const out = await joinHousehold(env, me, body); return json(out.ok ? { ok: true, household: await householdView(env, me) } : out, out.ok ? 200 : 400); }
  if (sub === "household/leave") { return json(await leaveHousehold(env, me)); }
  if (sub === "receipts") { const h = await householdOf(env, me.id); return json(await listReceipts(env, { user: me, householdId: h?.id || null })); }
  if (sub.startsWith("receipt/") && request.method === "DELETE") {
    const h = await householdOf(env, me.id);
    const out = await deleteReceipt(env, { user: me, householdId: h?.id || null, id: sub.slice(8) });
    return json(out, out.ok ? 200 : out.status);
  }
  return json({ error: "not found" }, 404);
}

const PENDING_MESSAGE = "This email is already logging on another device. Use a passkey, sign in, type your authenticator code, or ask your coach to link this device.";

// The bot's food block + the sign-in methods it has on + the pepper. Every value already checked by Engine/worker/projects.js.
function foodConfig(bot, env) {
  const f = bot.food || {};
  const methods = signInMethods(bot, env);
  // siteName is for the "← back" link at the top of the app page: it is a different page from
// the bot list, so it has to say for itself where back goes.
  return { id: bot.id, name: bot.name, siteName: CONFIG.siteName || "", model: f.model, maxPhotoBytes: f.maxPhotoBytes, dailyPhotoLimit: f.dailyPhotoLimit, coachName: f.coachName, honesty: f.honesty, signIn: methods.providers, methods, pepper: pepperOf(env) };
}

// --- JOIN: first device creates the log; a second device gets a code instead (Engine/identity/devices.js). ---
async function join(env, cfg, body, keyHash, graceMinutes) {
  const email = cleanEmail(body.email);
  if (!email) return json({ error: "email", reason: "That doesn't look like an email address." }, 400);
  const r = await idJoin(env, cfg.id, { email, keyHash, graceMinutes });
  if (r.linked) return json({ linked: true, ...(await profile(env, await withProfile(env, r.user))), ...(r.fresh ? { fresh: true } : {}) });
  return json({ linked: false, code: r.code, email, message: PENDING_MESSAGE, signIn: cfg.signIn.map((s) => s.provider), methods: { passkeys: cfg.methods.passkeys, totp: cfg.methods.totp } }, 202);
}

// --- SIGN IN: the provider's ID token proves the email; the device is linked. ------
async function signIn(env, cfg, body, keyHash, me) {
  const provider = String(body.provider || "").toLowerCase();
  const conf = cfg.signIn.find((s) => s.provider === provider && s.clientId);
  if (!conf) return json({ error: "provider not configured" }, 404);
  const v = await verifyIdToken(body.idToken, provider, { clientId: conf.clientId });
  if (!v.ok) { console.warn("foodlog signin refused", provider, v.reason); return json({ error: "refused", reason: `Sign-in refused: ${v.reason}.` }, 401); }
  const userId = await userIdFor(v.email, env, cfg.id);
  if (me && me.id !== userId) return json({ error: "different email", reason: "This device is already linked to a different email." }, 409);
  const user = await bindDevice(env, cfg.id, { userId, email: v.email, keyHash, label: `signed in with ${provider}` });
  return json({ linked: true, ...(await profile(env, await withProfile(env, user))) });
}

// The Fix line sends the items on screen as `current`. What the model needs to see of each
// to leave it alone — no ids, no per-100 g table — and a forgiving reader for the field.
const slim = (items) => items.map(({ name, portion, grams, kcal, protein_g, carbs_g, fat_g }) => ({ name, portion, grams, kcal, protein_g, carbs_g, fat_g }));
// A quick look cut off mid-answer (a full plate is a long answer): every food that was written out whole still counts.
function salvagePeek(raw) {
  const t = String(raw || ""), items = [];
  // Each food is a short list, ["Fried eggs","",100,140,12,1,10] (a third the length of an object, so it streams three
  // times sooner); an object with "name" is taken too.
  for (const m of t.matchAll(/\[\s*"[^"]*"\s*,\s*"[^"]*"(?:\s*,\s*-?[\d.]+){5}\s*\]|\{\s*"name"[^{}]*\}/g)) { try { items.push(asPeekItem(JSON.parse(m[0]))); } catch {} }
  const field = (k) => (t.match(new RegExp(`"${k}"\\s*:\\s*"([^"]*)"`)) || [])[1] || "";
  return { shows: field("shows"), kind: field("kind"), items, scale: field("scale") };
}
const asPeekItem = (x) => (Array.isArray(x) ? { name: x[0], brand: x[1], grams: x[2], kcal: x[3], protein_g: x[4], carbs_g: x[5], fat_g: x[6] } : x);
// A quick look, made safe to show: short strings, numbers in range, at most six items.
function cleanPeek(p) {
  const str = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const num = (v, max) => { const x = Number(v); return Number.isFinite(x) ? Math.round(clamp(x, 0, max) * 10) / 10 : 0; };
  const kinds = ["food", "label", "scale", "package", "barcode", "receipt", "other"];
  const lab = p?.label || {};
  return {
    shows: str(p?.shows, 60), kind: kinds.includes(p?.kind) ? p.kind : "other",
    items: (Array.isArray(p?.items) ? p.items : []).map(asPeekItem).filter((it) => str(it?.name, 40)).slice(0, 6).map((it) => ({ name: str(it.name, 40), brand: str(it.brand, 30), grams: num(it.grams, 5000), kcal: num(it.kcal, 5000), protein_g: num(it.protein_g, 500), carbs_g: num(it.carbs_g, 800), fat_g: num(it.fat_g, 500) })),
    label: num(lab.kcal, 5000) || num(lab.protein_g, 500) ? { serving: str(lab.serving, 30), kcal: num(lab.kcal, 5000), protein_g: num(lab.protein_g, 500), carbs_g: num(lab.carbs_g, 800), fat_g: num(lab.fat_g, 500) } : null,
    scale: str(p?.scale, 20),
  };
}
function listFrom(v) { try { const x = typeof v === "string" ? JSON.parse(v) : v; return Array.isArray(x) ? x : []; } catch { return []; } }

// --- PHOTO: one call to the vision model, four kinds of picture. -----------------------
const MAX_PHOTOS = 10;                   // three products at three photos each, and one spare
async function photo(request, env, cfg, me) {
  let form;
  try { form = await request.formData(); } catch { return json({ error: "bad request", reason: "Expected a multipart form with a photo." }, 400); }
  // One photo or several (the page sends every photo in the box as "photo"), plus the words typed with them.
  const files = form.getAll("photo").filter((f) => f && typeof f.arrayBuffer === "function").slice(0, MAX_PHOTOS);
  if (!files.length) return json({ error: "no photo", reason: "No photo in the request." }, 400);
  for (const f of files) if (f.size > cfg.maxPhotoBytes) return json({ error: "too big", reason: `That photo is ${(f.size / 1048576).toFixed(1)} MB; the limit is ${(cfg.maxPhotoBytes / 1048576).toFixed(0)} MB. The page should have shrunk it — reload and try again.` }, 413);
  const kind = ["food", "barcode", "label", "receipt"].includes(form.get("kind")) ? form.get("kind") : "food";
  const date = pickDate(form.get("date"));
  const correction = String(form.get("correction") || "").trim().slice(0, 200);
  const said = String(form.get("text") || "").trim().slice(0, 600);
  const mealId = String(form.get("mealId") || "").trim();
  const hand = handOf(form.get("hand"));                  // photos the person turned by hand: stored with rotated=<degrees>
  // When the photos were taken (the page reads it from the photo itself): an earlier moment in the last two weeks.
  const takenMs = Date.parse(String(form.get("taken") || ""));
  const taken = Number.isFinite(takenMs) && takenMs < Date.now() - 10 * 60 * 1000 && takenMs > Date.now() - 14 * 864e5 ? new Date(takenMs).toISOString() : null;
  // A correction arrives with what's on screen now, so it can't undo an earlier one.
  const current = sanitiseItems(listFrom(form.get("current")), { source: "photo" });
  const revising = kind === "food" && Boolean(correction) && current.length > 0;

  // The daily cap counts reads (vision calls), whatever kind: a meal of 4 photos is one read (at most MAX_PHOTOS each).
  const used = (await env.DB.prepare(`SELECT photos FROM track_usage WHERE user_id = ? AND date = ?`).bind(me.id, todayUtc()).first())?.photos || 0;
  if (used >= cfg.dailyPhotoLimit) return json({ error: "daily-limit", reason: `That's ${cfg.dailyPhotoLimit} photo reads today — the daily limit. You can still type a meal.` }, 429);
  await env.DB.prepare(`INSERT INTO track_usage (user_id, date, photos) VALUES (?, ?, 1) ON CONFLICT(user_id, date) DO UPDATE SET photos = photos + 1`).bind(me.id, todayUtc()).run();

  const images = await Promise.all(files.map(async (f) => ({ bytes: await f.arrayBuffer(), mime: /^image\/(png|webp)$/.test(f.type) ? f.type : "image/jpeg" })));
  const thumb = await cleanThumb(form.get("thumb"));

  // The photos the page found a scale in (orient): each gets its own "read the display" call, alongside the main read.
  const scaleIdx = String(form.get("scales") || "").split(",").map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < images.length).slice(0, 4);
  const scaleReads = kind === "food" && !revising ? Promise.all(scaleIdx.map(async (i) => {
    try { const o = await runVision(env, cfg, { images: [images[i]], prompt: PROMPTS.scaleRead(), maxTokens: 40 }); return { photo: i + 1, display: String(extractJson(o.text)?.display || "").trim().slice(0, 30) }; }
    catch { return { photo: i + 1, display: "" }; }
  })) : Promise.resolve([]);
  let out, prompt;
  try {
    prompt = kind === "food" ? (revising ? PROMPTS.revise(slim(current), correction, true) : files.length > 1 || said ? PROMPTS.meal(said, files.length) : PROMPTS.food(correction)) : PROMPTS[kind];
    out = await runVision(env, cfg, { images, prompt, maxTokens: kind === "receipt" ? 1500 : 900 + 150 * (files.length - 1) });
  } catch (err) {
    console.error("foodlog vision failed", err?.message || err);
    return json({ error: "model", reason: "The model couldn't look at that just now. Try again, or type the meal." }, 502);
  }
  let parsed = extractJson(out.text);
  // A food with no calories that isn't a zero-calorie thing or label-based is the model skipping something it could
  // see (the turkey scale skipped in some runs; broccoli 198 g, 0 kcal; berries all 0). One more look; keep whichever
  // lost less. Runs on the model's own answer, before the scale readings and label maths fill anything in.
  const zeroCal = /water|creatine|electrolyte|coffee|\btea\b|diet|zero|sugar[- ]free|\bice\b|seltzer|sparkling water|salt|pepper|spice|vinegar|mustard/i;
  const blanks = (p) => (Array.isArray(p?.items) ? p.items : []).filter((i) => !(Number(i?.kcal) > 0) && !(i?.label_per_serving && Number(i.label_serving_g) > 0) && !zeroCal.test(String(i?.name || ""))).length;
  const empty = (p) => !(Array.isArray(p?.items) && p.items.length);
  if (kind === "food" && !revising && (empty(parsed) || blanks(parsed) > 0)) {
    try {
      const again = await runVision(env, cfg, { images, prompt, maxTokens: 900 + 150 * (files.length - 1) });
      const p2 = extractJson(again.text);
      const better = p2 && !empty(p2) && (empty(parsed) || blanks(p2) < blanks(parsed));
      if (better) { parsed = p2; out = again; }
      console.log(JSON.stringify({ event: "foodlog-second-look", used: Boolean(better) }));
    } catch (err) { console.warn("second look skipped", err?.message || err); }
  }
  // One food split in two — the label as one item (no weight), the weighed food as another (no label): "Norbest
  // Turkey 0 g" + "Ground Turkey 227 g, 340 kcal". Same name word → the label joins the weighed one; the empty one goes.
  if (Array.isArray(parsed?.items)) {
    const words = (n) => new Set(String(n || "").toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3));
    for (const lab of parsed.items.filter((i) => i?.label_per_serving && Number(i.label_serving_g) > 0 && !(Number(i.grams) > 0) && !(Number(i.weighed_g) > 0) && !String(i.scale_text || "").trim())) {
      const lw = words(lab.name);
      const mate = parsed.items.find((i) => i !== lab && !i.__gone && (Number(i.weighed_g) > 0 || String(i.scale_text || "").trim() || Number(i.grams) > 0) && !(i.label_per_serving && Number(i.label_serving_g) > 0) && [...words(i.name)].some((w) => lw.has(w)));
      if (!mate) continue;
      Object.assign(mate, { label_serving_g: lab.label_serving_g, label_per_serving: lab.label_per_serving, label_is_raw: lab.label_is_raw || mate.label_is_raw, from_label: true, barcode: mate.barcode || lab.barcode, brand: mate.brand || lab.brand, photos: [...new Set([...(mate.photos || []), ...(lab.photos || [])])] });
      if (!Number(mate.weighed_g) && Number(mate.grams) > 0 && !String(mate.scale_text || "").trim()) mate.weighed_g = Number(mate.grams);
      lab.__gone = true;
    }
    parsed.items = parsed.items.filter((i) => !i?.__gone);
  }
  // The focused scale readings go onto the food whose photos include that scale photo (the one without a label
  // item's own reading wins only if it agrees). Code turns the display into grams (track-yield.js scaleGrams).
  for (const sr of await scaleReads) {
    if (!sr.display || !scaleGrams(sr.display) || !Array.isArray(parsed?.items)) continue;
    const onIt = parsed.items.filter((i) => Array.isArray(i?.photos) && i.photos.map(Number).includes(sr.photo));
    const it = onIt.length === 1 ? onIt[0] : onIt.find((i) => !Number(i?.weighed_g)) || null;
    if (!it) continue;
    if (!String(it.scale_text || "").trim() || Math.abs((scaleGrams(it.scale_text) || 0) - scaleGrams(sr.display)) > 3) { it.scale_text = sr.display; it.weighed_g = Math.round(scaleGrams(sr.display) * 10) / 10; if (!Number(it.grams)) it.grams = it.weighed_g; }
    parsed.scale_read = true;
  }

  if (kind === "food") {
    // Label × weight is arithmetic, done here (track-yield.js), after the barcode step has supplied a label it knows.
    const labelled = (await useBarcodes(env, withBrands(parsed?.items, parsed?.photo_text, said))).map(applyLabelMath);
    const labelNote = labelled.map((i) => i.label_note).filter(Boolean).join(" ");
    // A food read off a scale is never zeroed by a guessed bowl unless the person said the bowl was on it. (A re-read
    // of the turkey "took off a 300 g bowl" and logged it as 0 g.)
    if (!/bowl|plate|container|tare/i.test(said)) for (const it of labelled) {
      const w = scaleGrams(it.scale_text) || Number(it.weighed_g) || 0, g = Number(it.grams) || 0;
      // Only a food taken to (almost) nothing: a zeroed-bowl read (berries) legitimately has grams below the display.
      if (!w || it.from_label || g > 5) continue;
      const f = g > 0 ? w / g : 0;
      Object.assign(it, { grams: w, ...(f ? { kcal: Math.round(it.kcal * f), protein_g: it.protein_g * f, carbs_g: it.carbs_g * f, fat_g: it.fat_g * f } : { confidence: 0.3 }) });
    }
    const steady = revising ? { items: labelled, used: [] } : await steadyItems(env, me, labelled);
    const fresh = sanitiseItems(steady.items, { source: "photo" });
    const items = revising ? mergeCorrection(current, fresh, correction) : fresh;
    if (revising && !fresh.length) return json({ error: "no food", reason: "I couldn't apply that correction. Try naming the food and the amount, like “8 strawberries”." }, 422);
    // No food, one photo, nothing half-done: it may be a receipt (there is no separate Receipt button any more).
    if (!items.length && !revising && !mealId && files.length === 1) {
      const rec = await readReceipt(env, cfg, me, images, thumb);
      if (rec) return json({ ok: true, kind: "receipt", ...rec });
    }
    if (!items.length) return json({ error: "no food", reason: parsed?.notes ? `I couldn't find food in that: ${String(parsed.notes).slice(0, 140)}` : "I couldn't make out any food in that photo. Try closer, with more light — or type it.", raw: out.text.slice(0, 300) }, 422);
    // "Read again" is a preview: the new read comes back for the person to check and Save; nothing is overwritten.
    if (mealId && form.get("preview") === "1") {
      const was = await readMeal(env, mealId);
      if (!was || !(await env.DB.prepare(`SELECT 1 FROM track_meals WHERE id = ? AND user_id = ?`).bind(mealId, me.id).first())) return json({ error: "no such meal" }, 404);
      if (form.get("replacePhotos") === "1") {
        try { await storePhotos(env, me.id, mealId, images, hand, { replace: true }); await env.DB.prepare(`UPDATE track_meals SET photos = ? WHERE id = ?`).bind(images.length, mealId).run(); was.photos = images.length; } catch (err) { console.warn("photos not replaced", err?.message || err); }
      }
      return json({ ok: true, preview: true, meal: { ...was, items, ...totalsOf(items) }, notes: (labelNote ? labelNote + " " : "") + String(parsed?.notes || "").slice(0, 300), ...(form.get("debug") === "1" ? { raw: out.text.slice(0, 4000) } : {}) });
    }
    const meal = mealId ? await updateMealItems(env, me, mealId, items) : await insertMeal(env, me, { date, items, source: "photo", thumb, tz: form.get("tz"), zone: form.get("zone"), planned: form.get("planned"), at: taken });
    if (!meal) return json({ error: "no such meal" }, 404);
    // Keep the photos with a new meal (R2), so they can be looked at — and a scale zoomed into — later.
    // "Read again" on a saved meal sends its photos back (straightened): they replace the stored ones.
    if (!mealId || form.get("replacePhotos") === "1") {
      try {
        await storePhotos(env, me.id, meal.id, images, hand, { replace: Boolean(mealId) });
        await env.DB.prepare(`UPDATE track_meals SET photos = ? WHERE id = ?`).bind(images.length, meal.id).run();
        meal.photos = images.length;
      } catch (err) { console.warn("photos not kept", err?.message || err); }
    }
    // The words sent with the photos are part of the day's conversation, before the reaction to them.
    if (said && !mealId) await addWords(env, me, meal.date, "user", "said", said, meal.id, meal.created_at);
    const after = mealId ? await editedMeal(env, me, meal, { tzOffsetMin: form.get("tz") }) : await afterMeal(env, me, meal, { tzOffsetMin: form.get("tz") });
    // "Make it a named meal: snack" — name the favourite this meal just taught.
    const twin = mealId ? null : await recentTwin(env, me, meal);
    const twinNote = twin ? `You logged this at ${twin.time || "a few minutes ago"} too — Discard if it's the same one. ` : "";
    // Scale displays in photos are misread often enough (glare, small digits) that the review says where the grams came from.
    const scaleNote = (labelNote ? labelNote + " " : "") + (parsed?.scale_unreadable === true && !/\d/.test(said) ? "I could see a scale but couldn't read it. " : parsed?.scale_read === true && !/\d/.test(said) && !labelNote ? "Weights read from your scale — tap any that look wrong, or type the weights with the photos. " : "");
    const timeNote = taken && !mealId ? `Time from your photo: ${meal.time}${meal.date !== todayUtc() ? " on " + meal.date : ""}. ` : "";
    const steadyNote = steady.used.length ? `Same numbers as your usual ${steady.used.slice(0, 2).join(" and ")}. ` : "";
    let q = parsed?.question && String(parsed.question.text || "").trim() ? { text: String(parsed.question.text).trim().slice(0, 140), options: (Array.isArray(parsed.question.options) ? parsed.question.options : []).map((o) => String(o).trim().slice(0, 60)).filter(Boolean).slice(0, 3) } : null;
    // A scale in the photos that couldn't be read: ask, rather than quietly using one label serving.
    if (!q && parsed?.scale_unreadable === true && !/\d/.test(said)) q = { text: "I couldn't read the scale — what does it say?", options: ["Use one serving for now", "I'll type the weight in Fix"] };
    const askedName = String(parsed?.name || "").trim().slice(0, 40);
    let named = null;
    if (askedName && after.favourite?.id) { await nameFavourite(env, me, after.favourite.id, askedName); named = askedName; }
    // debug=1 (tests): the model's own answer too — the person's own data, nothing more.
    return json({ ok: true, meal, notes: (twinNote + timeNote + steadyNote + scaleNote + String(parsed?.notes || "")).slice(0, 420), twin, question: q && q.options.length >= 2 ? q : null, honesty: HONESTY, totals: after.totals, named, photos: files.length, ...(form.get("debug") === "1" ? { raw: out.text.slice(0, 4000) } : {}) });
  }
  if (kind === "barcode") {
    const digits = String(parsed?.digits || "").replace(/\D/g, "");
    const found = digits ? await lookupBarcode(env, digits) : { ok: false, reason: "I couldn't read a barcode in that photo. Get the numbers under the bars sharp, or snap the nutrition label." };
    return json({ ...found, digits }, found.ok ? 200 : 422);
  }
  if (kind === "label") {
    const label = sanitiseLabel(parsed);
    if (!label) return json({ error: "no label", reason: "I couldn't read a nutrition label in that photo. Fill the frame with the label and try again." }, 422);
    const stored = await rememberLabel(env, label);
    return json({ ok: true, label, product: stored.product, key: stored.key, previous: stored.previous ? { product: stored.previous, when: stored.previous.fetched_at } : null });
  }
  if (kind === "receipt") {
    const receipt = sanitiseReceipt(parsed);
    if (!receipt || !receipt.items.length) return json({ error: "no receipt", reason: "I couldn't read that as a receipt. Flatten it, fill the frame, and try again." }, 422);
    const h = await householdOf(env, me.id);
    return json({ ok: true, receipt: await saveReceipt(env, { user: me, householdId: h?.id || null, receipt, thumb }), shared: Boolean(h) });
  }
  return json({ error: "unknown kind" }, 400);
}

// A photo sent as food that held no food: read it as a receipt. Null if it isn't one.
async function readReceipt(env, cfg, me, images, thumb) {
  try {
    const out = await runVision(env, cfg, { images, prompt: PROMPTS.receipt, maxTokens: 1500 });
    const receipt = sanitiseReceipt(extractJson(out.text));
    if (!receipt || receipt.items.length < 2) return null;
    const h = await householdOf(env, me.id);
    return { receipt: await saveReceipt(env, { user: me, householdId: h?.id || null, receipt, thumb }), shared: Boolean(h) };
  } catch (err) { console.warn("receipt fallback failed", err?.message || err); return null; }
}

// The page sends a ≤256 px JPEG it made itself. We keep it only if it really is
// small — dimensions read from the header, bytes capped — else no thumbnail (fail open).
async function cleanThumb(t) {
  if (!t || typeof t.arrayBuffer !== "function" || t.size === 0 || t.size > THUMB_MAX_BYTES) return null;
  const bytes = await t.arrayBuffer();
  const size = imageSize(bytes);
  if (!size || size.w > THUMB_MAX_PX || size.h > THUMB_MAX_PX) return null;
  return `data:image/${size.type};base64,${toBase64(bytes)}`;
}

// --- TEXT: "2 eggs and toast" → the same JSON, no photo. --------------------------
async function textMeal(env, cfg, me, body) {
  const text = String(body.text || "").trim().slice(0, 300);
  if (!text) return json({ error: "empty", reason: "Type what you ate." }, 400);
  const correction = String(body.correction || "").trim().slice(0, 200);
  // Same as the photo route: a correction arrives with the items on screen, and only
  // the ones it names may change.
  const current = sanitiseItems(listFrom(body.current), { source: "text" });
  const revising = Boolean(correction) && current.length > 0;
  let out;
  try { out = await runVision(env, cfg, { prompt: revising ? PROMPTS.revise(slim(current), correction, false) : PROMPTS.text(text, correction), maxTokens: 900 }); }
  catch (err) { console.error("foodlog text model failed", err?.message || err); return json({ error: "model", reason: "The model isn't answering just now. Try again in a minute." }, 502); }
  const parsed = extractJson(out.text);
  const fresh = sanitiseItems(parsed?.items, { source: "text" });
  const items = revising ? mergeCorrection(current, fresh, correction) : fresh;
  if (revising && !fresh.length) return json({ error: "no food", reason: "I couldn't apply that correction. Try naming the food and the amount, like “8 strawberries”." }, 422);
  if (!items.length) return json({ error: "no food", reason: "I couldn't turn that into foods. Try naming them plainly: '2 eggs, 1 slice of toast'." }, 422);
  const mealId = String(body.mealId || "").trim();
  const meal = mealId ? await updateMealItems(env, me, mealId, items) : await insertMeal(env, me, { date: pickDate(body.date), items, source: "text", thumb: null, tz: body.tz, zone: body.zone, planned: body.planned });
  if (!meal) return json({ error: "no such meal" }, 404);
  const after = mealId ? await editedMeal(env, me, meal, { tzOffsetMin: body.tz }) : await afterMeal(env, me, meal, { tzOffsetMin: body.tz });
  return json({ ok: true, meal, notes: String(parsed?.notes || "").slice(0, 200), honesty: HONESTY, totals: after.totals });
}

// --- THE MIC: the clip goes to Whisper on Workers AI (the same model the chat page uses,
//     YourBots/config.js → voice.sttModel), never to the browser's own speech service. ------
const STT_DEFAULT = "@cf/openai/whisper-large-v3-turbo";
async function transcribe(request, env) {
  if (!env.AI) return json({ error: "no-model", reason: "Voice needs Workers AI (wrangler.jsonc → ai binding)." }, 503);
  let form;
  try { form = await request.formData(); } catch { return json({ error: "bad request", reason: "Send the clip as multipart/form-data in an 'audio' field." }, 400); }
  const clip = form.get("audio");
  if (!clip || typeof clip.arrayBuffer !== "function") return json({ error: "bad request", reason: "No audio in the request." }, 400);
  if (clip.size > 4 * 1024 * 1024) return json({ error: "too-long", reason: "That clip is too big. Keep it under 30 seconds." }, 413);
  if (clip.size < 100) return json({ error: "empty", reason: "I didn't get any audio. Try again." }, 400);
  const model = String(CONFIG.voice?.sttModel || "").trim() || STT_DEFAULT;
  const t0 = Date.now();
  let out;
  try { out = await env.AI.run(model, { audio: toBase64(await clip.arrayBuffer()) }); }
  catch (err) { console.error("foodlog transcribe failed", err?.message || err); return json({ error: "model-error", reason: "I couldn't make out that clip. Try again, or type it." }, 502); }
  const text = String(out?.text || "").trim();
  console.log(JSON.stringify({ event: "foodlog-transcribe", bytes: clip.size, chars: text.length, ms: Date.now() - t0 }));
  if (!text) return json({ error: "empty", reason: "I couldn't hear any words in that. Try again a little closer to the mic." }, 422);
  return json({ text });
}

// --- SAY: one box for everything. A question goes to the coach; "chicken rice again" matches a
//     favourite before any model runs; anything else that reads like food is estimated. ---------
async function say(env, cfg, me, body) {
  const text = String(body.text || "").trim().slice(0, 600);
  const date = pickDate(body.date);
  if (!text) return json({ error: "empty", reason: "Say what you ate, or ask something." }, 400);
  const kind = classifySay(text);
  if (kind === "log") {
    const asked = isLogAsk(text), food = asked ? stripLogAsk(text) : text;
    const m = await matchFavourite(env, me, food);
    if (m) {
      const f = m.favourite;
      const when = f.lastUsed ? new Date(f.lastUsed).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }) : "before";
      return json({ ok: true, kind: "repeat", favourite: f, question: `Logging your ${f.label} from ${when}, about ${Math.round(f.kcal)} kcal. Right?` });
    }
    if (asked || looksLikeFood(text)) {
      const r = await textMeal(env, cfg, me, { text: food, date, tz: body.tz, zone: body.zone, planned: body.planned });
      const d = await r.json();
      if (r.ok) return json({ ok: true, kind: "meal", ...d });
      if (d.error !== "no food") return json(d, r.status);
      // Not food after all: let the coach answer it.
    }
  }
  const u = await addWords(env, me, date, "user", "question", text);
  let a;
  try { a = await askDay(env, me, { date, text, coachName: cfg.coachName }); }
  catch (err) { console.error("foodlog ask failed", err?.message || err); return json({ error: "model", reason: "The coach isn't answering just now. Try again in a minute." }, 502); }
  const w = await addWords(env, me, date, "assistant", "answer", a.reply);
  return json({ ok: true, kind: "answer", turns: [u, w] });
}

// --- A meal saved by hand (barcode / label / receipt items come through here). ----
async function saveMeal(env, me, body) {
  const items = sanitiseItems(body.items, { source: ["barcode", "label", "text", "photo", "receipt"].includes(body.source) ? body.source : "text" });
  if (!items.length) return json({ error: "no items", reason: "Nothing to save." }, 400);
  const meal = await insertMeal(env, me, { date: pickDate(body.date), items, source: items[0].source, thumb: null, tz: body.tz, zone: body.zone, planned: body.planned });
  const after = await afterMeal(env, me, meal, { tzOffsetMin: body.tz });
  return json({ ok: true, meal, totals: after.totals });
}

// A meal moved to another clock time on the same day (v3.13): "HH:MM" on the person's clock, in the zone the
// browser is in NOW. The row's created_at follows so the thread re-sorts, the reaction line moves with its card,
// and the caller swaps the hour in the favourite's history. Returns { from, to } as rounded local hours, or null.
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
async function retimeMeal(env, me, id, body) {
  const time = String(body.time || "").trim();
  if (!TIME_RE.test(time)) return null;
  const old = await env.DB.prepare(`SELECT date, time, created_at, tz_offset FROM track_meals WHERE id = ? AND user_id = ?`).bind(id, me.id).first();
  if (!old) return null;
  const offset = cleanOffset(body.tz) ?? 0;
  const createdAt = new Date(Date.parse(`${old.date}T${time}:00.000Z`) + offset * 60000).toISOString();
  if (createdAt === old.created_at) return null;
  await env.DB.batch([
    env.DB.prepare(`UPDATE track_meals SET time = ?, created_at = ?, tz = ?, tz_offset = ? WHERE id = ?`).bind(time, createdAt, cleanZone(body.zone), offset, id),
    env.DB.prepare(`UPDATE track_day_chat SET created_at = ? WHERE user_id = ? AND meal_id = ? AND kind = 'reaction'`).bind(createdAt, me.id, id),
  ]);
  // The hour it was: on its own clock if the row knew its offset; a row from before zones is read in the person's current zone.
  return { from: Math.round(localHour(old.created_at, old.tz_offset ?? offset)), to: Math.round(localHour(createdAt, offset)) };
}
async function insertMeal(env, me, { date, items, source, thumb, tz, zone, planned, at = null }) {
  const id = randomId(12), t = totalsOf(items), now = at || nowIso();
  const offset = cleanOffset(tz);
  await env.DB.prepare(`INSERT INTO track_meals (id, user_id, date, time, items_json, kcal, protein_g, carbs_g, fat_g, thumb, source, created_at, tz, tz_offset, planned) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, me.id, date, localClock(now, offset), JSON.stringify(items), t.kcal, t.protein_g, t.carbs_g, t.fat_g, thumb, source, now, cleanZone(zone), offset, cleanPlanned(planned, date) ? 1 : 0).run();
  return readMeal(env, id);
}
async function updateMealItems(env, me, id, items) {
  const row = await env.DB.prepare(`SELECT user_id FROM track_meals WHERE id = ?`).bind(id).first();
  if (!row || row.user_id !== me.id) return null;
  const t = totalsOf(items);
  await env.DB.prepare(`UPDATE track_meals SET items_json = ?, kcal = ?, protein_g = ?, carbs_g = ?, fat_g = ? WHERE id = ?`).bind(JSON.stringify(items), t.kcal, t.protein_g, t.carbs_g, t.fat_g, id).run();
  return readMeal(env, id);
}
// ---- a meal's photos: R2 when a bucket is bound, else D1 (track_photo_parts) ----
// Out of the box there is no R2 (it asks for a card), so photos live in the database and the scale can still be
// zoomed into. Bind PHOTOS later and new photos go to R2; the ones already in D1 keep being served from there.
const photoKey = (userId, mealId, i) => `meals/${userId}/${mealId}/${i}.jpg`;
const PART_BYTES = 512 * 1024;                     // ≈ 700 KB of base64 a row, well under D1's 2 MB
// One photo, wherever it lives (R2 first, then D1): { bytes, mime, meta } — meta.rotated is set when the person turned
// it by hand. null if there is none.
async function getPhoto(env, userId, mealId, i) {
  if (env.PHOTOS) {
    const o = await env.PHOTOS.get(photoKey(userId, mealId, i));
    if (o) return { bytes: await o.arrayBuffer(), mime: o.httpMetadata?.contentType || "image/jpeg", meta: { ...(o.customMetadata || {}) } };
  }
  const parts = (await env.DB.prepare(`SELECT mime, data, rotated FROM track_photo_parts WHERE meal_id = ? AND i = ? AND user_id = ? ORDER BY part`).bind(mealId, Number(i), userId).all()).results || [];
  if (!parts.length) return null;
  const chunks = parts.map((r) => Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0)));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0; for (const c of chunks) { out.set(c, at); at += c.length; }
  return { bytes: out.buffer, mime: parts[0].mime || "image/jpeg", meta: parts[0].rotated != null ? { rotated: String(parts[0].rotated) } : {} };
}
// Write one photo where new photos go: R2 when a bucket is bound, else D1 (its old pieces replaced).
async function putPhoto(env, userId, mealId, i, bytes, mime = "image/jpeg", meta = {}) {
  if (env.PHOTOS) return env.PHOTOS.put(photoKey(userId, mealId, i), bytes, { httpMetadata: { contentType: mime }, ...(Object.keys(meta).length ? { customMetadata: meta } : {}) });
  const b = new Uint8Array(bytes), rotated = meta.rotated !== undefined ? String(meta.rotated) : null;
  const rows = [env.DB.prepare(`DELETE FROM track_photo_parts WHERE meal_id = ? AND i = ? AND user_id = ?`).bind(mealId, Number(i), userId)];
  for (let part = 0, at = 0; at < b.length; part++, at += PART_BYTES)
    rows.push(env.DB.prepare(`INSERT OR REPLACE INTO track_photo_parts (meal_id, i, part, user_id, mime, data, rotated) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(mealId, Number(i), part, userId, mime || "image/jpeg", toBase64(b.subarray(at, at + PART_BYTES)), rotated));
  for (let k = 0; k < rows.length; k += 4) await env.DB.batch(rows.slice(k, k + 4));   // a few rows a round trip
}
// The photo as it first arrived, kept once before anything overwrites it, and never overwritten: <i>-orig.jpg in R2,
// or photo number i + ORIG in D1 (never served: photo numbers in the address are two digits).
const ORIG = 1000;
async function keepOriginal(env, userId, mealId, i, photo) {
  if (env.PHOTOS) {
    const key = photoKey(userId, mealId, i).replace(/\.jpg$/, "-orig.jpg");
    if (await env.PHOTOS.head(key)) return;
    return env.PHOTOS.put(key, photo.bytes, { httpMetadata: { contentType: photo.mime }, customMetadata: photo.meta || {} });
  }
  if (await env.DB.prepare(`SELECT 1 FROM track_photo_parts WHERE meal_id = ? AND i = ? AND user_id = ? LIMIT 1`).bind(mealId, Number(i) + ORIG, userId).first()) return;
  return putPhoto(env, userId, mealId, Number(i) + ORIG, photo.bytes, photo.mime, photo.meta || {});
}
async function servePhoto(env, userId, mealId, i) {
  const ph = await getPhoto(env, userId, mealId, i);
  if (!ph) return json({ error: "no such photo" }, 404);
  // x-rotated: the person turned this photo by hand (the page then leaves it as it is when it reads it again).
  return new Response(ph.bytes, { headers: { "content-type": ph.mime, "cache-control": "private, no-store", ...(ph.meta.rotated !== undefined ? { "x-rotated": String(ph.meta.rotated) } : {}) } });
}
// "0:90,2:180" → Map { 0 → 90, 2 → 180 }: which photos the person turned by hand, and by how much (clockwise).
function handOf(v) {
  const m = new Map();
  for (const part of String(v || "").split(",")) {
    const [i, d] = part.split(":").map(Number);
    if (Number.isInteger(i) && i >= 0 && i < MAX_PHOTOS && [0, 90, 180, 270].includes(d)) m.set(i, d);
  }
  return m;
}
const sameBytes = (a, b) => { const x = new Uint8Array(a), y = new Uint8Array(b); if (x.length !== y.length) return false; for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false; return true; };
// Store a meal's photos. replace: "Read again" sends them back (straightened) — each stored photo is kept as its
// original first if the new bytes differ, keeps its metadata (a hand turn stays a hand turn), and photos beyond the
// new count go (their originals stay until the meal is deleted).
async function storePhotos(env, userId, mealId, images, hand = new Map(), { replace = false } = {}) {
  await Promise.all(images.map(async (im, i) => {
    let meta = {};
    if (replace) {
      const old = await getPhoto(env, userId, mealId, i);
      if (old) { meta = { ...old.meta }; if (!sameBytes(old.bytes, im.bytes)) await keepOriginal(env, userId, mealId, i, old); }
    }
    if (hand.has(i)) meta.rotated = String(hand.get(i));
    await putPhoto(env, userId, mealId, i, im.bytes, im.mime, meta);
  }));
  if (!replace) return;
  if (env.PHOTOS) {
    const l = await env.PHOTOS.list({ prefix: `meals/${userId}/${mealId}/` });
    const extra = l.objects.map((o) => o.key).filter((k) => { const m = k.match(/\/(\d+)\.jpg$/); return m && Number(m[1]) >= images.length; });
    if (extra.length) await env.PHOTOS.delete(extra);
  }
  await env.DB.prepare(`DELETE FROM track_photo_parts WHERE meal_id = ? AND user_id = ? AND i >= ? AND i < ?`).bind(mealId, userId, images.length, ORIG).run();
}
async function forgetPhotos(env, userId, mealId) {
  if (env.PHOTOS) { try { const l = await env.PHOTOS.list({ prefix: `meals/${userId}/${mealId}/` }); if (l.objects.length) await env.PHOTOS.delete(l.objects.map((o) => o.key)); } catch (err) { console.warn("photos not deleted", err?.message || err); } }
  try { await env.DB.prepare(`DELETE FROM track_photo_parts WHERE meal_id = ? AND user_id = ?`).bind(mealId, userId).run(); } catch (err) { console.warn("photos not deleted (D1)", err?.message || err); }
}
async function readMeal(env, id) {
  const r = await env.DB.prepare(`SELECT * FROM track_meals WHERE id = ?`).bind(id).first();
  return r ? mealOut(r) : null;
}
function mealOut(r) { let items = []; try { items = JSON.parse(r.items_json); } catch {} return { id: r.id, date: r.date, time: r.time, items, kcal: r.kcal, protein_g: r.protein_g, carbs_g: r.carbs_g, fat_g: r.fat_g, thumb: r.thumb, source: r.source, created_at: r.created_at, zone: r.tz || null, tzOffset: r.tz_offset ?? null, planned: Boolean(r.planned), photos: Number(r.photos) || 0 }; }

// --- THE DAY and THE WEEK. -------------------------------------------------------------
async function dayView(env, who, date, { readOnly = false } = {}) {
  const rows = (await env.DB.prepare(`SELECT * FROM track_meals WHERE user_id = ? AND date = ? ORDER BY created_at`).bind(who.id, date).all()).results || [];
  const meals = rows.map(mealOut);
  const totals = totalsOf(meals.filter((m) => !m.planned));
  const plannedMeals = meals.filter((m) => m.planned);
  const planned = { ...totalsOf(plannedMeals), meals: plannedMeals.length };
  const weightRow = await env.DB.prepare(`SELECT kg FROM track_weights WHERE user_id = ? AND date = ?`).bind(who.id, date).first();
  return { date, targets: who.targets, totals, planned, meals, weight: weightRow?.kg ?? null, weights: await listWeights(env, who.id, 30), readOnly, name: who.name || null, honesty: HONESTY };
}

async function weekView(env, who, end) {
  const start = addDays(end, -6);
  const rows = (await env.DB.prepare(`SELECT date, SUM(kcal) kcal, SUM(protein_g) protein_g, SUM(carbs_g) carbs_g, SUM(fat_g) fat_g, COUNT(*) meals FROM track_meals WHERE user_id = ? AND date BETWEEN ? AND ? AND planned = 0 GROUP BY date`).bind(who.id, start, end).all()).results || [];
  const plans = (await env.DB.prepare(`SELECT date, SUM(kcal) kcal, COUNT(*) meals FROM track_meals WHERE user_id = ? AND date BETWEEN ? AND ? AND planned = 1 GROUP BY date`).bind(who.id, start, end).all()).results || [];
  const byDate = Object.fromEntries(rows.map((r) => [r.date, r]));
  const planBy = Object.fromEntries(plans.map((r) => [r.date, r]));
  const days = [];
  for (let i = 0; i < 7; i++) { const d = addDays(start, i); const r = byDate[d]; const p = planBy[d]; days.push({ date: d, kcal: Math.round(r?.kcal || 0), protein_g: round1(r?.protein_g || 0), carbs_g: round1(r?.carbs_g || 0), fat_g: round1(r?.fat_g || 0), meals: r?.meals || 0, planned: Math.round(p?.kcal || 0), plannedMeals: p?.meals || 0 }); }
  return { start, end, days, targets: who.targets, streak: await streakOf(env, who.id, end), adherence: adherenceOf(days, who.targets) };
}

// Streak: consecutive days with at least one meal, ending today or yesterday (today isn't over).
async function streakOf(env, userId, today) {
  const rows = (await env.DB.prepare(`SELECT DISTINCT date FROM track_meals WHERE user_id = ? AND date <= ? AND planned = 0 ORDER BY date DESC LIMIT 400`).bind(userId, today).all()).results || [];
  const have = new Set(rows.map((r) => r.date));
  let d = have.has(today) ? today : addDays(today, -1), n = 0;
  while (have.has(d)) { n++; d = addDays(d, -1); }
  return n;
}
// Adherence: of the logged days in the window, how many landed within ±15% of the calorie target.
function adherenceOf(days, targets) {
  const goal = Number(targets?.kcal) || 0;
  const logged = days.filter((d) => d.meals > 0);
  if (!goal || !logged.length) return null;
  const hit = logged.filter((d) => Math.abs(d.kcal - goal) / goal <= 0.15).length;
  return Math.round(100 * hit / logged.length);
}

// --- PEOPLE. Identity rows come from Engine/identity/; the food profile (targets) is track_users. ----
async function withProfile(env, user) {
  if (!user) return null;
  let r = await env.DB.prepare(`SELECT targets_json, created_at, last_seen FROM track_users WHERE id = ?`).bind(user.id).first();
  if (!r) { await env.DB.prepare(`INSERT OR IGNORE INTO track_users (id, targets_json, created_at, last_seen) VALUES (?, NULL, ?, ?)`).bind(user.id, user.created_at || nowIso(), nowIso()).run(); r = {}; }
  let targets = null; try { targets = r.targets_json ? JSON.parse(r.targets_json) : null; } catch {}
  return { id: user.id, bot: user.bot, email: user.email, targets, name: targets?.name || null, created_at: user.created_at, last_seen: user.last_seen };
}
async function userById(env, bot, id) { return withProfile(env, await idUserById(env, bot, id)); }
function touch(env, me) { idTouch(env, me); env.DB.prepare(`UPDATE track_users SET last_seen = ? WHERE id = ?`).bind(nowIso(), me.id).run().catch(() => {}); }
async function profile(env, me) {
  return { userId: me.id, email: me.email, targets: me.targets, devices: (await deviceCount(env, me.id)) || 1, household: await householdView(env, me) };
}
async function householdView(env, me) {
  const h = await householdOf(env, me.id);
  if (!h) return null;
  const members = [];
  for (const m of h.members) members.push({ ...m, weights: await listWeights(env, m.id, 30) });
  return { ...h, members };
}

function cleanTargets(t) {
  t = t && typeof t === "object" ? t : {};
  return {
    kcal: Math.round(clamp(t.kcal, 800, 8000, 2000)), protein_g: Math.round(clamp(t.protein_g, 0, 500, 150)),
    carbs_g: Math.round(clamp(t.carbs_g, 0, 1000, 200)), fat_g: Math.round(clamp(t.fat_g, 0, 400, 65)),
    unit: t.unit === "lb" ? "lb" : "kg", name: String(t.name || "").trim().slice(0, 40), preset: String(t.preset || "").slice(0, 12), weight_kg: round1(clamp(t.weight_kg, 0, 400, 0)) || null,
    goal_kg: round1(clamp(t.goal_kg, 0, 400, 0)) || null,   // optional: the weight screen draws it and projects a date
  };
}

// --- THE COACH (admin token). One bot's clients only. ------------------------------------
async function handleCoach(request, env, url, cfg, sub) {
  const cp = sub.match(/^meal\/([^/]+)\/photo\/(\d{1,2})$/);
  if (cp) { const row = await env.DB.prepare(`SELECT user_id FROM track_meals WHERE id = ?`).bind(cp[1]).first(); return row ? servePhoto(env, row.user_id, cp[1], cp[2]) : json({ error: "no such photo" }, 404); }
  // A meal link opened by the coach: whose meal it is, so the coach page can open that client.
  if (sub.startsWith("meal/")) {
    const row = await env.DB.prepare(`SELECT user_id, date FROM track_meals WHERE id = ?`).bind(sub.slice(5)).first();
    return row ? json({ ok: true, client: row.user_id, date: row.date }) : json({ error: "no such meal" }, 404);
  }
  if (sub === "clients") return json({ clients: await clientRows(env, cfg.id), coachName: cfg.coachName, name: cfg.name, id: cfg.id });
  if (sub.startsWith("client/") && sub.endsWith("/summary")) {
    const who = await userById(env, cfg.id, sub.slice(7, -8));
    if (!who) return json({ error: "no such client" }, 404);
    const kind = url.searchParams.get("kind") === "day" ? "day" : "week";
    return json(await summaryFor(env, who, { date: pickDate(url.searchParams.get("end") || url.searchParams.get("date")), kind, coachName: cfg.coachName, force: url.searchParams.get("refresh") === "1" }));
  }
  if (sub.startsWith("client/")) {
    const who = await userById(env, cfg.id, sub.slice(7));
    if (!who) return json({ error: "no such client" }, 404);
    const end = todayUtc();
    const days = [];
    for (let i = 6; i >= 0; i--) days.push(await dayView(env, who, addDays(end, -i)));
    const week = await weekView(env, who, end);
    return json({ client: { ...who, household: await householdOf(env, who.id) }, days, week, pending: await pendingByEmail(env, cfg.id, who.email), devices: await listDevices(env, who.id) });
  }
  if (sub === "export.csv") return csv(await clientRows(env, cfg.id));
  if (sub === "link") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    const b = await readJson(request);
    const out = await linkByCode(env, cfg.id, { email: cleanEmail(b.email), code: b.deviceCode || b.code });
    return json(out, out.ok ? 200 : out.status || 400);
  }
  return json({ error: "not found" }, 404);
}
async function clientRows(env, bot) {
  const rows = (await env.DB.prepare(`SELECT u.id, u.email, u.created_at, u.last_seen, t.targets_json, (SELECT MAX(created_at) FROM track_meals m WHERE m.user_id = u.id AND m.planned = 0) last_log, (SELECT COUNT(*) FROM id_devices d WHERE d.user_id = u.id) devices, (SELECT COUNT(*) FROM id_pending p WHERE p.bot = u.bot AND p.email = u.email) pending, (SELECT h.name FROM track_members mb JOIN track_households h ON h.id = mb.household_id WHERE mb.user_id = u.id) household FROM id_users u LEFT JOIN track_users t ON t.id = u.id WHERE u.bot = ? ORDER BY last_log DESC`).bind(bot).all()).results || [];
  const out = [];
  for (const r of rows) {
    let targets = null; try { targets = r.targets_json ? JSON.parse(r.targets_json) : null; } catch {}
    const who = { id: r.id, email: r.email, targets, name: targets?.name || null, created_at: r.created_at, last_seen: r.last_seen };
    const week = await weekView(env, who, todayUtc());
    const w = await listWeights(env, who.id, 30);
    out.push({ id: who.id, email: who.email, name: who.name, targets: who.targets, created_at: who.created_at, last_seen: who.last_seen, last_log: r.last_log, devices: r.devices, pending: r.pending, household: r.household, streak: week.streak, adherence: week.adherence, daysLogged: week.days.filter((d) => d.meals).length, avgKcal: Math.round(week.days.filter((d) => d.meals).reduce((a, d) => a + d.kcal, 0) / (week.days.filter((d) => d.meals).length || 1)), weight: w.latest, weightChange30: w.change });
  }
  return out;
}

function csv(rows) {
  const cols = ["email", "name", "kcal_target", "protein_target", "carbs_target", "fat_target", "streak", "adherence_pct", "days_logged_7d", "avg_kcal_7d", "weight_kg", "weight_change_30d", "household", "last_log", "created_at"];
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [cols.join(",")].concat(rows.map((r) => [r.email, r.name, r.targets?.kcal, r.targets?.protein_g, r.targets?.carbs_g, r.targets?.fat_g, r.streak, r.adherence, r.daysLogged, r.avgKcal, r.weight, r.weightChange30, r.household, r.last_log, r.created_at].map(q).join(",")));
  return new Response(lines.join("\n") + "\n", { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="clients-${todayUtc()}.csv"` } });
}
