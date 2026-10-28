// ============================================================================
//  FOOD LOG — the extras: barcodes, labels, receipts, body weight, households.
//  Every function here takes an already-identified user (track.js checked the
//  device key). Nothing here sends email or keeps a photo.
// ============================================================================

import { nowIso, randomCode, randomId, clamp, round1, pickDate, addDays, todayUtc } from "./track-common.js";
import { validBarcode } from "./track-vision.js";

// Open Food Facts asks for a descriptive User-Agent (their terms). Free, no key.
const OFF_UA = "bot-you-own-food-log/1.0 (https://github.com/JimTyrrell/bot-you-own; food log for a coach's clients)";
const OFF_URL = (code) => `https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,brands,serving_size,serving_quantity,nutriments,quantity`;
const PRODUCT_TTL_DAYS = 90;

// --- BARCODES ------------------------------------------------------------------
// Check digit in code first (the model or the camera may misread one digit),
// then the cache, then Open Food Facts. A product looks like:
//   { code, name, brand, serving_g, per100: {kcal, protein_g, carbs_g, fat_g}, pack_g, source: "barcode" }
export async function lookupBarcode(env, rawCode) {
  const code = validBarcode(rawCode);
  if (!code) return { ok: false, reason: "That doesn't look like a valid barcode (check digit failed). Try again, or read the label instead." };
  const cached = await env.DB.prepare(`SELECT json, fetched_at FROM track_products WHERE code = ?`).bind(code).first();
  if (cached && Date.now() - Date.parse(cached.fetched_at) < PRODUCT_TTL_DAYS * 864e5) {
    try { const p = JSON.parse(cached.json); if (p.notFound) return (await ownProduct(env, code)) || { ok: false, reason: "That barcode isn't in Open Food Facts. Snap the nutrition label instead.", code }; return { ok: true, product: p, cached: true }; } catch {}
  }
  let product = null;
  try {
    const r = await fetch(OFF_URL(code), { headers: { "user-agent": OFF_UA, accept: "application/json" }, signal: AbortSignal.timeout(6000) });
    const data = r.ok ? await r.json() : null;
    if (data?.status === 1 && data.product) product = fromOpenFoodFacts(code, data.product);
  } catch (err) { console.error("open food facts lookup failed", err?.message || err); return (await ownProduct(env, code)) || { ok: false, reason: "Couldn't reach the barcode database just now. Snap the label instead, or try again.", code }; }
  await env.DB.prepare(`INSERT INTO track_products (code, json, fetched_at) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at`)
    .bind(code, JSON.stringify(product || { notFound: true }), nowIso()).run();
  if (!product) return (await ownProduct(env, code)) || { ok: false, reason: "That barcode isn't in Open Food Facts. Snap the nutrition label instead.", code };
  return { ok: true, product, cached: false };
}
// ---- Barcodes we've read ourselves ----------------------------------------------------------
// Open Food Facts doesn't know every product (of the owner's three, only the Celsius). When a photo shows a
// barcode AND a readable facts panel, the pairing is kept here under "upc:<code>" — never mixed with the
// Open Food Facts cache — so next time the barcode alone is enough. Looked up only after Open Food Facts
// misses. Nothing is sent to Open Food Facts (their data is public; contributing would be an opt-in).
async function ownProduct(env, code) {
  const row = await env.DB.prepare(`SELECT json FROM track_products WHERE code = ?`).bind("upc:" + code).first();
  if (!row) return null;
  try { return { ok: true, product: JSON.parse(row.json), own: true }; } catch { return null; }
}
export async function rememberBarcode(env, { code, name, serving_g, per_serving, raw = false }) {
  code = validBarcode(code);
  if (!code || !per_serving) return null;
  const product = { code, name: String(name || "").slice(0, 80) || `Product ${code}`, brand: "", raw: Boolean(raw), serving_g: serving_g || null, serving_label: "1 serving", pack_g: null,
    per_serving, per100: serving_g ? { kcal: Math.round(per_serving.kcal * 100 / serving_g), protein_g: round1(per_serving.protein_g * 100 / serving_g), carbs_g: round1(per_serving.carbs_g * 100 / serving_g), fat_g: round1(per_serving.fat_g * 100 / serving_g) } : null, source: "label" };
  await env.DB.prepare(`INSERT INTO track_products (code, json, fetched_at) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at`)
    .bind("upc:" + code, JSON.stringify(product), nowIso()).run();
  return product;
}
// A meal's items with barcodes: a label read teaches the barcode; a barcode without a label is looked up
// (Open Food Facts, then ours) and its per-serving numbers used for the servings the person said.
// A barcode read off a photo often loses the small digit printed apart at the left ("8 10167 39200 5" came back
// as "10167392005"). The check digit fixes exactly one missing leading digit, so try each and keep the one that checks.
export function repairBarcode(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (validBarcode(d)) return validBarcode(d);
  if (d.length === 7 || d.length === 11 || d.length === 12) for (let k = 0; k <= 9; k++) { const c = validBarcode(k + d); if (c) return c; }
  // Other numbers run in ("Item# 1927215" + the barcode came back as one string): the valid code inside, last one first.
  if (d.length > 13) for (const n of [13, 12]) for (let i = d.length - n; i >= 0; i--) { const c = validBarcode(d.slice(i, i + n)); if (c) return c; }
  return null;
}
export async function useBarcodes(env, items) {
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    const code = repairBarcode(it?.barcode);
    const servings = Number(it?.servings) > 0 ? Number(it.servings) : 0;
    if (!code) { out.push(it); continue; }
    try {
      // Weighed, and the barcode is already known (Open Food Facts, or a label read before): its numbers are the
      // label. A label read off a turned or glary photo is the weaker source — the barcode wins.
      if (Number(it.weighed_g) > 0) {
        const known = await lookupBarcode(env, code);
        const kp = known.ok ? known.product : null;
        const kps = kp?.per_serving || (kp?.per100 && kp?.serving_g ? { kcal: kp.per100.kcal * kp.serving_g / 100, protein_g: kp.per100.protein_g * kp.serving_g / 100, carbs_g: kp.per100.carbs_g * kp.serving_g / 100, fat_g: kp.per100.fat_g * kp.serving_g / 100 } : null);
        if (kps && kp.serving_g) { out.push({ ...it, label_serving_g: kp.serving_g, label_per_serving: kps, label_is_raw: it.label_is_raw ?? Boolean(kp.raw), source: "barcode" }); continue; }
      }
      // A label read on the photos: teach the barcode its exact per-serving numbers (and whether it's raw meat).
      if (it.label_per_serving && Number(it.label_serving_g) > 0) {
        const ps = it.label_per_serving;
        await rememberBarcode(env, { code, name: it.name, serving_g: round1(Number(it.label_serving_g)), raw: Boolean(it.label_is_raw), per_serving: { kcal: Math.round(Number(ps.kcal) || 0), protein_g: round1(Number(ps.protein_g) || 0), carbs_g: round1(Number(ps.carbs_g) || 0), fat_g: round1(Number(ps.fat_g) || 0) } });
        out.push(it); continue;
      }
      if (it.from_label && servings) {
        const per = (k) => round1((Number(it[k]) || 0) / servings);
        await rememberBarcode(env, { code, name: it.name, serving_g: Number(it.grams) > 0 ? round1(it.grams / servings) : null, per_serving: { kcal: Math.round((Number(it.kcal) || 0) / servings), protein_g: per("protein_g"), carbs_g: per("carbs_g"), fat_g: per("fat_g") } });
        out.push(it); continue;
      }
      const found = await lookupBarcode(env, code);
      const p = found.ok ? found.product : null;
      const ps = p?.per_serving || (p?.per100 && p?.serving_g ? { kcal: p.per100.kcal * p.serving_g / 100, protein_g: p.per100.protein_g * p.serving_g / 100, carbs_g: p.per100.carbs_g * p.serving_g / 100, fat_g: p.per100.fat_g * p.serving_g / 100 } : null);
      if (!ps) { out.push(it); continue; }
      // Weighed on a scale: the label goes with the item and applyLabelMath (track-yield.js) does the sums.
      if (Number(it.weighed_g) > 0 && p.serving_g) { out.push({ ...it, label_serving_g: p.serving_g, label_per_serving: ps, label_is_raw: it.label_is_raw ?? Boolean(p.raw), source: "barcode" }); continue; }
      const n = servings || 1;
      out.push({ ...it, kcal: Math.round(ps.kcal * n), protein_g: round1(ps.protein_g * n), carbs_g: round1(ps.carbs_g * n), fat_g: round1(ps.fat_g * n), grams: p.serving_g ? round1(p.serving_g * n) : it.grams, confidence: 0.9, source: "barcode" });
    } catch (err) { console.warn("barcode step skipped", err?.message || err); out.push(it); }
  }
  return out;
}

