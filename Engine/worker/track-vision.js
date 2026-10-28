// ============================================================================
//  FOOD LOG — the model. One vision model on Workers AI reads a photo of a
//  plate, a nutrition label, a receipt, or a barcode, and answers with JSON
//  that the code then checks. Everything the model says is treated as a
//  guess: numbers are clamped, calories are re-derived from the macros when
//  they don't add up, and the person fixes the portion with a tap.
//
//  Why Gemma 4 (docs/FOOD-LOG.md has the full comparison): it was the only
//  candidate that named every food in five test photos, returned valid JSON
//  five times out of five, and did it in 2-5 seconds with thinking switched
//  off. The model id lives in YourBots/config.js → foodLog.model.
//
//  Input shape: OpenAI-style messages with an image_url data URI (base64).
//  That's the shape Gemma 4 and the newer catalogue models take; Llama 3.2
//  Vision takes it too. The old byte-array shape (llava) is not used.
// ============================================================================

import { toBase64, round1, clamp } from "./track-common.js";

const NO_THINK = { chat_template_kwargs: { enable_thinking: false } };

// --- The prompts. Each one asks for JSON and nothing else. --------------------
const MEAL_SHAPE = `{"photo_text":[{"photo":1,"text":""}],"items":[{"photos":[1],"brand":"","name":"","barcode":"","from_label":false,"servings":0,"portion":"","grams":0,"kcal":0,"protein_g":0,"carbs_g":0,"fat_g":0,"confidence":0.0,"scale_text":"","weighed_g":0,"weighed_state":"","label_serving_g":0,"label_per_serving":{"kcal":0,"protein_g":0,"carbs_g":0,"fat_g":0},"label_is_raw":false}],"notes":"","name":"","scale_read":false,"scale_unreadable":false,"question":{"text":"","options":[]}}`;
// Brand and product arrive apart, and the model copies the biggest words on each photo (photo_text): an item
// keeps its brand only if that brand is in the words of one of ITS OWN photos. Asking for each photo's brand
// wasn't enough — with creatine + protein photos together it said the protein photos read "Orgain" (they don't);
// copying the words is grounded where naming a brand isn't. Then brand and name go back together.
export function withBrands(list, photoText = null, said = "") {
  const seen = Array.isArray(photoText) ? new Map(photoText.map((b) => [Number(b?.photo), String(b?.text ?? b?.brand ?? "").trim().toLowerCase()])) : null;
  return (Array.isArray(list) ? list : []).map((it) => {
    let brand = String(it?.brand || "").trim(); const name = String(it?.name || "").trim();
    const own = Array.isArray(it?.photos) ? it.photos.map(Number) : [];
    if (brand && seen && !own.length && !String(said).toLowerCase().includes(brand.toLowerCase())) brand = "";   // only in the words: only a brand they said
    if (brand && seen && own.length && !own.some((n) => (seen.get(n) || "").includes(brand.toLowerCase()))) brand = "";   // not in its own photos' words
    return brand && name && !name.toLowerCase().includes(brand.toLowerCase()) ? { ...it, name: brand + " " + name } : it;
  });
}
const FOOD_SHAPE = `{"items":[{"name":"","portion":"","grams":0,"kcal":0,"protein_g":0,"carbs_g":0,"fat_g":0,"confidence":0.0}],"notes":""}`;
export const PROMPTS = {
  // Where a kitchen scale's display is in one photo. Finding a thing is what these models do well (16/16 on the
  // turkey and berry photos, turned every way); judging which way a photo is turned, they can't (8/15 at best).
  // The page turns the photo so the display is at the bottom — how a scale is seen from the counter.
  // Just the display, one photo, nothing else to do — the full meal read skipped it in some runs.
  scaleRead: () => `This photo shows a kitchen scale. Read its digital display exactly: the number and the unit printed next to it (g, oz, lb, kg, ml). Ounce displays show whole ounces then a SMALL stacked fraction in eighths — a big 8 with a small 1 over 8 is "8 1/8 oz", never 8.8. A decimal point only appears on gram or kilogram displays. Answer ONLY with JSON: {"display":"8 1/8 oz"} — or {"display":""} if you cannot read it.`,
  // One photo on its own, asked little, so it comes back in 2–3 s while the full read of all the photos together is
  // still running: the page shows it at once and builds the meal up as each photo lands (Engine/worker/track.js →
  // peek). Provisional only — the full read is the one that is saved.
  peek: () => `You are looking at ONE photo from a meal someone is logging. It may be food, a package, a nutrition label, a kitchen scale, a barcode or a receipt. Answer ONLY with JSON, no prose: {"shows":"","kind":"food","items":[["name","brand",0,0,0,0,0]],"label":{"serving":"","kcal":0,"protein_g":0,"carbs_g":0,"fat_g":0},"scale":""}
- "shows": what this photo shows, 2 to 5 plain words ("strawberries on a scale", "Nutrition Facts panel", "front of a can").
- "kind": one of food, label, scale, package, barcode, receipt, other.
- "items": each food or drink you can see, ONCE, as a short list: [name, brand, grams, kcal, protein g, carbs g, fat g] — e.g. ["Fried eggs","",100,140,12,1,10]. Name: 1–3 everyday words, normal capitals, no brand in it. Brand only if it is printed on THIS photo, else "". Numbers: a rough estimate for the amount shown. A nutrition label or barcode with no product name printed on it: []. A receipt: [].
- "label": only if a nutrition facts panel is readable: the serving size as printed and the per-serving numbers exactly; else all 0 and "".
- "scale": the digital display of a kitchen scale exactly as shown, with its unit ("96 g", "8 1/8 oz"); else "".`,
  scaleEdge: () => `Look at this photo. Is there a kitchen scale with a digital display (the screen with the numbers)? If so, which edge of the photo is the display closest to? Answer with exactly one word: top, bottom, left, right — or none if there is no scale display.`,
  // Photos + the person's words, sent together: ONE eating occasion. The words are the instructions
  // (amounts, extra foods not pictured, a name to save it under); the photos are the evidence.
  meal: (said, n) => `You are a careful nutrition estimator. You are given ${n === 1 ? "a photo" : n + " photos"}${said ? " and the person's own words" : ""} about ONE meal or drink they are having now. (If it is a single photo of a shop receipt or till slip, not food, return an empty items list and notes "receipt".) Answer ONLY with a JSON object, no prose, no code fence, exactly this shape:\n${MEAL_SHAPE}\nRules:\n- ${n > 1 ? "The photos together are ONE meal. They may show different parts of it (the chicken, the rice, the salad) or the same thing more than once (a tub's front and its nutrition label, a plate from two angles). List every distinct food or drink ONCE, never once per photo.\n- " : ""}A kitchen scale in a photo: find its display whichever way the photo is turned (rotate it in your head) and read the NUMBER and the UNIT printed beside it (g, oz, lb, kg, ml). Copy the display exactly into the item's \"scale_text\" (\"96\", \"8 1/8 oz\", \"1 lb 2.4 oz\", \"0.52 kg\"). Ounce scales (OXO and most kitchen scales) show whole ounces then a SMALL stacked fraction in eighths — 1/8, 1/4, 3/8, 1/2, 5/8, 3/4, 7/8 — never tenths: a big 8 followed by a small 1 over 8 is \"8 1/8 oz\" (8.125 oz, 230 g), NOT 8.8. A decimal point only appears on gram or kilogram displays. Put the weight in grams in \"weighed_g\": oz × 28.35; lb × 453.6 plus oz × 28.35; kg × 1000. If a scale display is there but you cannot read it, \"weighed_g\": 0 and \"scale_unreadable\": true. \"weighed_state\": what was on the scale — \"cooked\" (ready to eat: browned ground meat, grilled chicken, cooked rice), \"raw\" (uncooked, or the person says raw or dry) or \"as-sold\" (a packaged product, a drink). Several photos of one bowl with a scale: if the number goes DOWN while more food is in the bowl (or the person says they zeroed it), the scale was zeroed each time, so each reading is the weight of what was added in that photo; otherwise the last reading is the total. Keep every different food its own item (strawberries, raspberries, blueberries, blackberries — never one \"mixed berries\" item) with the weight that belongs to it.\n- Oil or butter you can see on or under a food is part of that food's numbers: roasted or sautéed vegetables that look oily get 1 teaspoon of oil (5 g, 40 kcal, 4.5 g fat) per 100 g on top of the vegetable itself; a visible pool or pat of butter, more.\n- Protein and fat must fit the food, from standard cooked-food data: lean cuts (beef filet/tenderloin, sirloin, chicken breast, turkey breast, white fish, shrimp) are about 26–31 g protein and under 10 g fat per 100 g cooked; fatty cuts (ribeye, short rib, pork belly, chicken thigh with skin, salmon) carry their real fat. kcal = 4 × protein + 4 × carbs + 9 × fat.\n- A weight the person gives for meat, fish, rice, grains or pasta is the cooked weight on the plate unless they say raw or dry (180 g cooked rice is ~230 kcal; 180 g dry is ~650).\n- Hidden calories count: sauce, dressing, gravy, butter, cheese or a drink you can see is its own item with its own amount.\n- If the person says a scale reading includes the bowl or plate, subtract it (their bowl weight if they give one, else your estimate of the empty bowl, said in notes). If a reading is far more than the food shown could weigh, the bowl is probably on the scale: ask about it (below) — but keep the reading as the food's weight meanwhile. Never lower a food to 0 g, or take a guessed bowl weight off a reading, unless the person said the bowl was on the scale.\n- \"question\": when ONE thing you can't tell from the photos or words would change the numbers a lot (rice or cauliflower rice; cooked in oil or not; whether a heavy reading includes the bowl), ask it: a short question and 2–3 short answers, e.g. {\"text\":\"Does 480 g include the bowl?\",\"options\":[\"Yes — take the bowl off\",\"No, that's the food\"]}. Your items use your best guess meanwhile. Otherwise {\"text\":\"\",\"options\":[]}.\n- A number read off a scale is copied exactly — never rounded (96 stays 96). \"scale_read\": true if any weight came from reading a scale in the photos (not from the person's words).\n- If the person gives a weight or amount for a food (\"rice 180 g\", \"150g chicken\", \"half the salad\"), use it exactly: a weight goes in \"grams\" and the numbers are for that weight.\n- If a nutrition facts panel is readable, copy it into that item: \"label_serving_g\" (the grams given with the serving size — \"4 oz (112g)\" → 112; for a drink, its ml), \"label_per_serving\" (the printed per-serving calories, protein, carbohydrate and fat, exactly) and \"label_is_raw\": true if the package is raw meat, poultry or fish (safe-handling instructions, \"cook thoroughly\", \"% lean\"). \"servings\": only the number of servings the person SAYS (\"2 scoops\" = 2); if the food was weighed, 0 — the weight decides, never one serving by default. Fill grams, kcal and macros with your best estimate too; the app recomputes them from the label and the weight. Put the amount in "portion" in everyday lower-case words (\"1 can\", \"2 scoops\", \"1 rounded scoop\"); a drink's grams are its volume in ml (a 12 fl oz can is 355).\n- The person's words win about WHAT and HOW MUCH. If they mention something not in any photo (\"plus my protein shake\"), add it as its own item with your best estimate.\n- \"photo_text\": for EVERY photo, copy the biggest printed words on that photo exactly as printed (up to 12 words; \"\" if none). Copy only what is on that photo.\n- For each item: \"photos\" = the numbers of the photos that show it (empty if it is only in the person's words); \"brand\" = the maker's name, only if it is printed on one of THOSE photos, else \"\" — never a brand from a photo of a different product; \"name\" = a short everyday name, 1–3 words in normal capitals, without the brand: the product line if one is printed (\"Precision Protein\"), else what it is (\"Creatine\", \"Sparkling Orange\", \"grilled chicken\") — never the whole printed title (not \"CREATINE MICRONIZED CREATINE MONOHYDRATE\").\n- \"barcode\": ALL the digits printed with a barcode in THIS item's photos, including the small single digits at the left and right ends (UPC codes have 12, EAN 13) — only the barcode's own digits, not an item or lot number — else \"\". \"from_label\": true only if its numbers come from a nutrition or supplement facts panel you can read. \"servings\": how many of the label's servings this item is (2 scoops of a 1-scoop serving = 2), else 0.\n- Supplements with no calories (creatine, electrolytes) are still items, with 0 kcal. Plain water or ice (what a powder is mixed into) is not an item — leave it out. A branded drink is an item.\n- "name": only if they ask to save or name this (\"call it my morning stack\", \"make it a named meal: snack\"), the short name they gave; otherwise "".\n- If there is no food or drink at all, return an empty items list and say why in notes.${said ? `\nThe person says: "${said.replace(/"/g, "'")}"` : ""}`,
  // The Fix line: a correction to an estimate the person has ALREADY checked. They may
  // have fixed other items before — an earlier correction, the portion buttons, typed
  // grams — so the model sees the whole current list and is told to change only what
  // this sentence is about. mergeCorrection() below enforces that in code as well.
  revise: (current, correction, withPhoto) => `You are a careful nutrition estimator correcting an estimate the person has already checked. The current estimate, as JSON: ${JSON.stringify({ items: current })}\nThe person says: "${correction}".\nApply ONLY that correction. Every item the correction does not mention must come back exactly as given: same name, portion, grams and numbers. Change, add or remove only the items it is about, and estimate their numbers${withPhoto ? " (the photo is attached)" : ""}. Keep the person's own amount and unit exactly: "11 chips" means eleven individual chips and the portion is "11 chips", not 11 servings. If they correct a food's name or brand, correct that same item instead of adding a second one. "portion" is a plain-English size; kcal, protein_g, carbs_g and fat_g are for that portion. Answer ONLY with a JSON object, no prose, no code fence, exactly this shape:\n${FOOD_SHAPE}`,
  food: (correction) => `You are a careful nutrition estimator. Look at the meal and answer ONLY with a JSON object, no prose, no code fence, exactly this shape:\n${FOOD_SHAPE}\nOne item per distinct food on the plate. "portion" is a plain-English size ("1 slice", "large bowl"). "grams" is your best guess of the weight of that portion as served. kcal, protein_g, carbs_g and fat_g are for that portion, not per 100 g. confidence is 0-1. If you can't see food, return an empty items list and say why in notes. If the photo is a shop receipt or till slip, return an empty items list and notes "receipt".${correction ? `\nThe person says the estimate needs a correction: "${correction}". Trust them about WHAT the food is; you estimate the numbers.` : ""}`,
  text: (text, correction) => `You are a careful nutrition estimator. The person typed what they ate: "${text}". Answer ONLY with a JSON object, no prose, no code fence, exactly this shape:\n${FOOD_SHAPE}\nOne item per food they named. Use typical serving sizes when they don't give one. kcal, protein_g, carbs_g and fat_g are for that portion. confidence is 0-1.${correction ? `\nCorrection from the person: "${correction}".` : ""}`,
  label: `Read the nutrition facts label in the photo. Answer ONLY with JSON, no prose, no code fence: {"product":"","serving_size":"","servings_per_container":0,"per_serving":{"kcal":0,"protein_g":0,"carbs_g":0,"fat_g":0,"fibre_g":0,"sugar_g":0,"sodium_mg":0}}. Copy the numbers printed on the label for ONE serving. If the label is per 100 g, treat 100 g as the serving. Use null for anything not printed. "product" is the product name if it is visible on the packaging, else null.`,
  receipt: `This is a photo of a shop receipt. Answer ONLY with JSON, no prose, no code fence: {"store":"","date":"YYYY-MM-DD","currency":"","total":0,"items":[{"name":"","qty":1,"price":0}]}. Copy item names as printed (expand obvious abbreviations only if certain). Skip lines that are not products (subtotals, tax, card details). Use null for a missing date.`,
  barcode: `There is a product barcode in this photo. Read the digits printed under the bars. Answer ONLY with JSON, no prose: {"digits":"","kind":"EAN-13|UPC-A|EAN-8|unknown"}. digits must contain only the numbers you can actually read, in order, no spaces. If you can't read a barcode, use an empty string.`,
};

