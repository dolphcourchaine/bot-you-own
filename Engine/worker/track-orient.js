// ============================================================================
//  WHICH WAY IS UP — a second opinion from a decision model (Clef), in SHADOW.
//
//  Plate already straightens two kinds of photo with landmark rules (track-vision.js:
//  a scale's display at the bottom, a Nutrition Facts heading at the top of its panel),
//  which were never wrong on the owner's photos but have no say on anything else.
//  Clef (@cf/cloudflare/clef, Workers AI) is a decision model: one photo and a typed
//  question in, a PROBABILITY for every option out. Chat vision models asked "how many
//  degrees?" were close to guessing (best 14 of 28), so this asks only the questions
//  such models get right, and acts only when the answer is near-certain:
//
//  - The options name where the TOP of the thing points (the lid of a can, a label's
//    heading), never which way the text runs: some packages print words sideways.
//  - Portrait or square photo: turn it 180° only if P(upside down) ≥ 0.8. Turned left
//    or right is not acted on: models mix the two up about as often as a coin flip.
//  - Landscape photo: the page also sends a copy turned 90° clockwise, and Clef is asked
//    about THAT. Upright → the photo needed 90°; upside down → it needed 270°; still
//    sideways → it is landscape content, so the photo itself is asked about 180°.
//  - "No clear top" (a plate seen straight from above) is always an answer, and anything
//    under 0.8 is "unsure": leave the photo alone. A wrong turn is worse than none.
//
//  ORIENT_CLEF (env var): "off" (the default, so a fresh install pays for nothing) | "shadow"
//  (asked and logged, never acted on — what `npm run deploy:photos` sets on the live site) |
//  "live" (acted on when the landmark rules have no say). ORIENT_CLEF_SAMPLE: 0–1, the share
//  of photos asked in shadow (default 1). Each look is one row in track_orient_log;
//  Engine/tests/orient-report.mjs reads them. A photo the person turned by hand is never
//  turned again: their choice wins (the page sends `hand`; stored photos carry `rotated`).
// ============================================================================

import { toBase64 } from "./track-common.js";
import { priceOf } from "./usage.js";

export const CLEF_MODEL = "@cf/cloudflare/clef";
export const ACT_AT = 0.8;
const OPTIONS = ["upright", "upside_down", "turned_left", "turned_right", "no_top"];

// The one question. "The top" is defined by the thing photographed, for every kind of photo Plate gets.
export const ORIENT_QUESTION = {
  type: "choice",
  instructions:
    "Where is the TOP of the main thing in this photo pointing? The main thing is what the photo was taken of: a food package, can, bottle, jar, tub, " +
    "nutrition label, kitchen scale, receipt, or a plate or bowl of food. Its TOP is: for a package, can, bottle, jar or tub, the lid, cap or opening " +
    "end, where the brand name sits above the rest of the printing; for a nutrition label, the 'Nutrition Facts' or 'Supplement Facts' heading; for " +
    "a kitchen scale, the far edge, with its display at the near edge and its digits upright; for a receipt, the store name; for food on a table " +
    "photographed at an angle, the far side of the table. Some packages print a word or logo sideways on purpose: judge by the main block of " +
    "printing and the shape of the thing, never by one sideways word. Food seen straight from above has no top.",
  criteria: {
    upright: "The top is at the top of the photo: it is the right way up.",
    upside_down: "The top is at the bottom of the photo: it needs a 180 degree turn.",
    turned_left: "The top points to the LEFT edge of the photo.",
    turned_right: "The top points to the RIGHT edge of the photo.",
    no_top: "There is no clear top: food seen straight from above, or nothing in the photo has a top.",
  },
};

// The mode, from the environment. Unknown values are "off".
export function orientMode(env) {
  const m = String(env?.ORIENT_CLEF ?? "off").trim().toLowerCase();
  const s = Number(env?.ORIENT_CLEF_SAMPLE ?? 1);
  return { mode: ["off", "shadow", "live"].includes(m) ? m : "off", sample: Number.isFinite(s) ? Math.min(1, Math.max(0, s)) : 1 };
}

// One look: one photo, the question, the probabilities. Throws on a model error.
export async function clefLook(env, bytes, mime = "image/jpeg", model = "clef") {
  const t0 = Date.now();
  const r = await env.AI.run(model === "clef-flash" ? "@cf/cloudflare/clef-flash" : CLEF_MODEL, {
    model,
    state: "Photo attached.",
    images: [`data:${mime};base64,${toBase64(bytes)}`],
    questions: { orient: ORIENT_QUESTION },
  });
  const a = r?.answers?.orient;
  if (!a || !a.probabilities) throw new Error("clef: no answer");
  const p = Object.fromEntries(OPTIONS.map((k) => [k, Number(a.probabilities[k]) || 0]));
  return { p, ms: Date.now() - t0, tokens: Number(r?.usage?.input_tokens) || 0 };
}