function fromOpenFoodFacts(code, p) {
  const n = p.nutriments || {};
  const kcal100 = Number(n["energy-kcal_100g"]) || (Number(n["energy_100g"]) ? Number(n["energy_100g"]) / 4.184 : 0);
  const per100 = { kcal: Math.round(clamp(kcal100, 0, 900, 0)), protein_g: round1(clamp(n.proteins_100g, 0, 100, 0)), carbs_g: round1(clamp(n.carbohydrates_100g, 0, 100, 0)), fat_g: round1(clamp(n.fat_100g, 0, 100, 0)) };
  if (!per100.kcal && !per100.protein_g && !per100.carbs_g && !per100.fat_g) return null;   // in the database but no nutrition = useless to us
  const packM = String(p.quantity || "").match(/(\d+(?:[.,]\d+)?)\s*(g|ml|cl|l|kg)\b/i);
  let pack_g = null;
  if (packM) { const v = Number(packM[1].replace(",", ".")); pack_g = { g: v, ml: v, cl: v * 10, l: v * 1000, kg: v * 1000 }[packM[2].toLowerCase()] || null; }
  return {
    code, name: String(p.product_name || "").trim().slice(0, 80) || `Product ${code}`, brand: String(p.brands || "").split(",")[0].trim().slice(0, 40),
    serving_g: Number(p.serving_quantity) || null, serving_label: String(p.serving_size || "").slice(0, 40), pack_g, per100, source: "barcode",
  };
}

