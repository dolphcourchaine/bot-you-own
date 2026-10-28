// ============================================================================
//  LABEL × WEIGHT — the arithmetic the model is not trusted with.
//
//  The model copies what it sees: the scale's display and unit ("8 1/8 oz"), the
//  label's serving size and per-serving numbers, whether the package is raw meat,
//  and whether what was weighed is cooked. This file turns that into numbers.
//
//  The case that made it: raw ground turkey (label: 4 oz / 112 g = 160 kcal) weighed
//  COOKED at 8⅛ oz. Cooking drives water off, so 230 g cooked was ~311 g raw — 2.78
//  label servings, 444 kcal — where "one serving" (the old answer) was 162.
// ============================================================================

// Cooked grams ÷ raw grams (dry → cooked for grains, so above 1). Matched on the item name.
export const YIELDS = [
  [/ground (turkey|chicken)|turkey mince|chicken mince/i, 0.74],
  [/ground beef|beef mince|hamburger|burger patt/i, 0.72],
  [/ground pork|sausage/i, 0.72],
  [/chicken (breast|tender)/i, 0.72], [/chicken thigh|drumstick|wing/i, 0.68], [/turkey breast/i, 0.72],
  [/pork (chop|loin|tenderloin)/i, 0.73], [/steak|beef|sirloin|ribeye|filet|tenderloin/i, 0.72],
  [/salmon|cod|tilapia|halibut|tuna steak|fish|shrimp|prawn/i, 0.78],
  [/\b(turkey|chicken|beef|pork|lamb|bison|veal|venison)\b/i, 0.74],             // any other meat, packaged raw
  [/\brice\b/i, 3.0], [/pasta|spaghetti|penne|macaroni|noodle/i, 2.4], [/oats|oatmeal|quinoa|lentil/i, 2.5],
];
export const yieldFor = (name) => (YIELDS.find(([re]) => re.test(String(name || ""))) || [null, 0.75])[1];

const FRACTIONS = { "1/8": "⅛", "1/4": "¼", "3/8": "⅜", "1/2": "½", "5/8": "⅝", "3/4": "¾", "7/8": "⅞" };
export const pretty = (s) => String(s || "").replace(/(\d)\s+(\d\/\d)/g, (m, a, f) => a + (FRACTIONS[f] || " " + f));
const r1 = (n) => Math.round(n * 10) / 10;

// A scale display in grams, done here rather than trusted to the model: "8 1/8 oz" → 230.4, "1 lb 2.5 oz" → 524.4,
// "0.52 kg" → 520, "96" or "96 g" → 96. null when it isn't a reading.
export function scaleGrams(text) {
  const t = String(text || "").toLowerCase().replace(/⅛/g, " 1/8").replace(/¼/g, " 1/4").replace(/⅜/g, " 3/8").replace(/½/g, " 1/2").replace(/⅝/g, " 5/8").replace(/¾/g, " 3/4").replace(/⅞/g, " 7/8").replace(",", ".").trim();
  const num = (s) => { const m = String(s).trim().match(/^(\d+(?:\.\d+)?)?(?:\s*(\d+)\s*\/\s*(\d+))?$/); if (!m || (!m[1] && !m[2])) return null; return (Number(m[1]) || 0) + (m[2] ? Number(m[2]) / Number(m[3]) : 0); };
  let m = t.match(/^([\d.]+)\s*lbs?\s*([\d.\s/]*)\s*(oz)?$/); if (m) { const oz = num(m[2] || "0") || 0; return Number(m[1]) * 453.592 + oz * 28.3495; }
  m = t.match(/^([\d.\s/]+)\s*oz$/); if (m) { const v = num(m[1]); return v == null ? null : v * 28.3495; }
  m = t.match(/^([\d.]+)\s*kg$/); if (m) return Number(m[1]) * 1000;
  m = t.match(/^([\d.]+)\s*(g|ml)?$/); if (m) return Number(m[1]);
  return null;
}

