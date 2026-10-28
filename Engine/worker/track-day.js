// ============================================================================
//  FOOD LOG — THE DAY IS A CONVERSATION (v3.10).
//
//  In plain English:
//   · Every day is a thread. A photo, a barcode, a typed "2 eggs and toast" or a
//     tapped favourite is a turn in it; the meal card is what comes back, with a
//     one-line reaction written by CODE (no model call: "Logged. 640 kcal, 1,360
//     left. Protein 45 of 150."). The person can also TALK to the day — "was lunch
//     too much?" — and the coach bot answers from the day's own numbers.
//   · The Day tab is a written summary of one day: what you ate, where you landed,
//     one thing that went well, one thing for tomorrow. The Week tab is the
//     patterns across seven of those. Both are ONE small model call, cached in
//     track_summaries under a hash of the meals, so nothing regenerates unless
//     the food changed. The model is handed the computed totals as facts and told
//     it may not invent numbers.
//   · Repeats. People eat the same things. Every saved meal becomes a favourite
//     (track_favourites, keyed on its item names): a chip above the composer, the
//     ones eaten at this time of day first ("usually now" once that is true twice);
//     a tap puts it in the box and send logs it. "same as yesterday" copies a day;
//     typing "chicken rice again" matches a favourite BEFORE any model runs. After
//     three uses the coach asks once for a name ("work lunch"); every fifth repeat
//     asks "still about this much?" so a repeat never quietly drifts.
//   · Nothing here sends email. The coach reads the same week paragraph.
//
//  Routes (all under /api/apps/<id>/, known device only — wired in track.js):
//    GET  chat?date=                    the day's turns: meals and words, in order
//    POST say {date, text, hour}        one composer for everything → { kind: "repeat" | "meal" | "answer", … }
//    GET  favourites?hour=&date=        the chips: staples for now, then the rest, + whether yesterday can be copied
//    POST repeat {favouriteId | fromDate, date, mult}   log a favourite again, or copy a whole day
//    POST favourite/name {id, name}     name a staple · DELETE favourite/<id>
//    GET  summary?date=&kind=day|week   the written summary (cached; generated when the food changed)
//  Coach (admin): GET client/<id>/summary?kind=week&end=
// ============================================================================

import { CONFIG } from "../../YourBots/config.js";
import { complete } from "./gateway.js";
import { json, nowIso, pickDate, addDays, todayUtc, randomId, round1, sha256hex } from "./track-common.js";
import { totalsOf, sanitiseItems } from "./track-vision.js";