// --- LABELS ----------------------------------------------------------------------
// A read label is stored under a generated key so the second time the same product
// is photographed we can offer "use last time's". Key = "label:" + a slug of the name.
export async function rememberLabel(env, label) {
  const slug = String(label.product || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  const ps = label.per_serving;
  // No product name on the label? Fingerprint the numbers instead — the same label reads the same twice.
  const fingerprint = [label.serving_size, ps.kcal, ps.protein_g, ps.carbs_g, ps.fat_g, ps.fibre_g, ps.sugar_g, ps.sodium_mg].join("|").replace(/[^a-z0-9|.]/gi, "").slice(0, 60);
  const key = slug ? `label:${slug}` : `label:${fingerprint}`;
  const serving_g = label.serving_g || null;
  const product = {
    code: key, name: label.product || "Labelled product", brand: "", serving_g, serving_label: label.serving_size || "1 serving", pack_g: serving_g && label.servings_per_container ? round1(serving_g * label.servings_per_container) : null,
    per_serving: { kcal: Math.round(ps.kcal), protein_g: round1(ps.protein_g), carbs_g: round1(ps.carbs_g), fat_g: round1(ps.fat_g), fibre_g: round1(ps.fibre_g), sugar_g: round1(ps.sugar_g), sodium_mg: Math.round(ps.sodium_mg) },
    per100: serving_g ? { kcal: Math.round(ps.kcal * 100 / serving_g), protein_g: round1(ps.protein_g * 100 / serving_g), carbs_g: round1(ps.carbs_g * 100 / serving_g), fat_g: round1(ps.fat_g * 100 / serving_g) } : null,
    servings_per_container: label.servings_per_container || null, source: "label",
  };
  let previous = null;
  {
    const row = await env.DB.prepare(`SELECT json, fetched_at FROM track_products WHERE code = ?`).bind(key).first();
    if (row) { try { previous = { ...JSON.parse(row.json), fetched_at: row.fetched_at }; } catch {} }
  }
  await env.DB.prepare(`INSERT INTO track_products (code, json, fetched_at) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at`)
    .bind(key, JSON.stringify(product), nowIso()).run();
  return { key, product, previous };
}

// --- RECEIPTS ---------------------------------------------------------------------
// A receipt belongs to the household when the person is in one, else to them.
export async function saveReceipt(env, { user, householdId, receipt, thumb }) {
  const id = randomId(12);
  await env.DB.prepare(`INSERT INTO track_receipts (id, household_id, user_id, store, date, total, currency, items_json, thumb, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, householdId || null, user.id, receipt.store, receipt.date || todayUtc(), receipt.total, receipt.currency, JSON.stringify(receipt.items), thumb || null, nowIso()).run();
  return { id, ...receipt, thumb: thumb || null, by: user.id };
}

export async function listReceipts(env, { user, householdId, limit = 60 }) {
  const rows = householdId
    ? (await env.DB.prepare(`SELECT r.*, m.name by_name FROM track_receipts r LEFT JOIN track_members m ON m.user_id = r.user_id WHERE r.household_id = ? OR r.user_id = ? ORDER BY r.date DESC, r.created_at DESC LIMIT ?`).bind(householdId, user.id, limit).all()).results
    : (await env.DB.prepare(`SELECT r.*, NULL by_name FROM track_receipts r WHERE r.user_id = ? AND r.household_id IS NULL ORDER BY r.date DESC, r.created_at DESC LIMIT ?`).bind(user.id, limit).all()).results;
  const receipts = (rows || []).map((r) => ({ id: r.id, store: r.store, date: r.date, total: r.total, currency: r.currency, items: safeJson(r.items_json, []), thumb: r.thumb, by: r.user_id, byName: r.by_name || (r.user_id === user.id ? "you" : ""), mine: r.user_id === user.id, shared: Boolean(r.household_id) }));
  // Totals: this week (last 7 days) and this month (calendar), whatever currency they mostly use.
  const today = todayUtc(), weekStart = addDays(today, -6), month = today.slice(0, 7);
  const sum = (f) => Math.round(receipts.filter(f).reduce((a, r) => a + (r.total || 0), 0) * 100) / 100;
  return { receipts, totals: { week: sum((r) => r.date >= weekStart), month: sum((r) => (r.date || "").startsWith(month)), all: sum(() => true) }, currency: receipts.find((r) => r.currency)?.currency || "" };
}

export async function deleteReceipt(env, { user, householdId, id }) {
  // Anyone in the household can delete a shared receipt; a private one only its owner.
  const r = await env.DB.prepare(`SELECT id, user_id, household_id FROM track_receipts WHERE id = ?`).bind(id).first();
  if (!r) return { ok: false, status: 404 };
  const allowed = r.user_id === user.id || (r.household_id && r.household_id === householdId);
  if (!allowed) return { ok: false, status: 403 };
  await env.DB.prepare(`DELETE FROM track_receipts WHERE id = ?`).bind(id).run();
  return { ok: true };
}

// --- BODY WEIGHT ----------------------------------------------------------------------
// Stored in kg; the person's unit (kg | lb) is remembered in their targets.
export async function setWeight(env, user, { date, value, unit }) {
  const u = unit === "lb" ? "lb" : "kg";
  const v = Number(value);
  const [lo, hi] = u === "lb" ? [44, 880] : [20, 400];
  if (!Number.isFinite(v) || v < lo || v > hi) return { ok: false, reason: "Enter a weight between 20 and 400 kg (44–880 lb)." };
  const kg = round1(u === "lb" ? v / 2.20462 : v);
  await env.DB.prepare(`INSERT INTO track_weights (user_id, date, kg) VALUES (?, ?, ?) ON CONFLICT(user_id, date) DO UPDATE SET kg = excluded.kg`).bind(user.id, pickDate(date), kg).run();
  return { ok: true, kg, unit: u };
}

// days: how far back. 0 (or anything not a positive number) means everything ever logged.
export async function listWeights(env, userId, days = 30) {
  const n = Number(days);
  const from = n > 0 ? addDays(todayUtc(), -(Math.min(n, 3660) - 1)) : "0000-00-00";
  const rows = (await env.DB.prepare(`SELECT date, kg FROM track_weights WHERE user_id = ? AND date >= ? ORDER BY date`).bind(userId, from).all()).results || [];
  const last7 = rows.filter((r) => r.date >= addDays(todayUtc(), -6));
  const avg7 = last7.length ? round1(last7.reduce((a, r) => a + r.kg, 0) / last7.length) : null;
  const first = rows[0]?.kg ?? null, last = rows.at(-1)?.kg ?? null;
  return { points: rows, avg7, latest: last, change: first != null && last != null ? round1(last - first) : null };
}

// --- HOUSEHOLDS ------------------------------------------------------------------------
// One household per person. Members see each other's days (read-only), the shared
// receipts, and each other's weight trend. Targets and meals stay each person's own.
export async function householdOf(env, userId) {
  const m = await env.DB.prepare(`SELECT h.id, h.name, h.code, h.created_at FROM track_members m JOIN track_households h ON h.id = m.household_id WHERE m.user_id = ?`).bind(userId).first();
  if (!m) return null;
  const members = (await env.DB.prepare(`SELECT m.user_id, m.name, m.joined_at FROM track_members m WHERE m.household_id = ? ORDER BY m.joined_at`).bind(m.id).all()).results || [];
  return { id: m.id, name: m.name, code: m.code, created_at: m.created_at, members: members.map((x) => ({ id: x.user_id, name: x.name, me: x.user_id === userId })) };
}

export async function createHousehold(env, user, { name, memberName }) {
  if (await householdOf(env, user.id)) return { ok: false, reason: "You're already in a household. Leave it first." };
  const id = randomId(8), code = randomCode(6), now = nowIso();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO track_households (id, name, code, created_at) VALUES (?, ?, ?, ?)`).bind(id, cleanName(name) || "Our household", code, now),
    env.DB.prepare(`INSERT INTO track_members (household_id, user_id, name, joined_at) VALUES (?, ?, ?, ?)`).bind(id, user.id, cleanName(memberName) || firstNameOf(user.email), now),
  ]);
  return { ok: true, household: await householdOf(env, user.id) };
}