// What one look says on its own: the option that clears ACT_AT, or "unsure". Left and right count as one.
export function readLook(p) {
  if (!p) return "unsure";
  if (p.upright >= ACT_AT) return "upright";
  if (p.upside_down >= ACT_AT) return "upside_down";
  if (p.turned_left + p.turned_right >= ACT_AT) return "sideways";
  if (p.no_top >= ACT_AT) return "no_top";
  return "unsure";
}

// The decision, from the looks already taken. `first` is the look at the photo as it is (portrait or square)
// or at the copy turned 90° clockwise (landscape); `second` is the landscape photo as it is, asked only when
// the turned copy was sideways. Returns { turn: 0|90|180|270 clockwise, verdict }.
export function decide(shape, first, second = null) {
  const a = readLook(first?.p);
  if (shape !== "landscape") return a === "upside_down" ? { turn: 180, verdict: "upside_down" } : { turn: 0, verdict: a };
  if (a === "upright") return { turn: 90, verdict: "top_left" };          // the turned copy is upright: the photo needed 90°
  if (a === "upside_down") return { turn: 270, verdict: "top_right" };    // the turned copy is upside down: it needed 270°
  if (a !== "sideways") return { turn: 0, verdict: a };                   // no top, or unsure: leave it
  const b = readLook(second?.p);                                          // landscape content: is it upside down?
  return b === "upside_down" ? { turn: 180, verdict: "upside_down" } : { turn: 0, verdict: b === "upright" ? "upright" : "landscape_" + b };
}

export const shapeOf = (w, h) => (w > h * 1.02 ? "landscape" : "portrait");   // square counts as portrait: no quarter-turn question

// The whole step for one photo. `bytes` is the small copy (≤512 px) the page sent; `cw` that copy turned 90°
// clockwise (the page sends it for landscape photos). Never throws: an error is verdict "error", turn 0.
export async function clefTurn(env, { bytes, cw = null, w, h, mime = "image/jpeg", model = "clef" }) {
  const shape = shapeOf(w, h), looks = [];
  try {
    const first = await clefLook(env, shape === "landscape" && cw ? cw : bytes, mime, model);
    looks.push({ asked: shape === "landscape" && cw ? "cw" : "as_is", ...first });
    let second = null;
    if (shape === "landscape" && !cw) {                                   // no turned copy: only the 180° question can be answered
      const a = readLook(first.p);
      return { shape, looks, ...(a === "upside_down" ? { turn: 180, verdict: "upside_down" } : { turn: 0, verdict: "landscape_" + a }) };
    }
    if (shape === "landscape" && readLook(first.p) === "sideways") { second = await clefLook(env, bytes, mime, model); looks.push({ asked: "as_is", ...second }); }
    return { shape, looks, ...decide(shape, first, second) };
  } catch (err) {
    return { shape, looks, turn: 0, verdict: "error", error: String(err?.message || err).slice(0, 200) };
  }
}

// --- The log: one row per photo looked at, and one per photo a person turned by hand. ----------------------
export const ORIENT_LOG_SQL = `CREATE TABLE IF NOT EXISTS track_orient_log (id TEXT PRIMARY KEY, at TEXT NOT NULL, user_id TEXT, source TEXT NOT NULL, mode TEXT, shape TEXT, w INTEGER, h INTEGER, hand INTEGER, cur_turn INTEGER, cur_by TEXT, clef_turn INTEGER, clef_verdict TEXT, probs_json TEXT, ms INTEGER, tokens INTEGER, cost_usd REAL, agree INTEGER, image_key TEXT)`;

export const costOf = (tokens, model = CLEF_MODEL) => Math.round((tokens || 0) * ((priceOf(model)?.in || 0) / 1e6) * 1e8) / 1e8;

export async function logOrient(env, row) {
  if (!env.DB) return;
  try {
    await env.DB.prepare(`INSERT INTO track_orient_log (id, at, user_id, source, mode, shape, w, h, hand, cur_turn, cur_by, clef_turn, clef_verdict, probs_json, ms, tokens, cost_usd, agree, image_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(row.id, row.at, row.user_id ?? null, row.source, row.mode ?? null, row.shape ?? null, row.w ?? null, row.h ?? null, row.hand ?? null, row.cur_turn ?? null, row.cur_by ?? null, row.clef_turn ?? null, row.clef_verdict ?? null, row.probs_json ?? null, row.ms ?? null, row.tokens ?? null, row.cost_usd ?? null, row.agree ?? null, row.image_key ?? null).run();
  } catch (err) { console.warn("orient log not written", err?.message || err); }
}