// --- One call. `image` is raw bytes (ArrayBuffer/Uint8Array) or null for text-only.
// images: [{ bytes, mime }] — several photos of one eating occasion go to the model in ONE call, so the
// front of a tub and its nutrition label are seen together (and counted once). `image` is the single-photo form.
export async function runVision(env, cfg, { image = null, mime = "image/jpeg", images = null, prompt, maxTokens = 900, system = "", temperature = null }) {
  if (!env.AI) throw new Error("No Workers AI binding (wrangler.jsonc → ai).");
  const content = [{ type: "text", text: prompt }];
  const all = images && images.length ? images : image ? [{ bytes: image, mime }] : [];
  all.forEach((im, i) => {
    if (all.length > 1) content.push({ type: "text", text: `Photo ${i + 1}:` });
    content.push({ type: "image_url", image_url: { url: `data:${im.mime || "image/jpeg"};base64,${toBase64(im.bytes)}` } });
  });
  const t0 = Date.now();
  const r = await env.AI.run(cfg.model, {
    messages: [
      { role: "system", content: system || "Answer with the JSON object only. Never think out loud. Never add commentary before or after the JSON." },
      { role: "user", content },
    ],
    max_tokens: maxTokens,
    ...(temperature === null ? {} : { temperature }),   // the orientation questions are asked at 0: the same photo must get the same answer
    ...NO_THINK,
  });
  const text = String(r?.choices?.[0]?.message?.content ?? r?.response ?? r?.description ?? "");
  const usage = r?.usage || null;
  console.log(JSON.stringify({ event: "foodlog-vision", model: cfg.model, ms: Date.now() - t0, images: all.length, neurons: usage?.neurons ?? null, tokens: usage?.total_tokens ?? null }));
  return { text, usage };
}