export async function joinHousehold(env, user, { code, memberName }) {
  if (await householdOf(env, user.id)) return { ok: false, reason: "You're already in a household. Leave it first." };
  const h = await env.DB.prepare(`SELECT id FROM track_households WHERE code = ?`).bind(String(code || "").trim().toUpperCase()).first();
  if (!h) return { ok: false, reason: "No household has that code. Check it with the person who made it." };
  const n = (await env.DB.prepare(`SELECT COUNT(*) n FROM track_members WHERE household_id = ?`).bind(h.id).first())?.n || 0;
  if (n >= 8) return { ok: false, reason: "That household is full (8 people)." };
  await env.DB.prepare(`INSERT INTO track_members (household_id, user_id, name, joined_at) VALUES (?, ?, ?, ?)`).bind(h.id, user.id, cleanName(memberName) || firstNameOf(user.email), nowIso()).run();
  return { ok: true, household: await householdOf(env, user.id) };
}

export async function leaveHousehold(env, user) {
  const h = await householdOf(env, user.id);
  if (!h) return { ok: true };
  await env.DB.prepare(`DELETE FROM track_members WHERE user_id = ?`).bind(user.id).run();
  // Last one out: the household and its receipts go too (nobody could see them).
  if (h.members.length <= 1) await env.DB.batch([
    env.DB.prepare(`DELETE FROM track_receipts WHERE household_id = ?`).bind(h.id),
    env.DB.prepare(`DELETE FROM track_households WHERE id = ?`).bind(h.id),
  ]);
  return { ok: true };
}

