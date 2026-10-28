// ============================================================================
//  PLATE — THE FIX LINE (v3.11). Proves mergeCorrection() in
//  Engine/worker/track-vision.js: a correction changes only the foods it names;
//  everything else comes back exactly as the person left it.
//
//    node --import ./Engine/tests/md-loader.mjs Engine/tests/plate-fix.mjs
//
//  Offline: no Worker, no model, no cost. The model is played by fixtures that
//  misbehave on purpose — they re-guess, drift, invent and drop foods — because
//  the guarantee has to hold whatever the model does.
//  Exit code 0 = every check passed; 1 = something failed.
// ============================================================================
import { mergeCorrection, foodWords } from "../worker/track-vision.js";

let passed = 0, failed = 0;
const ok = (name, cond, detail = "") => { if (cond) { passed++; console.log(`  PASS  ${name}`); } else { failed++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); } };
const item = (name, portion, grams, kcal, extra = {}) => ({ name, portion, grams, kcal, protein_g: 0, carbs_g: Math.round(kcal / 4), fat_g: 0, confidence: 0.8, source: "photo", mult: 1, ...extra });
const find = (list, name) => list.find((i) => i.name === name);
const names = (list) => list.map((i) => i.name).join(", ");

console.log("# plate-fix — the Fix line keeps what it wasn't asked to change");

console.log("\n(a) two corrections in a row — the bug report (strawberries, then blueberries)");
const photo = [item("blueberries", "20 berries", 30, 17), item("raspberries", "3 berries", 12, 6), item("strawberries", "1/2 cup", 76, 24), item("blackberries", "2 berries", 10, 5)];
const fix1 = mergeCorrection(photo, [item("blueberries", "1/3 cup", 50, 29), item("raspberries", "4 berries", 16, 8), item("strawberries", "8 slices", 96, 31), item("blackberries", "3 berries", 15, 7)], "8 slices of strawberries");
ok("fix 1: strawberries become 8 slices", find(fix1, "strawberries")?.portion === "8 slices");
ok("fix 1: the model's re-guesses of the other three are ignored", find(fix1, "blueberries") === photo[0] && find(fix1, "raspberries") === photo[1] && find(fix1, "blackberries") === photo[3]);
// The model looks at the photo again and, knowing nothing of fix 1, says "1/2 cup" of strawberries again.
const fix2 = mergeCorrection(fix1, [item("blueberries", "30 berries", 45, 26), item("raspberries", "3 berries", 12, 6), item("strawberries", "1/2 cup", 76, 24), item("blackberries", "2 berries", 10, 5)], "30 blueberries");
ok("fix 2 does NOT undo fix 1: strawberries still 8 slices", find(fix2, "strawberries")?.portion === "8 slices", "got " + find(fix2, "strawberries")?.portion);
ok("fix 2: blueberries become 30 berries", find(fix2, "blueberries")?.portion === "30 berries");
ok("fix 2: same four foods, same order", names(fix2) === "blueberries, raspberries, strawberries, blackberries", names(fix2));

console.log("\n(b) portion taps and typed grams on other foods survive a correction");
const tapped = [item("toast", "1 slice", 30, 80), { ...item("eggs", "2 eggs", 100, 140), grams: 150, kcal: 210, mult: 1.5 }, { ...item("avocado", "1/2 avocado", 70, 110), grams: 55, kcal: 86 }];
const out = mergeCorrection(tapped, [item("toast", "2 slices", 60, 160), item("eggs", "2 eggs", 100, 140), item("avocado", "1/2 avocado", 70, 110)], "two slices of toast");
ok("toast corrected to 2 slices", find(out, "toast")?.portion === "2 slices");
ok("eggs keep the 1½× tap (150 g)", find(out, "eggs") === tapped[1]);
ok("avocado keeps the typed 55 g", find(out, "avocado") === tapped[2]);

console.log("\n(c) \"that's chicken, not pork\" swaps one food and touches nothing else");
const dinner = [item("pork chop", "1 chop", 150, 300), item("rice", "1 cup", 180, 220), item("green beans", "1 cup", 100, 35)];
const swapped = mergeCorrection(dinner, [item("chicken breast", "1 breast", 150, 250), item("rice", "1.5 cups", 270, 330), item("green beans", "1 cup", 100, 35)], "that's chicken, not pork");
ok("pork is gone", !swapped.some((i) => /pork/.test(i.name)), names(swapped));
ok("chicken is in", swapped.some((i) => /chicken/.test(i.name)), names(swapped));
ok("rice kept exactly — the model's drift to 1.5 cups ignored", find(swapped, "rice") === dinner[1]);

console.log("\n(d) removing only happens when the sentence says so");
const two = [item("strawberries", "1/2 cup", 76, 24), item("blueberries", "20 berries", 30, 17)];
const lazy = mergeCorrection(two, [item("strawberries", "8 slices", 96, 31)], "8 strawberries and 30 blueberries");
ok("the model left blueberries out — they stay", find(lazy, "blueberries") === two[1], names(lazy));
const told = mergeCorrection(two, [item("strawberries", "1/2 cup", 76, 24)], "no blueberries");
ok("\"no blueberries\" does remove them", !told.some((i) => i.name === "blueberries"), names(told));

console.log("\n(e) the model can't sneak in a food nobody mentioned");
const salad = mergeCorrection([item("salad", "1 bowl", 200, 150)], [item("salad", "large bowl", 300, 220), item("croutons", "handful", 20, 90)], "bigger salad");
ok("croutons dropped", !salad.some((i) => i.name === "croutons"), names(salad));
ok("salad corrected", find(salad, "salad")?.portion === "large bowl");