// The same call, streamed: onText gets each piece of the answer as the model writes it (the peek uses it to send each
// food the moment it is written out). Returns the whole text. Workers AI streams server-sent events: "data: {…}" lines
// carrying either `response` or an OpenAI-style `choices[0].delta.content`, ending with "data: [DONE]".
export async function streamVision(env, cfg, { images, prompt, maxTokens = 900, system = "", temperature = null }, onText) {
  if (!env.AI) throw new Error("No Workers AI binding (wrangler.jsonc → ai).");
  const content = [{ type: "text", text: prompt }];
  images.forEach((im) => content.push({ type: "image_url", image_url: { url: `data:${im.mime || "image/jpeg"};base64,${toBase64(im.bytes)}` } }));
  const t0 = Date.now();
  const stream = await env.AI.run(cfg.model, {
    messages: [
      { role: "system", content: system || "Answer with the JSON object only. Never think out loud. Never add commentary before or after the JSON." },
      { role: "user", content },
    ],
    max_tokens: maxTokens, stream: true,
    ...(temperature === null ? {} : { temperature }),
    ...NO_THINK,
  });
  const rd = stream.getReader(), dec = new TextDecoder();
  let buf = "", text = "", first = 0;
  for (;;) {
    const { value, done } = await rd.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    for (let k; (k = buf.indexOf("\n")) >= 0;) {
      const ln = buf.slice(0, k).trim(); buf = buf.slice(k + 1);
      if (!ln.startsWith("data:")) continue;
      const data = ln.slice(5).trim(); if (!data || data === "[DONE]") continue;
      let piece = ""; try { const j = JSON.parse(data); piece = j?.choices?.[0]?.delta?.content ?? j?.response ?? ""; } catch {}
      if (piece) { if (!first) first = Date.now() - t0; text += piece; onText(text); }
    }
  }
  console.log(JSON.stringify({ event: "foodlog-vision-stream", model: cfg.model, ms: Date.now() - t0, firstMs: first, images: images.length, chars: text.length }));
  return text;
}