// Can `viewer` read `targetId`'s day? Only themselves, or a member of the same household.
export async function canView(env, viewerId, targetId) {
  if (viewerId === targetId) return true;
  const a = await env.DB.prepare(`SELECT household_id FROM track_members WHERE user_id = ?`).bind(viewerId).first();
  if (!a) return false;
  const b = await env.DB.prepare(`SELECT household_id FROM track_members WHERE user_id = ?`).bind(targetId).first();
  return Boolean(b && a.household_id === b.household_id);
}

function cleanName(s) { return String(s || "").trim().replace(/\s+/g, " ").slice(0, 40); }
function firstNameOf(email) { const s = String(email || "").split("@")[0].split(/[._-]/)[0]; return s ? s[0].toUpperCase() + s.slice(1, 20) : "Me"; }
function safeJson(s, dflt) { try { return JSON.parse(s); } catch { return dflt; } }

// Import a batch of weigh-ins — a scale app's CSV (Renpho, Withings…) or an Apple
// Health export, parsed in the browser into {date, kg} rows. One row per day: the
// page has already picked the day's reading. An existing weigh-in on the same day
// is replaced (same rule as a second manual weigh-in). Returns what happened.
export async function importWeights(env, user, rows) {
  const clean = new Map();
  for (const r of Array.isArray(rows) ? rows.slice(0, 20000) : []) {
    const date = String(r?.date || "").slice(0, 10);
    const kg = Number(r?.kg);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(kg) || kg < 20 || kg > 400) continue;
    if (date > todayUtc()) continue;
    clean.set(date, round1(kg));
  }
  if (!clean.size) return { ok: false, reason: "No usable rows: each needs a date and a weight between 20 and 400 kg." };
  const dates = [...clean.keys()].sort();
  const existing = (await env.DB.prepare(`SELECT date FROM track_weights WHERE user_id = ? AND date >= ? AND date <= ?`).bind(user.id, dates[0], dates.at(-1)).all()).results || [];
  const had = new Set(existing.map((x) => x.date));
  const stmt = env.DB.prepare(`INSERT INTO track_weights (user_id, date, kg) VALUES (?, ?, ?) ON CONFLICT(user_id, date) DO UPDATE SET kg = excluded.kg`);
  for (let i = 0; i < dates.length; i += 100) await env.DB.batch(dates.slice(i, i + 100).map((d) => stmt.bind(user.id, d, clean.get(d))));
  const replaced = dates.filter((d) => had.has(d)).length;
  return { ok: true, imported: dates.length - replaced, replaced, from: dates[0], to: dates.at(-1) };
}