// An item with a readable label (label_serving_g + label_per_serving) and a weight (weighed_g) or a count
// the person said (servings): its numbers become label × (grams on the label's basis ÷ serving grams).
// Raw-meat label, food weighed cooked: the cooked weight is turned back into raw first (YIELDS). Sets per100
// on the WEIGHED basis, so typing a new weight on the page recomputes exactly. No label → unchanged.
export function applyLabelMath(it) {
  const sg = Number(it?.label_serving_g) || 0, ps = it?.label_per_serving;
  // The weight: from the display text when it parses (with its unit), else the model's grams.
  const fromText = scaleGrams(it?.scale_text), w = fromText && Math.abs(fromText - (Number(it?.weighed_g) || 0)) > 0.5 && /[a-z]/i.test(String(it?.scale_text)) ? fromText : Number(it?.weighed_g) || fromText || 0;
  if (!sg || !ps || typeof ps !== "object" || !(Number(ps.kcal) || Number(ps.protein_g))) return it;
  const said = Number(it.servings) > 0 ? Number(it.servings) : 0;
  let basis = w, factor = 1;
  if (!w && said) basis = sg * said;                                  // "2 scoops": label × servings, as before
  if (!basis) return it;
  // Raw-meat label: the model's flag, or — as a backstop, because the model doesn't always notice — a labelled
  // meat/fish/grain that isn't sold ready to eat (deli, smoked, roasted, canned, jerky…).
  const readyToEat = /deli|sliced|smoked|roast(ed)?|rotisserie|cured|jerky|canned|in water|in oil|precooked|pre-cooked|cooked|bacon bits|ham\b/i.test(it.name);
  const rawLabel = Boolean(it.label_is_raw) || (!readyToEat && YIELDS.some(([re]) => re.test(String(it.name || ""))));
  // Raw-meat label and a weighed portion: cooked, unless it was weighed raw. People weigh what they're about to eat;
  // the model's "as-sold" for a bowl of browned turkey was the one thing between 332 and 444 kcal.
  const cookedRaw = Boolean(w && rawLabel && it.weighed_state !== "raw");
  if (cookedRaw) { factor = 1 / yieldFor(it.name); basis = w * factor; }
  const servings = basis / sg;
  const n = (k) => Number(ps[k]) || 0;
  const out = {
    ...it, grams: w || basis, servings: Math.round(servings * 100) / 100, from_label: true, source: "label",
    kcal: Math.round(n("kcal") * servings), protein_g: r1(n("protein_g") * servings), carbs_g: r1(n("carbs_g") * servings), fat_g: r1(n("fat_g") * servings),
    per100: { kcal: Math.round(n("kcal") / sg * 100 * factor), protein_g: r1(n("protein_g") / sg * 100 * factor), carbs_g: r1(n("carbs_g") / sg * 100 * factor), fat_g: r1(n("fat_g") / sg * 100 * factor) },
    confidence: Math.max(Number(it.confidence) || 0, 0.9),
  };
  if (w) {
    // The display without its unit ("8 1/8"): which unit makes the number match the grams?
    let st = String(it.scale_text || "").trim();
    const m = st.match(/^(\d+(?:\.\d+)?)(?:\s+(\d+)\/(\d+))?$/);
    if (m) { const v = Number(m[1]) + (m[2] ? Number(m[2]) / Number(m[3]) : 0); st += Math.abs(v * 28.35 - w) < 4 ? " oz" : Math.abs(v - w) < 2 ? " g" : ""; }
    const shown = pretty(st) || Math.round(w) + " g";
    out.portion = /oz|lb/i.test(shown) ? shown : Math.round(w) + " g";
    out.label_note = `${it.name}: scale ${shown}${cookedRaw ? " cooked" : ""}${/\bg\b|^\d+$/.test(shown) ? "" : ` (${Math.round(w)} g)`}`
      + (cookedRaw ? ` → about ${Math.round(basis)} g raw on the label` : "") + ` = ${out.servings} servings.`;
  }
  return out;
}