// --- WHICH WAY IS UP, from landmarks whose place on the page is known. ---------------------------------------
// Asked outright which way a photo is turned, every vision model on Workers AI is close to guessing
// (measured 2026-09-29 on 28 turned photos: the best got 14, chance is 7), and reading the print all four
// ways doesn't separate them either — they read sideways print nearly as well as upright. What they CAN do is
// find things. A kitchen scale's display sits at the bottom (PROMPTS.scaleEdge, Gemma, 28/28). On a Nutrition
// Facts label the word "Calories" sits just BELOW the heading, and the heading's box says which way the words
// run — Moondream's `point` and `detect` (8/8 on the label photos, never wrong on the other 20). Gemma decides
// first whether a heading is there at all (28/28); Moondream's own yes/no said yes to a label's torn-off bottom.
// Returns how far CLOCKWISE to turn the photo so the label reads upright: 0, 90, 180, 270 — or null (no say).
export const ORIENT_MODEL = "@cf/moondream/moondream3.1-9B-A2B";
export async function labelTurn(env, cfg, bytes) {
  if (!env.AI) return null;
  const size = imageSize(bytes); if (!size || !size.w || !size.h) return null;
  const image = `data:image/${size.type === "png" ? "png" : "jpeg"};base64,${toBase64(bytes)}`;
  const md = (input) => env.AI.run(ORIENT_MODEL, { image, stream: false, temperature: 0, ...input }).then((r) => r?.result || r || {}).catch(() => ({}));
  const [gate, head, cal, box] = await Promise.all([
    runVision(env, cfg, { image: bytes, prompt: "Is the heading 'Nutrition Facts' printed and visible in this photo? Answer yes or no.", maxTokens: 5, system: "Answer with one word.", temperature: 0 }).catch(() => ({ text: "" })),
    md({ task: "point", target: "the heading Nutrition Facts" }),
    md({ task: "point", target: "the word Calories" }),
    md({ task: "detect", target: "the words Nutrition Facts", max_objects: 5 }),
  ]);
  const hp = Array.isArray(head.points) && head.points.length === 1 ? head.points[0] : null;
  const cp = Array.isArray(cal.points) && cal.points.length ? cal.points[0] : null;
  const boxes = Array.isArray(box.objects) ? box.objects : [];
  console.log(JSON.stringify({ event: "foodlog-orient-label", gate: String(gate.text || "").slice(0, 20), headingPoints: (head.points || []).length, caloriesPoints: (cal.points || []).length, boxes: boxes.length, w: size.w, h: size.h }));
  if (!/^\s*y/i.test(String(gate.text || ""))) return null;
  if (!hp || !cp || !boxes.length) return null;
  // The box that holds the heading point: `detect` also returns the other lines of the panel, and now and then the panel itself.
  const dist = (x) => Math.hypot(Math.max(x.x_min - hp.x, 0, hp.x - x.x_max) * size.w, Math.max(x.y_min - hp.y, 0, hp.y - x.y_max) * size.h);
  const b = boxes.reduce((a, x) => (dist(x) < dist(a) ? x : a));
  if (dist(b) > 0.03 * Math.max(size.w, size.h)) return null;                        // no box where the heading is: no say
  const bw = (b.x_max - b.x_min) * size.w, bh = (b.y_max - b.y_min) * size.h;
  if (Math.max(bw, bh) < 1.4 * Math.min(bw, bh)) return null;                       // a square box is not a line of words
  const dx = (cp.x - hp.x) * size.w, dy = (cp.y - hp.y) * size.h;                    // from the heading to "Calories": the label's "down"
  if (Math.abs(bw > bh ? dy : dx) < 0.015 * Math.max(size.w, size.h)) return null;   // "Calories" on top of the heading: nothing to read
  if (bw > bh) return dy > 0 ? 0 : 180;                                             // words run left–right: upright, or upside down
  return dx < 0 ? 270 : 90;                                                         // words run up–down: "down" at the left = turned 90° clockwise, so turn 270° more
}

