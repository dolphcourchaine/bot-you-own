// ============================================================================
//  PLATE — THE DAY AS A CONVERSATION (v3.10). Proves Engine/worker/track-day.js
//  through the live routes: reactions, favourites, "say", repeats, copy-a-day,
//  naming, the portion check, the summaries, and the coach's week paragraph.
//
//    node Engine/tests/plate-day.mjs --url http://localhost:8797 --admin "the admin code" [--bot plate] [--no-model]
//
//  Costs: the text estimate (Gemma) and, unless --no-model, two summaries and
//  one question to the coach (gpt-oss) — about 150 neurons, a fraction of a cent.
//  A fresh throwaway person is made each run (its rows stay in D1; harmless).
//  Exit code 0 = every check passed; 1 = something failed.
// ============================================================================
const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
const URL_ = String(args.url || process.env.BYO_URL || "http://localhost:8787").replace(/\/$/, "");
const BOT = String(args.bot || "plate");
const ADMIN_PASS = String(args.admin || process.env.BYO_ADMIN || "");
const MODEL = !args["no-model"];
const API = `${URL_}/api/apps/${BOT}/`;

let passed = 0, failed = 0;
const ok = (name, cond, detail = "") => { if (cond) { passed++; console.log(`  PASS  ${name}`); } else { failed++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); } };
const devKey = () => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
const D = devKey(), TZ = 0;
const api = async (path, { method, json, headers = {}, base = API } = {}) => {
  const r = await fetch(base + path, { method: method || (json ? "POST" : "GET"), headers: { "x-device-key": D, ...(json ? { "content-type": "application/json" } : {}), ...headers }, body: json ? JSON.stringify({ tz: TZ, ...json }) : undefined });
  const body = await r.json().catch(() => ({})); return { status: r.status, ...body };
};
const today = new Date().toISOString().slice(0, 10);
const shift = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const yesterday = shift(today, -1);

console.log(`# plate-day — ${URL_} · bot ${BOT}${MODEL ? "" : " · --no-model"}`);
const EM = `plate-${Date.now().toString(36)}@example.com`;
const j = await api("join", { json: { email: EM } });
ok("join → linked", j.status === 200 && j.linked === true, JSON.stringify(j).slice(0, 120));
const t = await api("targets", { json: { kcal: 2000, protein_g: 150, carbs_g: 200, fat_g: 65, name: "Tester" } });
ok("targets set", t.ok === true, JSON.stringify(t).slice(0, 120));

// (a) a hand-saved meal → a reaction line in the day's chat, and a favourite
console.log("\n(a) a meal becomes a turn, a reaction and a favourite");
const items = [{ name: "chicken breast", portion: "1 breast", grams: 150, kcal: 250, protein_g: 45, carbs_g: 0, fat_g: 5 }, { name: "rice", portion: "1 cup", grams: 180, kcal: 220, protein_g: 4, carbs_g: 48, fat_g: 1 }, { name: "broccoli", portion: "1 cup", grams: 90, kcal: 30, protein_g: 2, carbs_g: 6, fat_g: 0 }];
const m1 = await api("meal", { json: { date: yesterday, items, source: "text" } });
ok("POST meal → ok with day totals", m1.ok === true && m1.totals?.kcal === 500, JSON.stringify(m1).slice(0, 160));
const c1 = await api(`chat?date=${yesterday}`);
const kinds = (c1.turns || []).map((x) => x.type + ":" + (x.kind || ""));
ok("GET chat → the meal then its reaction", kinds[0] === "meal:" && kinds[1] === "text:reaction", kinds.join(","));
const react = (c1.turns || []).find((x) => x.kind === "reaction")?.text || "";
ok("the reaction is from the numbers (kcal, left, protein of target)", /500 kcal/.test(react) && /1,500 left/.test(react) && /protein 51 of 150/.test(react), react);
const f1 = await api(`favourites?hour=12&date=${today}`);
const fav = [...(f1.now || []), ...(f1.rest || [])].find((f) => /chicken/.test(f.label));
ok("GET favourites → the meal is a chip", Boolean(fav) && fav.timesUsed === 1, JSON.stringify(f1).slice(0, 200));
ok("favourites says yesterday can be copied (1 meal, 500 kcal)", f1.yesterday?.date === yesterday && f1.yesterday.meals === 1 && f1.yesterday.kcal === 500, JSON.stringify(f1.yesterday));