let SCHEMA_OK = false;
export async function ensureDaySchema(env) {
  if (SCHEMA_OK || !env.DB) return;
  await env.DB.batch([
    // The words of a day: the person's questions and the coach's answers, and the code-written reactions to meals.
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS track_day_chat (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, date TEXT NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, meal_id TEXT, created_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_track_day_chat ON track_day_chat(user_id, date, id)`),
    // The summaries: one row per person per date per kind, with the hash of what it summarised.
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS track_summaries (user_id TEXT NOT NULL, date TEXT NOT NULL, kind TEXT NOT NULL, json TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (user_id, date, kind))`),
    // The favourites: every distinct meal, how often, when in the day, and the name the person gave it.
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS track_favourites (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, key TEXT NOT NULL, name TEXT, items_json TEXT NOT NULL, kcal REAL, protein_g REAL, carbs_g REAL, fat_g REAL, thumb TEXT, hours TEXT, times_used INTEGER DEFAULT 1, last_used TEXT, name_asked INTEGER DEFAULT 0, created_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_track_fav_key ON track_favourites(user_id, key)`),
  ]);
  SCHEMA_OK = true;
}

// ---------------------------------------------------------------- helpers
// Words, lower-cased, stop words out, crude singulars ("eggs" → "egg", "berries" → "berry") so plurals match.
const stem = (w) => (w.length > 4 && w.endsWith("ies") ? w.slice(0, -3) + "y" : w.length > 3 && w.endsWith("es") && /[sxz]es$|[cs]hes$/.test(w) ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
const words = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)).map(stem);
const STOP = new Set(["the", "a", "an", "and", "with", "of", "my", "some", "again", "same", "usual", "log", "had", "ate", "for", "on", "in", "to", "it", "that", "this", "please", "me", "i", "just", "one", "two", "as", "like", "yesterday", "today", "breakfast", "lunch", "dinner", "snack", "another", "more", "again"]);
const FOOD_HINT = /\b(again|same|usual|log|had|ate|eat|eating|breakfast|lunch|dinner|snack|bowl|plate|cup|slice|glass|piece|grams?|g\b|oz\b|ml\b|serving|portion|another)\b/i;
const QUESTION_HINT = /\?|^(what|how|why|should|can|could|is|are|was|were|do|does|did|am|will|would|which|when|where|who)\b/i;
// "can you log some berries", "please add a banana", "log 1 cup strawberries?": a request to log, not a question.
// Only "you" asks — "can I add a banana and stay under?" is still a question for the coach.
const LOG_ASK = /^(?:(?:hey|hi|ok|okay|so)[,!.\s]+)?(?:(?:can|could|would|will)\s+(?:you|u)\s+(?:please\s+)?|please\s+)?(?:log|add|track|record|enter|save|note|put\s+(?:in|down))\b[:,]?\s*/i;
export const isLogAsk = (text) => LOG_ASK.test(String(text || "").trim());
// The food alone, for the estimate and the favourite match: "can you log some berries please?" → "some berries".
export const stripLogAsk = (text) => String(text || "").trim().replace(LOG_ASK, "").replace(/[\s,]*(?:for me)?[\s,]*(?:please|pls|thanks|thank you)?[\s.!?]*$/i, "").trim() || String(text || "").trim();
const mealKey = (items) => items.map((i) => i.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()).filter(Boolean).sort().join("|").slice(0, 400);
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");
// The same meal, worded differently ("Orgain Creatine" / "Orgain CREATINE MICRONIZED CREATINE MONOHYDRATE"): as many
// items, each item's words inside one of the other's (either way round), and calories within 20 kcal or 25%.
// Exact keys made a second favourite chip for every rewording; this keeps one.
export function sameMeal(a, b, kcalA, kcalB) {
  if (!a?.length || a.length !== b?.length) return false;
  const ka = Number(kcalA) || 0, kb = Number(kcalB) || 0;
  if (Math.abs(ka - kb) > Math.max(20, 0.25 * Math.max(ka, kb))) return false;
  const left = b.map((i) => new Set(words(i.name)));
  return a.every((i) => {
    const w = new Set(words(i.name)); if (!w.size) return false;
    const j = left.findIndex((o) => o && o.size && ([...w].every((x) => o.has(x)) || [...o].every((x) => w.has(x))));
    if (j < 0) return false; left[j] = null; return true;
  });
}
// Same food, same amount, same numbers: an item that matches an item of a favourite eaten twice or more
// (its words inside the other's, grams within 10%) takes that favourite's numbers, scaled to its grams — so
// the morning shake is 130 kcal every day, not 126 one day and 134 the next. A one-off (possibly wrong)
// read never sets the numbers; only a usual does. Returns { items, used: [favourite labels] }.
export async function steadyItems(env, who, items) {
  const favs = ((await env.DB.prepare(`SELECT name, items_json, times_used FROM track_favourites WHERE user_id = ? AND times_used >= 2 ORDER BY times_used DESC LIMIT 40`).bind(who.id).all()).results || []);
  const known = favs.flatMap((f) => parseItems(f.items_json).map((it) => ({ it, w: new Set(words(it.name)), label: f.name || it.name })));
  const used = new Set();
  const out = (items || []).map((it) => {
    // A label times a weight is exact: a favourite's old numbers must not replace it.
    if (it?.from_label || it?.source === "label" || it?.source === "barcode") return it;
    const g = Number(it?.grams) || 0, w = new Set(words(it?.name)); if (!g || !w.size) return it;
    const hit = known.find((k) => { const kg = Number(k.it.grams) || 0; if (!kg || Math.abs(kg - g) > 0.1 * kg) return false; return [...w].every((x) => k.w.has(x)) || [...k.w].every((x) => w.has(x)); });
    if (!hit) return it;
    const f = g / Number(hit.it.grams); used.add(hit.label);
    return { ...it, kcal: Math.round(hit.it.kcal * f), protein_g: round1(hit.it.protein_g * f), carbs_g: round1(hit.it.carbs_g * f), fat_g: round1(hit.it.fat_g * f) };
  });
  return { items: out, used: [...used] };
}
// A meal logged in the last 30 minutes that is this same meal: the review says so, so a double log is caught.
export async function recentTwin(env, who, meal) {
  const since = new Date(Date.parse(meal.created_at || nowIso()) - 30 * 60 * 1000).toISOString();
  const rows = (await env.DB.prepare(`SELECT id, time, kcal, items_json FROM track_meals WHERE user_id = ? AND date = ? AND id != ? AND created_at >= ? ORDER BY created_at DESC LIMIT 10`).bind(who.id, meal.date, meal.id, since).all()).results || [];
  const twin = rows.find((r) => sameMeal(meal.items || [], parseItems(r.items_json), meal.kcal, r.kcal));
  return twin ? { id: twin.id, time: twin.time || "" } : null;
}
const parseItems = (s) => { try { return JSON.parse(s) || []; } catch { return []; } };
export const localHour = (createdAt, tzOffsetMin) => { const d = new Date(createdAt); return ((d.getUTCHours() * 60 + d.getUTCMinutes() - (Number(tzOffsetMin) || 0)) / 60 + 24) % 24; };
// The words for a time of day (the label on a chip). Night wraps past midnight: 1 a.m. is not "morning".
const bucketOf = (h) => (h < 5 ? "night" : h < 10.5 ? "morning" : h < 15 ? "midday" : h < 21 ? "evening" : "night");
// How far apart two hours of the day are, round the clock (23 and 1 are two hours apart).
const hoursApart = (a, b) => { const d = Math.abs(a - b) % 24; return Math.min(d, 24 - d); };
// "At this time of day" = within two hours either side of now — no bucket edges, so a 17:15 dinner and a
// 17:45 one count as the same habit. A chip SAYS "usually now" only after two uses in that window: once is a
// meal, twice is a habit, and the claim has to be true. A single use still sorts the chip towards its hour.
const NEAR_HOURS = 2, USUAL_MIN_USES = 2;

// ---------------------------------------------------------------- the reaction (code, not the model)
// One line after every meal, from the day's numbers. Never a guess, never a lecture.
// `planned` is the day's planned calories (this meal's own included when it is a plan): they are kept back
// from "left", so a dinner out booked in the morning lowers what breakfast and lunch are told they have.
export function reactionFor(meal, totals, targets, { repeat = false, name = "", planned = 0 } = {}) {
  const t = targets || {};
  const left = t.kcal ? t.kcal - totals.kcal - (planned || 0) : null;
  if (meal.planned) {
    const bits = [`Planned. ${fmt(meal.kcal)} kcal kept back`];
    if (left !== null) bits.push(left >= 0 ? `${fmt(left)} left for the rest of the day` : `${fmt(-left)} over for the day once it happens`);
    return bits.join(" · ") + ".";
  }
  const bits = [`${repeat ? (name ? `${name} again.` : "Logged that again.") : "Logged."} ${fmt(meal.kcal)} kcal`];
  if (left !== null) bits.push(left >= 0 ? `${fmt(left)} left today${planned ? ` after ${fmt(planned)} planned` : ""}` : `${fmt(-left)} over for today${planned ? " counting what's planned" : ""}`);
  if (t.protein_g) bits.push(`protein ${fmt(totals.protein_g)} of ${fmt(t.protein_g)}`);
  return bits.join(" · ") + ".";
}

// ---------------------------------------------------------------- the day's turns
// Meals (from track_meals) and words (track_day_chat), merged by time. The page draws
// a card for a meal and a bubble for words; a reaction row points at its meal.
// At the same moment: the words sent with photos, then the meal they made, then everything else.
const rank = (t) => (t.type === "text" && t.kind === "said" ? 0 : t.type === "meal" ? 1 : 2);
export async function dayChat(env, who, date) {
  await ensureDaySchema(env);
  const meals = ((await env.DB.prepare(`SELECT * FROM track_meals WHERE user_id = ? AND date = ? ORDER BY created_at`).bind(who.id, date).all()).results || []).map(mealRow);
  const rows = (await env.DB.prepare(`SELECT id, role, kind, text, meal_id, created_at FROM track_day_chat WHERE user_id = ? AND date = ? ORDER BY id`).bind(who.id, date).all()).results || [];
  const turns = [
    ...meals.map((m) => ({ type: "meal", at: m.created_at, meal: m })),
    ...rows.map((r) => ({ type: "text", id: r.id, at: r.created_at, role: r.role, kind: r.kind, text: r.text, mealId: r.meal_id || null })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : rank(a) - rank(b)));
  const plannedMeals = meals.filter((m) => m.planned);
  return { date, turns, totals: totalsOf(meals.filter((m) => !m.planned)), planned: { ...totalsOf(plannedMeals), meals: plannedMeals.length }, targets: who.targets };
}
// The day's numbers as the reaction line needs them: what was eaten, and what is planned.
async function dayNumbers(env, who, date) {
  const rows = (await env.DB.prepare(`SELECT kcal, protein_g, carbs_g, fat_g, planned FROM track_meals WHERE user_id = ? AND date = ?`).bind(who.id, date).all()).results || [];
  const plannedRows = rows.filter((r) => r.planned);
  return { totals: totalsOf(rows.filter((r) => !r.planned)), planned: { ...totalsOf(plannedRows), meals: plannedRows.length } };
}
function mealRow(r) { const items = parseItems(r.items_json); return { id: r.id, date: r.date, time: r.time, items, kcal: r.kcal, protein_g: r.protein_g, carbs_g: r.carbs_g, fat_g: r.fat_g, thumb: r.thumb, source: r.source, created_at: r.created_at, zone: r.tz || null, tzOffset: r.tz_offset ?? null, planned: Boolean(r.planned), photos: Number(r.photos) || 0 }; }
export async function addWords(env, who, date, role, kind, text, mealId = null, at = null) {
  await ensureDaySchema(env);
  const now = at || nowIso();
  await env.DB.prepare(`INSERT INTO track_day_chat (user_id, date, role, kind, text, meal_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(who.id, date, role, kind, String(text).slice(0, 2000), mealId, now).run();
  return { type: "text", at: now, role, kind, text: String(text).slice(0, 2000), mealId };
}
// Called by track.js after every meal lands (photo, text, barcode, repeat): the reaction line, and the favourite.
export async function afterMeal(env, who, meal, { repeat = false, favouriteName = "", tzOffsetMin = 0 } = {}) {
  await ensureDaySchema(env);
  const { totals, planned } = await dayNumbers(env, who, meal.date);
  const line = reactionFor(meal, totals, who.targets, { repeat, name: favouriteName, planned: planned.kcal });
  const reaction = await addWords(env, who, meal.date, "assistant", "reaction", line, meal.id, meal.created_at || null);
  // A plan teaches the favourites nothing until it happens (confirmedMeal): the habit model learns what was eaten.
  const fav = meal.planned ? null : await rememberFavourite(env, who, meal, tzOffsetMin);
  return { reaction, totals, planned, favourite: fav };
}
// "Had it": the plan became a meal. The reaction line is rewritten as eaten, and the favourite learns it now.
export async function confirmedMeal(env, who, meal, { tzOffsetMin = 0 } = {}) {
  await ensureDaySchema(env);
  const { totals, planned } = await dayNumbers(env, who, meal.date);
  const line = reactionFor(meal, totals, who.targets, { planned: planned.kcal });
  await env.DB.prepare(`UPDATE track_day_chat SET text = ? WHERE user_id = ? AND meal_id = ? AND kind = 'reaction'`).bind(line, who.id, meal.id).run();
  const fav = await rememberFavourite(env, who, meal, tzOffsetMin);
  return { totals, planned, favourite: fav };
}

// The person fixed the portion (or the foods) in the editor: the reaction line and the favourite follow.
export async function editedMeal(env, who, meal, { tzOffsetMin = 0 } = {}) {
  await ensureDaySchema(env);
  const { totals, planned } = await dayNumbers(env, who, meal.date);
  const line = reactionFor(meal, totals, who.targets, { planned: planned.kcal });
  await env.DB.prepare(`UPDATE track_day_chat SET text = ? WHERE user_id = ? AND meal_id = ? AND kind = 'reaction'`).bind(line, who.id, meal.id).run();
  if (meal.planned) return { totals, planned, favourite: null };
  // A first-time favourite made from the raw estimate is replaced by the corrected one.
  await forgetUnusedFavourite(env, who, meal.id);
  // An edit is the same meal, not another one: a repeat's use count and hour history stay put (bump: false).
  const fav = await rememberFavourite(env, who, meal, tzOffsetMin, { bump: false });
  return { totals, planned, favourite: fav };
}
// The meal moved to another hour (v3.13): swap that one use in the favourite's hour history, so "usually now"
// follows the corrected time. A favourite with one use was just re-made from the moved meal — nothing to swap.
export async function retimeFavourite(env, who, meal, fromHour, toHour) {
  await ensureDaySchema(env);
  if (fromHour === toHour) return;
  const key = mealKey(meal.items || []);
  if (!key) return;
  const have = await env.DB.prepare(`SELECT id, hours, times_used FROM track_favourites WHERE user_id = ? AND key = ?`).bind(who.id, key).first();
  if (!have || Number(have.times_used) <= 1) return;
  const hours = String(have.hours || "").split(",").filter(Boolean);
  const i = hours.indexOf(String(fromHour));
  if (i >= 0) hours.splice(i, 1);
  hours.push(String(toHour));
  await env.DB.prepare(`UPDATE track_favourites SET hours = ? WHERE id = ?`).bind(hours.slice(-20).join(","), have.id).run();
}
// A meal deleted (or a fresh estimate discarded): its words go, and a favourite nobody has reused goes with it.
export async function removedMeal(env, who, mealId) {
  await ensureDaySchema(env);
  await forgetUnusedFavourite(env, who, mealId);
  await env.DB.prepare(`DELETE FROM track_day_chat WHERE user_id = ? AND meal_id = ?`).bind(who.id, mealId).run();
}
// The favourite this meal created (times_used 1, same key) — dropped so a discarded guess isn't a chip forever.
async function forgetUnusedFavourite(env, who, mealId) {
  const m = await env.DB.prepare(`SELECT items_json FROM track_meals WHERE id = ? AND user_id = ?`).bind(mealId, who.id).first();
  const key = m ? mealKey(parseItems(m.items_json)) : "";
  if (key) await env.DB.prepare(`DELETE FROM track_favourites WHERE user_id = ? AND key = ? AND times_used <= 1 AND name IS NULL`).bind(who.id, key).run();
}

// ---------------------------------------------------------------- favourites
async function rememberFavourite(env, who, meal, tzOffsetMin, { bump = true } = {}) {
  const items = meal.items || [];
  if (!items.length) return null;
  const key = mealKey(items);
  if (!key) return null;
  const now = nowIso();
  const hour = Math.round(localHour(meal.created_at || now, tzOffsetMin));
  let have = await env.DB.prepare(`SELECT * FROM track_favourites WHERE user_id = ? AND key = ?`).bind(who.id, key).first();
  if (!have && bump) {
    const all = (await env.DB.prepare(`SELECT * FROM track_favourites WHERE user_id = ? ORDER BY times_used DESC LIMIT 60`).bind(who.id).all()).results || [];
    const twin = all.find((r) => sameMeal(items, parseItems(r.items_json), meal.kcal, r.kcal));
    if (twin) {
      const hours = String(twin.hours || "").split(",").filter(Boolean).slice(-19).concat(String(hour)).join(",");
      await env.DB.prepare(`UPDATE track_favourites SET times_used = times_used + 1, last_used = ?, hours = ?, thumb = COALESCE(thumb, ?) WHERE id = ?`).bind(now, hours, meal.thumb || null, twin.id).run();
      return favOut({ ...twin, times_used: twin.times_used + 1, last_used: now, hours, thumb: twin.thumb || meal.thumb || null });
    }
  }
  if (have && !bump) {
    await env.DB.prepare(`UPDATE track_favourites SET thumb = COALESCE(?, thumb), items_json = ?, kcal = ?, protein_g = ?, carbs_g = ?, fat_g = ? WHERE id = ?`)
      .bind(meal.thumb || null, JSON.stringify(items), meal.kcal, meal.protein_g, meal.carbs_g, meal.fat_g, have.id).run();
    return favOut({ ...have, items_json: JSON.stringify(items), kcal: meal.kcal, protein_g: meal.protein_g, carbs_g: meal.carbs_g, fat_g: meal.fat_g, thumb: meal.thumb || have.thumb });
  }
  if (have) {
    const hours = String(have.hours || "").split(",").filter(Boolean).slice(-19).concat(String(hour)).join(",");
    await env.DB.prepare(`UPDATE track_favourites SET times_used = times_used + 1, last_used = ?, hours = ?, thumb = COALESCE(?, thumb), items_json = ?, kcal = ?, protein_g = ?, carbs_g = ?, fat_g = ? WHERE id = ?`)
      .bind(now, hours, meal.thumb || null, JSON.stringify(items), meal.kcal, meal.protein_g, meal.carbs_g, meal.fat_g, have.id).run();
    return favOut({ ...have, times_used: have.times_used + 1, last_used: now, hours, items_json: JSON.stringify(items), kcal: meal.kcal, protein_g: meal.protein_g, carbs_g: meal.carbs_g, fat_g: meal.fat_g, thumb: meal.thumb || have.thumb });
  }
  const id = randomId(8);
  await env.DB.prepare(`INSERT INTO track_favourites (id, user_id, key, name, items_json, kcal, protein_g, carbs_g, fat_g, thumb, hours, times_used, last_used, name_asked, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?)`)
    .bind(id, who.id, key, JSON.stringify(items), meal.kcal, meal.protein_g, meal.carbs_g, meal.fat_g, meal.thumb || null, String(hour), now, now).run();
  return favOut({ id, user_id: who.id, key, name: null, items_json: JSON.stringify(items), kcal: meal.kcal, protein_g: meal.protein_g, carbs_g: meal.carbs_g, fat_g: meal.fat_g, thumb: meal.thumb || null, hours: String(hour), times_used: 1, last_used: now, name_asked: 0, created_at: now });
}
function favOut(r) {
  const items = parseItems(r.items_json);
  const hours = String(r.hours || "").split(",").filter(Boolean).map(Number);
  const buckets = {}; for (const h of hours) buckets[bucketOf(h)] = (buckets[bucketOf(h)] || 0) + 1;
  return { id: r.id, name: r.name || null, label: r.name || items.map((i) => i.name).join(", ").slice(0, 60), items, kcal: Math.round(r.kcal || 0), protein_g: round1(r.protein_g || 0), carbs_g: round1(r.carbs_g || 0), fat_g: round1(r.fat_g || 0), thumb: r.thumb || null, timesUsed: Number(r.times_used) || 1, lastUsed: r.last_used, buckets, nameAsked: Boolean(r.name_asked) };
}
// The chips: `now` = the ones usually eaten at this hour (twice or more within two hours of it), most-repeated
// first; `rest` = everything else, nearest to this hour first, then by use. Every chip carries `usual` so the
// page can say why it is where it is. `hour` is the PERSON'S local hour (the page sends it); the stored hours are local too.
export async function listFavourites(env, who, { hour = 12, date = todayUtc() } = {}) {
  await ensureDaySchema(env);
  const h = Number(hour), at = Number.isFinite(h) ? ((h % 24) + 24) % 24 : 12;
  const bucket = bucketOf(at);
  const raw = (await env.DB.prepare(`SELECT * FROM track_favourites WHERE user_id = ? ORDER BY times_used DESC, last_used DESC LIMIT 60`).bind(who.id).all()).results || [];
  const kept = [];
  for (const r of raw) {
    const twin = kept.find((k) => sameMeal(parseItems(k.items_json), parseItems(r.items_json), k.kcal, r.kcal));
    if (!twin) { kept.push(r); continue; }
    twin.times_used += r.times_used; twin.name = twin.name || r.name; twin.last_used = [twin.last_used, r.last_used].sort().pop();
    twin.hours = String(twin.hours || "").split(",").concat(String(r.hours || "").split(",")).filter(Boolean).slice(-20).join(",");
    await env.DB.batch([
      env.DB.prepare(`UPDATE track_favourites SET times_used = ?, name = ?, last_used = ?, hours = ? WHERE id = ?`).bind(twin.times_used, twin.name || null, twin.last_used, twin.hours, twin.id),
      env.DB.prepare(`DELETE FROM track_favourites WHERE id = ?`).bind(r.id),
    ]);
  }
  const rows = kept.map((r) => {
    const hours = String(r.hours || "").split(",").filter(Boolean).map(Number);
    const near = hours.filter((x) => hoursApart(x, at) <= NEAR_HOURS).length;
    const nearest = hours.length ? Math.min(...hours.map((x) => hoursApart(x, at))) : 24;
    return { ...favOut(r), usual: near >= USUAL_MIN_USES, near, nearest };
  });
  const tidy = ({ near, nearest, ...f }) => f;
  const now = rows.filter((f) => f.usual).sort((a, b) => b.near - a.near || b.timesUsed - a.timesUsed).map(tidy);
  const rest = rows.filter((f) => !f.usual).sort((a, b) => a.nearest - b.nearest || b.timesUsed - a.timesUsed).map(tidy);
  const yesterday = addDays(date, -1);
  const y = await env.DB.prepare(`SELECT COUNT(*) n, SUM(kcal) kcal FROM track_meals WHERE user_id = ? AND date = ? AND planned = 0`).bind(who.id, yesterday).first();
  const sameDay = await env.DB.prepare(`SELECT COUNT(*) n FROM track_meals WHERE user_id = ? AND date = ? AND planned = 0`).bind(who.id, addDays(date, -7)).first();
  return { bucket, now: now.slice(0, 6), rest: rest.slice(0, 12), yesterday: y?.n ? { date: yesterday, meals: Number(y.n), kcal: Math.round(y.kcal || 0) } : null, lastWeek: sameDay?.n ? { date: addDays(date, -7), meals: Number(sameDay.n) } : null };
}
export async function nameFavourite(env, who, id, name) {
  await ensureDaySchema(env);
  name = String(name || "").trim().slice(0, 40);
  const r = await env.DB.prepare(`UPDATE track_favourites SET name = ?, name_asked = 1 WHERE id = ? AND user_id = ?`).bind(name || null, String(id), who.id).run();
  return Number(r?.meta?.changes || 0) ? { ok: true, id, name } : { ok: false, status: 404, error: "no such favourite" };
}
export async function forgetFavourite(env, who, id) {
  await ensureDaySchema(env);
  await env.DB.prepare(`DELETE FROM track_favourites WHERE id = ? AND user_id = ?`).bind(String(id), who.id).run();
  return { ok: true };
}
// One insertion, deletion or substitution apart? (Only used for words of five letters or more.)
function oneOff(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
// Match typed words against the person's own favourites. Name first, then item overlap.
export async function matchFavourite(env, who, text) {
  await ensureDaySchema(env);
  const w = words(text);
  if (!w.length) return null;
  const rows = ((await env.DB.prepare(`SELECT * FROM track_favourites WHERE user_id = ? ORDER BY times_used DESC LIMIT 200`).bind(who.id).all()).results || []).map(favOut);
  // The same word, a shared 5-letter start, or one letter out (the mic hears "launch" for "lunch").
  const same = (x, y) => x === y || (x.length > 4 && y.length > 4 && (x.startsWith(y.slice(0, 5)) || y.startsWith(x.slice(0, 5)) || oneOff(x, y)));
  let best = null, bestScore = 0;
  for (const f of rows) {
    const nameWords = words(f.name || "");
    if (nameWords.length && nameWords.every((x) => w.some((y) => same(x, y)))) { const sc = 3 + f.timesUsed / 1000; if (sc > bestScore) { best = f; bestScore = sc; } continue; }
    // How many of the favourite's foods did they name, and how many of their words are foods in it?
    const foods = f.items.map((i) => words(i.name)).filter((ws) => ws.length);
    if (!foods.length) continue;
    const hitFoods = foods.filter((ws) => ws.some((x) => w.some((y) => same(x, y)))).length / foods.length;
    const hitWords = w.filter((y) => foods.some((ws) => ws.some((x) => same(x, y)))).length / w.length;
    if (hitFoods >= 0.5 && hitWords >= 0.6) { const sc = hitFoods * hitWords + f.timesUsed / 1000; if (sc > bestScore) { best = f; bestScore = sc; } }
  }
  return best ? { favourite: best, score: round1(bestScore) } : null;
}

// ---------------------------------------------------------------- repeats
// Log a favourite again (scaled by mult), or copy every meal of another day. Returns the new meals.
export async function repeatMeals(env, who, { favouriteId, fromDate, date, mult = 1, insertMeal }) {
  await ensureDaySchema(env);
  mult = Math.min(10, Math.max(0.1, Number(mult) || 1));
  const scale = (items) => sanitiseItems(items.map((i) => ({ ...i, grams: (i.grams || 0) * mult, kcal: (i.kcal || 0) * mult, protein_g: (i.protein_g || 0) * mult, carbs_g: (i.carbs_g || 0) * mult, fat_g: (i.fat_g || 0) * mult, mult: (i.mult || 1) * mult })), { source: "repeat" });
  const out = [];
  if (favouriteId) {
    const f = await env.DB.prepare(`SELECT * FROM track_favourites WHERE id = ? AND user_id = ?`).bind(String(favouriteId), who.id).first();
    if (!f) return { ok: false, status: 404, error: "no such favourite" };
    const fav = favOut(f);
    const meal = await insertMeal({ date, items: scale(fav.items), source: "repeat", thumb: fav.thumb });
    out.push(meal);
    // Every fifth repeat: ask "still about this much?" so a staple never drifts unnoticed. After three: ask for a name, once.
    const uses = fav.timesUsed + 1;
    return { ok: true, meals: out, favourite: fav, checkPortion: uses % 5 === 0, askName: !fav.name && !fav.nameAsked && uses >= 3 };
  }
  if (fromDate) {
    const from = pickDate(fromDate);
    if (from === date) return { ok: false, status: 400, error: "that's the same day" };
    const rows = (await env.DB.prepare(`SELECT * FROM track_meals WHERE user_id = ? AND date = ? AND planned = 0 ORDER BY created_at`).bind(who.id, from).all()).results || [];
    if (!rows.length) return { ok: false, status: 404, error: "nothing logged that day", reason: `Nothing was logged on ${from}.` };
    for (const r of rows) { const m = mealRow(r); out.push(await insertMeal({ date, items: scale(m.items), source: "repeat", thumb: m.thumb })); }
    return { ok: true, meals: out, from };
  }
  return { ok: false, status: 400, error: "favouriteId or fromDate" };
}

// ---------------------------------------------------------------- talking to the day
// The facts block the coach answers from. Numbers come from here, never from the model.
async function factsFor(env, who, date) {
  const chat = await dayChat(env, who, date);
  const y = await env.DB.prepare(`SELECT SUM(kcal) kcal, SUM(protein_g) protein_g, COUNT(*) meals FROM track_meals WHERE user_id = ? AND date = ? AND planned = 0`).bind(who.id, addDays(date, -1)).first();
  const wk = (await env.DB.prepare(`SELECT date, SUM(kcal) kcal, SUM(protein_g) protein_g, COUNT(*) meals FROM track_meals WHERE user_id = ? AND date BETWEEN ? AND ? GROUP BY date ORDER BY date`).bind(who.id, addDays(date, -6), date).all()).results || [];
  const w = (await env.DB.prepare(`SELECT date, kg FROM track_weights WHERE user_id = ? ORDER BY date DESC LIMIT 8`).bind(who.id).all()).results || [];
  const t = who.targets || {};
  return {
    date, name: who.name || null,
    targets: t.kcal ? { kcal: t.kcal, protein_g: t.protein_g, carbs_g: t.carbs_g, fat_g: t.fat_g } : null,
    today: { totals: chat.totals, planned_kcal: chat.planned?.kcal || 0, remaining_kcal: t.kcal ? t.kcal - chat.totals.kcal - (chat.planned?.kcal || 0) : null, meals: chat.turns.filter((x) => x.type === "meal" && !x.meal.planned).map((x) => ({ time: x.meal.time, foods: x.meal.items.map((i) => `${i.name} (${i.portion || Math.round(i.grams || 0) + " g"})`).join(", "), kcal: Math.round(x.meal.kcal), protein_g: Math.round(x.meal.protein_g), carbs_g: Math.round(x.meal.carbs_g), fat_g: Math.round(x.meal.fat_g) })) },
    yesterday: y?.meals ? { kcal: Math.round(y.kcal), protein_g: Math.round(y.protein_g), meals: y.meals } : null,
    last_7_days: wk.map((d) => ({ date: d.date, kcal: Math.round(d.kcal), protein_g: Math.round(d.protein_g), meals: d.meals })),
    weights_kg: w.reverse().map((x) => ({ date: x.date, kg: x.kg })),
  };
}
const COACH_RULES = `You are the between-meals coach inside a food log. Speak plainly and briefly, like a good coach texting: two to four sentences, no bullet lists, no headings, no emoji. Use ONLY the numbers in the facts; never invent a calorie, gram or weight, and never estimate a food yourself (the log does that). You cannot log, add, change or remove food: never say or suggest that anything was logged, added or saved by you. If the person wants to log something, tell them to type just the food and amount (like "1 cup blueberries") and the log will save it. If the person asks what to eat, suggest in terms of what is left today (protein, calories) and their own logged foods where possible. You are not a doctor: no medical advice, no diagnosis, no supplements or drugs; if they mention pain, fainting, an eating disorder, pregnancy or a medical condition, say kindly that this is one for their coach or a clinician and stop. Do not moralise about food. Estimates in the log are roughly ±30%; say "about" rather than exact.`;
export async function askDay(env, who, { date, text, coachName = "" }) {
  const facts = await factsFor(env, who, date);
  const system = `${COACH_RULES}${coachName ? ` The person's human coach is ${coachName}.` : ""}\n\nFACTS (JSON, the only numbers you may use):\n${JSON.stringify(facts)}`;
  const meta = {};
  const reply = String(await complete({ env, config: CONFIG, system, messages: [{ role: "user", content: String(text).slice(0, 600) }], maxTokens: 700, meta }) || "").trim();
  return { reply: reply || "I couldn't put that into words just now. Ask me again in a moment.", meta };
}

// ---------------------------------------------------------------- summaries
// One row per (person, date, kind). Regenerated only when the hash of the food changed.
export async function summaryFor(env, who, { date, kind = "day", coachName = "", force = false }) {
  await ensureDaySchema(env);
  const facts = kind === "week" ? await weekFacts(env, who, date) : await factsFor(env, who, date);
  const empty = kind === "week" ? !facts.days.some((d) => d.meals) : !facts.today.meals.length;
  if (empty) return { kind, date, empty: true, summary: null, note: kind === "week" ? "Nothing logged in these seven days." : "Nothing logged this day." };
  const hash = (await sha256hex(JSON.stringify(kind === "week" ? facts.days : facts.today) + JSON.stringify(facts.targets))).slice(0, 24);
  const have = await env.DB.prepare(`SELECT json, hash, created_at FROM track_summaries WHERE user_id = ? AND date = ? AND kind = ?`).bind(who.id, date, kind).first();
  if (have && have.hash === hash && !force) { let s = null; try { s = JSON.parse(have.json); } catch {} if (s) return { kind, date, empty: false, summary: s, cached: true, at: have.created_at, facts: publicFacts(facts, kind) }; }
  const system = kind === "week" ? WEEK_PROMPT(coachName) : DAY_PROMPT(coachName, date === todayUtc());
  const meta = {};
  let s = null;
  try {
    const raw = String(await complete({ env, config: CONFIG, system, messages: [{ role: "user", content: `FACTS (JSON, the only numbers you may use):\n${JSON.stringify(facts)}` }], maxTokens: 1400, meta }) || "");
    s = parseSummaryJson(raw);
    if (!s) { console.warn("foodlog summary: no JSON in the reply", raw.slice(0, 300)); s = { headline: raw.replace(/<\|[^|]*\|>/g, " ").trim().slice(0, 300) }; }
  } catch (err) {
    console.error("foodlog summary failed", err?.message || err);
    return { kind, date, empty: false, summary: null, error: "The coach couldn't write this just now. The numbers below are still right.", facts: publicFacts(facts, kind) };
  }
  s = cleanSummary(s, kind);
  await env.DB.prepare(`INSERT INTO track_summaries (user_id, date, kind, json, hash, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, date, kind) DO UPDATE SET json = excluded.json, hash = excluded.hash, created_at = excluded.created_at`).bind(who.id, date, kind, JSON.stringify(s), hash, nowIso()).run();
  console.log(JSON.stringify({ event: "foodlog-summary", kind, neurons: meta.usage?.neurons ?? null, gateway: meta.gateway || "" }));
  return { kind, date, empty: false, summary: s, cached: false, at: nowIso(), facts: publicFacts(facts, kind) };
}
// The model's reply → the JSON object in it. gpt-oss sometimes wraps its answer in its own
// channel tokens ("<|start|>assistant<|channel|>final<|message|>{…}") — those are stripped first.
function parseSummaryJson(raw) {
  const text = String(raw || "").replace(/<\|[^|]*\|>/g, "\n");
  const starts = [...text.matchAll(/\{/g)].map((m) => m.index);
  for (const i of starts) {
    for (let j = text.length; j > i; j = text.lastIndexOf("}", j - 1)) {
      if (j < 0) break;
      try { const o = JSON.parse(text.slice(i, j + 1)); if (o && typeof o === "object" && (o.headline !== undefined || o.ate !== undefined || o.averages !== undefined)) return o; } catch {}
      if (j === 0) break;
    }
  }
  return null;
}
const strField = (s, k, max) => String(s?.[k] || "").replace(/\s+/g, " ").trim().slice(0, max);
function cleanSummary(s, kind) {
  return kind === "week"
    ? { headline: strField(s, "headline", 200), averages: strField(s, "averages", 300), pattern: strField(s, "pattern", 300), protein: strField(s, "protein", 200), weight: strField(s, "weight", 200), nudge: strField(s, "nudge", 200) }
    : { headline: strField(s, "headline", 200), ate: strField(s, "ate", 300), landed: strField(s, "landed", 300), well: strField(s, "well", 200), tomorrow: strField(s, "tomorrow", 200) };
}
const DAY_PROMPT = (coach, isToday) => `You write the one-paragraph review of a person's food day inside their food log, in the voice of a calm, plain-spoken coach${coach ? ` (their human coach is ${coach})` : ""}. Answer ONLY with a JSON object, no prose outside it, exactly these keys: {"headline":"","ate":"","landed":"","well":"","tomorrow":""}. headline: one short sentence. ate: what they ate, in order, one or two sentences. landed: where the day landed against the targets, using ONLY the numbers in the facts (calories and protein at least). well: one thing that went well. tomorrow: one specific, small thing to do differently ${isToday ? "for the rest of today" : "tomorrow"}. Never invent numbers. No medical advice. No moralising. Estimates are roughly ±30%, so say "about".${isToday ? " The day is still going: say so." : ""}`;
const WEEK_PROMPT = (coach) => `You write the seven-day look-back for a person's food log, in the voice of a calm, plain-spoken coach${coach ? ` (their human coach is ${coach})` : ""}. Answer ONLY with a JSON object, exactly these keys: {"headline":"","averages":"","pattern":"","protein":"","weight":"","nudge":""}. headline: one sentence on the week. averages: average calories against target across LOGGED days, and how many days were logged, using ONLY the numbers in the facts. pattern: the one pattern worth knowing — which days were off and what they have in common (weekday, time, a repeated food), or that it was steady. protein: how many days hit the protein target. weight: the weight trend from the facts, or "no weigh-ins" if none. nudge: the one change for next week. Never invent numbers. No medical advice. No moralising.`;
async function weekFacts(env, who, end) {
  const start = addDays(end, -6);
  const rows = (await env.DB.prepare(`SELECT date, SUM(kcal) kcal, SUM(protein_g) protein_g, SUM(carbs_g) carbs_g, SUM(fat_g) fat_g, COUNT(*) meals FROM track_meals WHERE user_id = ? AND date BETWEEN ? AND ? AND planned = 0 GROUP BY date`).bind(who.id, start, end).all()).results || [];
  const by = Object.fromEntries(rows.map((r) => [r.date, r]));
  const foods = (await env.DB.prepare(`SELECT date, items_json, kcal FROM track_meals WHERE user_id = ? AND date BETWEEN ? AND ? AND planned = 0 ORDER BY created_at`).bind(who.id, start, end).all()).results || [];
  const byFood = {};
  for (const f of foods) for (const i of parseItems(f.items_json)) { const k = i.name.toLowerCase(); byFood[k] = (byFood[k] || 0) + 1; }
  const repeated = Object.entries(byFood).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, n]) => ({ food: name, times: n }));
  const t = who.targets || {};
  const days = [];
  for (let i = 0; i < 7; i++) { const d = addDays(start, i); const r = by[d]; days.push({ date: d, weekday: new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }), kcal: Math.round(r?.kcal || 0), protein_g: Math.round(r?.protein_g || 0), meals: r?.meals || 0 }); }
  const w = (await env.DB.prepare(`SELECT date, kg FROM track_weights WHERE user_id = ? AND date <= ? ORDER BY date DESC LIMIT 10`).bind(who.id, end).all()).results || [];
  const logged = days.filter((d) => d.meals);
  return {
    start, end, name: who.name || null,
    targets: t.kcal ? { kcal: t.kcal, protein_g: t.protein_g, carbs_g: t.carbs_g, fat_g: t.fat_g } : null,
    days,
    logged_days: logged.length,
    avg_kcal_logged_days: logged.length ? Math.round(logged.reduce((a, d) => a + d.kcal, 0) / logged.length) : null,
    days_hit_protein: t.protein_g ? logged.filter((d) => d.protein_g >= t.protein_g).length : null,
    days_within_15pct_kcal: t.kcal ? logged.filter((d) => Math.abs(d.kcal - t.kcal) / t.kcal <= 0.15).length : null,
    repeated_foods: repeated,
    weights_kg: w.reverse().map((x) => ({ date: x.date, kg: x.kg })),
  };
}
// What the page shows under the words: the same numbers, so the reader can check the coach.
function publicFacts(f, kind) {
  return kind === "week"
    ? { days: f.days, targets: f.targets, avg: f.avg_kcal_logged_days, logged: f.logged_days, proteinDays: f.days_hit_protein, kcalDays: f.days_within_15pct_kcal, repeated: f.repeated_foods, weights: f.weights_kg }
    : { totals: f.today.totals, targets: f.targets, meals: f.today.meals.length, remaining: f.today.remaining_kcal };
}

// ---------------------------------------------------------------- "say": one box for everything
// Decide what the words are: a question for the coach, a repeat of something known, or a new meal to estimate.
export function classifySay(text) {
  const t = String(text || "").trim();
  if (!t) return "empty";
  if (isLogAsk(t)) return "log";
  if (QUESTION_HINT.test(t) && !/\b(again|same as|usual)\b/i.test(t)) return "question";
  return "log";
}
export const looksLikeFood = (text) => FOOD_HINT.test(text) || words(text).length <= 8;