// The first {...} in the reply, code fences and all stripped. null if none.
export function extractJson(raw) {
  const m = String(raw || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch {}
  try { return JSON.parse(m[0].replace(/\\_/g, "_").replace(/,\s*([}\]])/g, "$1")); } catch { return null; }
}

// --- Sanity: every item gets clean numbers. Calories that disagree with the
//     macros by more than 25% are recomputed from the macros (4/4/9).
// --- THE FIX LINE: change what the person asked about, keep everything else. -----------
// "30 blueberries" is about the blueberries. The model is told so (PROMPTS.revise), but a
// model can drift, so the rule is enforced here: an item whose name the sentence does not
// mention comes back EXACTLY as the person left it — earlier corrections, portion buttons
// and typed grams included. Only the items it names are replaced or added, and one is
// removed only when the sentence says so ("that's chicken, not pork", "no rice"). Names match loosely —
// plurals, "sliced", units and numbers are ignored — because the model rarely repeats a
// name word for word. When unsure it keeps what the person had: a missed correction costs
// a retry; a lost one costs their earlier work.
const MATCH_STOP = new Set(["the", "and", "not", "with", "that", "this", "its", "are", "was", "has", "have", "for", "but", "more", "less", "some", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "half", "quarter", "cup", "slice", "piece", "bowl", "plate", "small", "large", "medium", "big", "gram", "ounce", "tablespoon", "teaspoon", "tbsp", "tsp", "handful", "serving", "portion", "about", "only", "just", "actually", "really", "also", "there", "were", "fresh", "sliced", "chopped", "raw", "cooked", "extra", "whole", "add", "added", "brand", "them", "they", "those", "these", "their"]);
function stemFood(w) {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && w.endsWith("oes")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}
export function foodWords(s) {
  return new Set(String(s || "").toLowerCase().split(/[^a-z]+/).map(stemFood).filter((w) => w.length > 2 && !MATCH_STOP.has(w)));
}
// A food the person just named in a correction isn't a guess any more: they've told us
// what it is and how much. Whatever confidence the model attached — with the photo it
// can still score a "¼ cup" it can't see at 0.4, or leave it out (sanitiseItems then
// fills in 0.5) — it must not come back flagged "not sure"; the page shows that below
// 0.6. Foods the model guessed on its own keep their score, doubt and all.
const STATED = 0.9;
const stated = (f) => ({ ...f, confidence: Math.max(Number(f.confidence) || 0, STATED) });
const REMOVING = /\b(no|not|remove|removed|without|delete|drop|none|skip|instead|didn'?t|wasn'?t|isn'?t|aren'?t)\b/i;
export function mergeCorrection(current, fresh, correction) {
  if (!fresh.length) return current;                                   // the model gave nothing usable: change nothing
  const said = foodWords(correction);
  const removing = REMOVING.test(String(correction || ""));
  const key = (name) => [...foodWords(name)].sort().join(" ");
  const named = (name) => [...foodWords(name)].some((w) => said.has(w));
  const same = (a, b) => key(a.name) === key(b.name) && a.portion === b.portion && Number(a.grams) === Number(b.grams) && Number(a.kcal) === Number(b.kcal);
  const curKeys = new Set(current.map((c) => key(c.name)));
  const partner = new Map(), taken = new Set();
  // 1. Same food, same name, new numbers: corrected in place.
  current.forEach((c, ci) => {
    if (!named(c.name)) return;
    const fi = fresh.findIndex((f, i) => !taken.has(i) && key(f.name) === key(c.name));
    if (fi >= 0 && !same(c, fresh[fi])) { partner.set(ci, fi); taken.add(fi); }
  });
  // 2. Same food, NEW name. Models rename what they correct ("whole grain tortilla chips"
  //    → "Siete chips"), and matching names exactly turned that into a second line. So a
  //    named food still without a partner takes the renamed answer sharing the most words
  //    with it. On a tie, a food the model kept an unchanged copy of loses — the model is
  //    saying that one wasn't the food being corrected.
  const novel = fresh.map((f, i) => i).filter((i) => !taken.has(i) && !curKeys.has(key(fresh[i].name)));
  const keptCopy = (c) => fresh.some((f) => same(c, f));
  const pairs = [];
  current.forEach((c, ci) => {
    if (!named(c.name) || partner.has(ci)) return;
    const cw = foodWords(c.name);
    for (const fi of novel) {
      const fw = foodWords(fresh[fi].name);
      let shared = 0; for (const w of cw) if (fw.has(w)) shared++;
      if (shared) pairs.push({ ci, fi, shared, jac: shared / new Set([...cw, ...fw]).size, copy: keptCopy(c) ? 1 : 0 });
    }
  });
  pairs.sort((a, b) => b.shared - a.shared || b.jac - a.jac || a.copy - b.copy);
  for (const p of pairs) if (!partner.has(p.ci) && !taken.has(p.fi)) { partner.set(p.ci, p.fi); taken.add(p.fi); }
  // 3. Put the meal back together, in the person's order.
  const out = [];
  current.forEach((c, ci) => {
    if (!named(c.name)) out.push(c);                                    // not about this one: exactly as it was
    else if (partner.has(ci)) out.push(stated(fresh[partner.get(ci)])); // corrected, renamed or not
    else if (keptCopy(c) || !removing) out.push(c);                     // unchanged by the model, or nobody said drop it
    // else: named, gone, and the sentence says to drop it ("that's chicken, not pork")
  });
  // 4. Foods the correction brought in: a new name, not claimed above, named in the sentence.
  for (const fi of novel) {
    if (taken.has(fi) || !named(fresh[fi].name)) continue;
    if (!out.some((o) => key(o.name) === key(fresh[fi].name))) out.push(stated(fresh[fi]));
  }
  return out.length ? out : current;                                    // never turn a meal into nothing
}