// (b) say: a repeat is matched before any model runs
console.log("\n(b) say → repeat");
const s1 = await api("say", { json: { text: "chicken and rice again", date: today, hour: 12 } });
ok("\"chicken and rice again\" → kind repeat, the favourite, a question", s1.kind === "repeat" && s1.favourite?.id === fav.id && /Right\?$/.test(s1.question || ""), JSON.stringify(s1).slice(0, 200));
const s2 = await api("say", { json: { text: "broccoli", date: today, hour: 12 } });
ok("one food of three named → NOT a repeat (estimated fresh or asked)", s2.kind !== "repeat", JSON.stringify(s2).slice(0, 120));
if (s2.kind === "meal") await api(`meal/${s2.meal.id}`, { method: "DELETE" });

// (c) repeat it: logged at once; the third use asks for a name; the fifth checks the portion
console.log("\n(c) repeat, name, portion check");
const r1 = await api("repeat", { json: { favouriteId: fav.id, date: today } });
ok("POST repeat → one meal, source repeat, totals", r1.ok === true && r1.meals?.length === 1 && r1.meals[0].source === "repeat" && r1.totals?.kcal === 500, JSON.stringify(r1).slice(0, 200));
ok("second use: no name asked yet", r1.askName === false, `askName ${r1.askName}`);
const r2 = await api("repeat", { json: { favouriteId: fav.id, date: today } });
ok("third use → askName", r2.askName === true && r2.checkPortion === false, JSON.stringify({ askName: r2.askName, checkPortion: r2.checkPortion }));
const c2 = await api(`chat?date=${today}`);
const reactAgain = (c2.turns || []).filter((x) => x.kind === "reaction").map((x) => x.text);
ok("a repeat's reaction says so", reactAgain.some((x) => /again/.test(x)), reactAgain.join(" | "));
const n1 = await api("favourite/name", { json: { id: fav.id, name: "Work Lunch" } });
ok("name it", n1.ok === true && n1.name === "Work Lunch", JSON.stringify(n1));
const s3 = await api("say", { json: { text: "log my work lunch", date: today, hour: 13 } });
ok("say by name → repeat", s3.kind === "repeat" && s3.favourite?.id === fav.id && /work lunch/i.test(s3.question), JSON.stringify(s3).slice(0, 160));
const r3 = await api("repeat", { json: { favouriteId: fav.id, date: today, mult: 0.5 } });
ok("half portion (mult 0.5) → 250 kcal meal", r3.ok && Math.round(r3.meals[0].kcal) === 250, JSON.stringify(r3.meals?.[0]?.kcal));
const r4 = await api("repeat", { json: { favouriteId: fav.id, date: today } });
ok("fifth use → checkPortion (\"still about this much?\")", r4.checkPortion === true, JSON.stringify({ checkPortion: r4.checkPortion, askName: r4.askName }));
const c3 = await api(`chat?date=${today}`);
ok("a named favourite's reaction uses the name", (c3.turns || []).some((x) => x.kind === "reaction" && /Work Lunch again/.test(x.text)), (c3.turns || []).filter((x) => x.kind === "reaction").map((x) => x.text).join(" | "));

// (d) copy a whole day
console.log("\n(d) same as yesterday");
const day2 = shift(today, -2);
const cp = await api("repeat", { json: { fromDate: yesterday, date: day2 } });
ok("copy yesterday into another day → its meals, from", cp.ok === true && cp.meals?.length === 1 && cp.from === yesterday, JSON.stringify(cp).slice(0, 160));
const cp2 = await api("repeat", { json: { fromDate: shift(today, -30), date: today } });
ok("copying an empty day → 404 with a reason", cp2.status === 404 && /Nothing was logged/.test(cp2.reason || ""), JSON.stringify(cp2));
const cp3 = await api("repeat", { json: { fromDate: today, date: today } });
ok("copying a day onto itself → 400", cp3.status === 400, `got ${cp3.status}`);