console.log("\n(f) names match through plurals, \"sliced\", units and numbers");
ok("\"8 sliced strawberries\" and \"strawberry\" are the same food", [...foodWords("8 sliced strawberries")].join() === [...foodWords("strawberry")].join());
const renamed = mergeCorrection([item("strawberries", "1/2 cup", 76, 24)], [item("sliced strawberries", "8 slices", 96, 31)], "8 strawberry slices");
ok("the model's new name still replaces the old one in place", renamed.length === 1 && renamed[0].portion === "8 slices", names(renamed));

console.log("\n(g) a barcode item keeps its exact per-100 g numbers");
const pot = item("greek yogurt", "170 g pot", 170, 100, { source: "barcode", per100: { kcal: 59, protein_g: 10, carbs_g: 3.6, fat_g: 0.4 }, product_code: "0000000000017" });
const bowl = mergeCorrection([pot, item("granola", "1/4 cup", 30, 130)], [item("greek yogurt", "1 cup", 245, 150), item("granola", "1/2 cup", 60, 260)], "half a cup of granola");
ok("yogurt untouched, per-100 g table intact", find(bowl, "greek yogurt") === pot);
ok("granola corrected", find(bowl, "granola")?.grams === 60);

console.log("\n(h) a correction that can't be applied changes nothing");
const pasta = [item("pasta", "1 cup", 140, 220)];
ok("a sentence naming no food on the plate: kept exactly", mergeCorrection(pasta, [item("pasta", "2 cups", 280, 440)], "less oil")[0] === pasta[0]);
ok("an empty model answer: kept exactly", mergeCorrection(pasta, [], "more pasta")[0] === pasta[0]);

console.log("\n(i) a food the person corrects is never flagged \"not sure\"");
const berries = [item("blueberries", "20 berries", 30, 17, { confidence: 0.9 }), item("strawberries", "1/2 cup", 76, 24, { confidence: 0.4 }), item("whole milk", "1 glass", 240, 150)];
const unsure = mergeCorrection(berries, [item("blueberries", "1/4 cup", 37, 21, { confidence: 0.3 }), item("strawberries", "1/2 cup", 76, 24, { confidence: 0.4 }), item("whole milk", "1 glass", 240, 150)], "1/4 cup blueberries");
ok("the corrected food is at least 0.9 though the model said 0.3", find(unsure, "blueberries")?.confidence >= 0.9, "got " + find(unsure, "blueberries")?.confidence);
ok("a food nobody corrected keeps the model's own doubt (still \"not sure\")", find(unsure, "strawberries") === berries[1] && berries[1].confidence === 0.4);
const blank = mergeCorrection(berries, [{ ...item("strawberries", "4 whole strawberries", 48, 15), confidence: undefined }, item("blueberries", "20 berries", 30, 17), item("whole milk", "1 glass", 240, 150)], "4 whole strawberries");
ok("model gave no confidence at all: the corrected food still isn't \"not sure\"", find(blank, "strawberries")?.confidence >= 0.9, "got " + find(blank, "strawberries")?.confidence);
ok("\"4 whole strawberries\" doesn't touch the whole milk", find(blank, "whole milk") === berries[2]);

console.log("\n(j) the model renames the food it corrects — the tortilla chips report");
const snack = [item("whole grain tortilla chips", "1 handful", 28, 140), item("salsa", "1/2 cup", 130, 40), item("guacamole", "1/4 cup", 60, 90)];
const rn = mergeCorrection(snack, [item("Seite chips", "11 chips", 30, 150), item("salsa", "1/2 cup", 130, 40), item("guacamole", "1/4 cup", 60, 90)], "11 Seite chips");
ok("renamed answer replaces the chips in place — no second line", names(rn) === "Seite chips, salsa, guacamole", names(rn));
ok("the chips line now says 11 chips", rn[0].portion === "11 chips");
const both = mergeCorrection(snack, [snack[0], item("Seite chips", "11 chips", 30, 150), snack[1], snack[2]], "11 Seite chips");
ok("model kept an unchanged copy AND added a renamed one: still one chips line", names(both) === "Seite chips, salsa, guacamole", names(both));
const longer = mergeCorrection(snack, [item("Siete whole grain tortilla chips", "11 chips", 30, 150), snack[1], snack[2]], "the whole grain tortilla chips are siete brand and there are 11 of them");
ok("Amy's longer sentence updates the chips line", longer.length === 3 && longer[0].portion === "11 chips" && /siete/i.test(longer[0].name), names(longer));
const dip = [snack[1], snack[2]];
const added = mergeCorrection(dip, [snack[1], snack[2], item("Siete chips", "11 chips", 30, 150)], "add 11 Siete chips");
ok("a real \"add\" still adds a food", names(added) === "salsa, guacamole, Siete chips", names(added));

console.log("\n(k) two similar foods: the one being corrected is the one that changes");
const soupFirst = [item("chicken soup", "1 bowl", 250, 180), item("chicken breast", "1 breast", 150, 250), item("rice", "1 cup", 180, 220)];
const thigh = mergeCorrection(soupFirst, [soupFirst[0], item("chicken thigh", "1 thigh", 120, 230), soupFirst[2]], "that's chicken thigh, not breast");
ok("the breast becomes the thigh, even with the soup listed first", names(thigh) === "chicken soup, chicken thigh, rice", names(thigh));
ok("the soup is untouched", find(thigh, "chicken soup") === soupFirst[0]);

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed ? 1 : 0);