export function sanitiseItems(list, { source = "photo" } = {}) {
  const items = (Array.isArray(list) ? list : []).slice(0, 20).map((it) => {
    const name = String(it?.name || "").trim().slice(0, 80);
    if (!name) return null;
    const p = clamp(it.protein_g, 0, 500, 0), c = clamp(it.carbs_g, 0, 800, 0), f = clamp(it.fat_g, 0, 400, 0);
    let kcal = clamp(it.kcal, 0, 5000, 0);
    const fromMacros = 4 * p + 4 * c + 9 * f;
    // Alcohol is 7 kcal/g and in none of the three macros: a glass of wine is ~125 kcal on 4 g of carbs.
    // Recomputing from macros wiped that out (it came back as 16), so drinks may be higher than their macros.
    const boozy = /\b(wine|beer|ale|lager|ipa|stout|cider|champagne|prosecco|cava|sake|vodka|gin|rum|tequila|mezcal|whisk(e)?y|bourbon|scotch|brandy|cognac|liqueur|cocktail|margarita|martini|mojito|spritz|sangria|seltzer)\b/i.test(name);
    if (fromMacros > 0 && (kcal <= 0 || Math.abs(kcal - fromMacros) / fromMacros > 0.25) && !(boozy && kcal > fromMacros)) kcal = fromMacros;
    const grams = clamp(it.grams, 0, 3000, 0);
    const out = {
      name, portion: String(it.portion || "").trim().slice(0, 60), grams: round1(grams),
      kcal: Math.round(kcal), protein_g: round1(p), carbs_g: round1(c), fat_g: round1(f),
      confidence: round1(clamp(it.confidence, 0, 1, 0.5)), source: String(it.source || source).slice(0, 12),
      mult: round1(clamp(it.mult, 0.1, 10, 1)),
    };
    // Per-100 g numbers travel with barcode/label items so a grams edit can recompute exactly.
    if (it.per100 && typeof it.per100 === "object") {
      out.per100 = { kcal: clamp(it.per100.kcal, 0, 900, 0), protein_g: clamp(it.per100.protein_g, 0, 100, 0), carbs_g: clamp(it.per100.carbs_g, 0, 100, 0), fat_g: clamp(it.per100.fat_g, 0, 100, 0) };
    }
    if (it.product_code) out.product_code = String(it.product_code).slice(0, 80);
    if (it.from_label) out.from_label = true;
    if (Number(it.servings) > 0) out.servings = round1(clamp(it.servings, 0, 100, 0));
    return out;
  }).filter(Boolean);
  return items;
}