// (e) delete a meal: its reaction goes; a favourite nobody reused goes too
console.log("\n(e) delete");
const m2 = await api("meal", { json: { date: today, items: [{ name: "banana", portion: "1", grams: 118, kcal: 105, protein_g: 1, carbs_g: 27, fat_g: 0 }], source: "text" } });
const favB = [...((await api(`favourites?hour=12&date=${today}`)).rest || []), ...((await api(`favourites?hour=12&date=${today}`)).now || [])].find((f) => /banana/.test(f.label));
ok("a new meal made a banana favourite", Boolean(favB), "");
const del = await api(`meal/${m2.meal.id}`, { method: "DELETE" });
const c4 = await api(`chat?date=${today}`);
const f2 = await api(`favourites?hour=12&date=${today}`);
ok("DELETE meal → no turn, no reaction, no banana chip", del.ok === true && !(c4.turns || []).some((x) => x.mealId === m2.meal.id || (x.type === "meal" && x.meal.id === m2.meal.id)) && ![...(f2.now || []), ...(f2.rest || [])].some((f) => /banana/.test(f.label)), JSON.stringify(f2).slice(0, 120));

// (f) a stranger sees nothing
console.log("\n(f) fail closed");
const st = await fetch(`${API}chat?date=${today}`, { headers: { "x-device-key": devKey() } });
ok("chat from an unknown device → 401", st.status === 401, `got ${st.status}`);
const sn = await fetch(`${API}say`, { method: "POST", headers: { "x-device-key": devKey(), "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
ok("say from an unknown device → 401", sn.status === 401, `got ${sn.status}`);
const e1 = await api("say", { json: { text: "   ", date: today } });
ok("say with nothing → 400", e1.status === 400, `got ${e1.status}`);

// (g) the model: a question, the day summary (cached second time), the week, the coach's copy
console.log("\n(g) the coach" + (MODEL ? "" : " — skipped (--no-model)"));
if (MODEL) {
  const q = await api("say", { json: { text: "how much protein have I got left today?", date: today, hour: 14 } });
  ok("a question → kind answer, two turns saved", q.kind === "answer" && q.turns?.length === 2 && q.turns[1].role === "assistant" && q.turns[1].text.length > 10, JSON.stringify(q).slice(0, 200));
  const c5 = await api(`chat?date=${today}`);
  ok("the question and the answer are in the day's chat", (c5.turns || []).some((x) => x.kind === "question") && (c5.turns || []).some((x) => x.kind === "answer"), "");
  const d1 = await api(`summary?date=${today}&kind=day`);
  ok("day summary → five parts, numbers from the facts", d1.summary && d1.summary.headline && d1.summary.landed && d1.cached === false, JSON.stringify(d1).slice(0, 240));
  const d2 = await api(`summary?date=${today}&kind=day`);
  ok("asked again → cached (no model call)", d2.cached === true, JSON.stringify({ cached: d2.cached }));
  const d0 = await api(`summary?date=${shift(today, -20)}&kind=day`);
  ok("an empty day → empty:true, nothing invented", d0.empty === true && !d0.summary, JSON.stringify(d0));
  const w1 = await api(`summary?date=${today}&kind=week`);
  ok("week summary → headline, averages, pattern; facts carry logged days", w1.summary?.headline && w1.summary.averages && w1.facts?.logged >= 2, JSON.stringify(w1).slice(0, 240));
  if (ADMIN_PASS) {
    const au = await fetch(`${URL_}/api/admin/unlock`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase: ADMIN_PASS }) });
    const A = (await au.json().catch(() => ({}))).token || "";
    ok("admin unlock", Boolean(A), `status ${au.status}`);
    if (A) {
      const cw = await fetch(`${URL_}/api/admin/apps/${BOT}/client/${j.userId}/summary?kind=week`, { headers: { "x-admin-token": A } });
      const cwj = await cw.json().catch(() => ({}));
      ok("coach: GET client/<id>/summary?kind=week → the same cached paragraph", cw.status === 200 && cwj.cached === true && cwj.summary?.headline === w1.summary.headline, JSON.stringify(cwj).slice(0, 160));
    }
  } else console.log("  (pass --admin to prove the coach's copy)");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