export function totalsOf(items) {
  const t = { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  for (const it of items) { t.kcal += it.kcal || 0; t.protein_g += it.protein_g || 0; t.carbs_g += it.carbs_g || 0; t.fat_g += it.fat_g || 0; }
  return { kcal: Math.round(t.kcal), protein_g: round1(t.protein_g), carbs_g: round1(t.carbs_g), fat_g: round1(t.fat_g) };
}

// --- A label, checked. ---------------------------------------------------------
export function sanitiseLabel(o) {
  if (!o || typeof o !== "object") return null;
  const ps = o.per_serving || {};
  const label = {
    product: String(o.product || "").trim().slice(0, 80) || null,
    serving_size: String(o.serving_size || "").trim().slice(0, 40) || null,
    servings_per_container: clamp(o.servings_per_container, 0, 500, 0) || null,
    per_serving: {
      kcal: clamp(ps.kcal, 0, 5000, 0), protein_g: clamp(ps.protein_g, 0, 500, 0), carbs_g: clamp(ps.carbs_g, 0, 800, 0), fat_g: clamp(ps.fat_g, 0, 400, 0),
      fibre_g: clamp(ps.fibre_g, 0, 200, 0), sugar_g: clamp(ps.sugar_g, 0, 500, 0), sodium_mg: clamp(ps.sodium_mg, 0, 20000, 0),
    },
  };
  const m = label.serving_size?.match(/(\d+(?:\.\d+)?)\s*(g|ml)/i);
  label.serving_g = m ? Number(m[1]) : null;
  if (!label.per_serving.kcal && !label.per_serving.protein_g && !label.per_serving.carbs_g && !label.per_serving.fat_g) return null;
  return label;
}

// --- A receipt, checked. --------------------------------------------------------
export function sanitiseReceipt(o) {
  if (!o || typeof o !== "object") return null;
  const items = (Array.isArray(o.items) ? o.items : []).slice(0, 80).map((it) => ({
    name: String(it?.name || "").trim().slice(0, 80), qty: clamp(it?.qty, 0, 999, 1) || 1, price: Math.round(clamp(it?.price, 0, 100000, 0) * 100) / 100,
  })).filter((it) => it.name);
  const date = String(o.date || "").trim();
  return {
    store: String(o.store || "").trim().slice(0, 80) || "Unknown store",
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    currency: String(o.currency || "").trim().slice(0, 4),
    total: Math.round(clamp(o.total, 0, 1000000, 0) * 100) / 100,
    items,
  };
}

// --- Barcode check digits (EAN-13, UPC-A, EAN-8), in code, never trusted to the model.
export function validBarcode(digits) {
  digits = String(digits || "").replace(/\D/g, "");
  if (![8, 12, 13].includes(digits.length)) return null;
  const arr = digits.split("").map(Number);
  const check = arr.pop();
  let sum = 0;
  // Weights alternate 3,1 from the RIGHT of the payload for every length.
  for (let i = 0; i < arr.length; i++) sum += arr[arr.length - 1 - i] * (i % 2 === 0 ? 3 : 1);
  const want = (10 - (sum % 10)) % 10;
  return want === check ? digits : null;
}

// --- Image dimensions from the header (JPEG SOF or PNG IHDR) so we can insist the
//     stored thumbnail really is ≤ 256 px without an image library.
export function imageSize(bytes) {
  const b = new Uint8Array(bytes);
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return { w: (b[16] << 24 | b[17] << 16 | b[18] << 8 | b[19]) >>> 0, h: (b[20] << 24 | b[21] << 16 | b[22] << 8 | b[23]) >>> 0, type: "png" };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = (b[i + 2] << 8) | b[i + 3];
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8], type: "jpeg" };
      }
      i += 2 + len;
    }
  }
  return null;
}
