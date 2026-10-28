// What Plate's orientation second opinion (Clef, in shadow) said on real photos, next to what the page did.
// Reads track_orient_log (Engine/worker/track-orient.js) from D1.
//
//   CLOUDFLARE_ACCOUNT_ID=… node Engine/tests/orient-report.mjs              # the live database, last 7 days
//   node Engine/tests/orient-report.mjs --days 30
//   node Engine/tests/orient-report.mjs --local [--persist-to DIR] [--config FILE]   # a `wrangler dev` database
//   node Engine/tests/orient-report.mjs --fetch ~/orient-review            # + each disagreement's photo, to look at by eye
//
// Decide from the disagreements looked at one by one, not from the agreement percentage. The photos are people's
// meal photos: keep the --fetch folder off GitHub and delete it when done.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const arg = (name, dflt = null) => { const i = process.argv.indexOf(name); return i < 0 ? dflt : process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : true; };
const days = Number(arg("--days", 7)) || 7, local = Boolean(arg("--local", false)), fetchTo = arg("--fetch", null);
const extra = [...(arg("--persist-to") ? ["--persist-to", arg("--persist-to")] : []), ...(arg("--config") ? ["--config", arg("--config")] : [])];
const DB = "bot-you-own-logs", BUCKET = "bot-you-own-photos";
const wrangler = (args) => spawnSync("npx", ["wrangler", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function sql(q) {
  const r = wrangler(["d1", "execute", DB, local ? "--local" : "--remote", ...extra, "--json", "--command", q]);
  if (r.status !== 0) { console.error((r.stderr || r.stdout || "").slice(-1500)); process.exit(1); }
  try { return JSON.parse(r.stdout)[0].results; } catch { console.error("Couldn't read wrangler's answer:\n" + r.stdout.slice(0, 800)); process.exit(1); }
}

const since = new Date(Date.now() - days * 864e5).toISOString();
const rows = sql(`SELECT * FROM track_orient_log WHERE at >= '${since}' ORDER BY at`);
const looked = rows.filter((r) => r.source === "orient"), hand = rows.filter((r) => r.source === "rotate");
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "—");
const q = (xs, p) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(p * (s.length - 1))] : "—"; };

console.log(`\nOrientation shadow log — last ${days} days (${local ? "local" : "live"}): ${looked.length} photos looked at, ${hand.length} turned by hand in the viewer.`);
if (!looked.length) { console.log("Nothing logged yet. Is ORIENT_CLEF set to shadow on the deployed worker (npm run deploy:photos sets it)?\n"); process.exit(0); }
console.log(`Mode(s): ${[...new Set(looked.map((r) => r.mode))].join(", ")}`);

console.log("\nAgreement by shape (page's turn vs Clef's turn)");
console.log("shape       photos  agree   disagree  errors");
for (const shape of ["portrait", "landscape"]) {
  const s = looked.filter((r) => r.shape === shape);
  const ag = s.filter((r) => r.agree === 1).length, dis = s.filter((r) => r.agree === 0).length, err = s.filter((r) => r.agree === null).length;
  console.log(`${shape.padEnd(11)} ${String(s.length).padStart(6)}  ${`${ag} (${pct(ag, s.length - err)})`.padEnd(14)}  ${String(dis).padStart(4)}  ${String(err).padStart(6)}`);
}

const verdicts = {};
for (const r of looked) verdicts[r.clef_verdict] = (verdicts[r.clef_verdict] || 0) + 1;
console.log("\nClef's verdicts: " + Object.entries(verdicts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · "));
const by = {};
for (const r of looked) by[r.cur_by] = (by[r.cur_by] || 0) + 1;
console.log("What decided the page's turn: " + Object.entries(by).map(([k, v]) => `${k} ${v}`).join(" · "));

const ms = looked.map((r) => r.ms), spend = looked.reduce((a, r) => a + (r.cost_usd || 0), 0), tokens = looked.reduce((a, r) => a + (r.tokens || 0), 0);
console.log(`\nLatency (Clef, per photo): p50 ${q(ms, 0.5)} ms · p95 ${q(ms, 0.95)} ms · max ${q(ms, 1)} ms`);
console.log(`Spend: $${spend.toFixed(4)} for ${tokens} input tokens ($${looked.length ? (spend / looked.length).toFixed(5) : 0} a photo)`);

const dis = looked.filter((r) => r.agree === 0);
console.log(`\nDisagreements (${dis.length}) — look at each one:`);
if (fetchTo) mkdirSync(fetchTo, { recursive: true });
for (const r of dis) {
  let p = ""; try { p = JSON.parse(r.probs_json).looks.map((l) => `${l.asked}: ` + Object.entries(l.p).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k} ${v}`).join(", ")).join(" | "); } catch {}
  let file = "";
  if (fetchTo && r.image_key) {
    file = join(fetchTo, `${r.at.slice(0, 16).replace(/[:T]/g, "-")}_page${r.cur_turn}_clef${r.clef_turn}_${r.id}.jpg`);
    const g = wrangler(["r2", "object", "get", `${BUCKET}/${r.image_key}`, local ? "--local" : "--remote", ...extra, "--file", file]);
    if (g.status !== 0) file = "(fetch failed)";
  }
  console.log(`  ${r.at.slice(0, 16)}  ${r.shape.padEnd(9)} page ${String(r.cur_turn).padStart(3)} (${r.cur_by})  clef ${String(r.clef_turn).padStart(3)} (${r.clef_verdict})${r.hand ? "  [turned by hand]" : ""}  ${p}${file ? "\n      " + file : r.image_key ? `\n      r2: ${r.image_key}` : ""}`);
}
if (hand.length) {
  const hd = {};
  for (const r of hand) hd[r.hand] = (hd[r.hand] || 0) + 1;
  console.log(`\nTurned by hand in the viewer (photos that were still wrong after saving): ` + Object.entries(hd).map(([k, v]) => `${k}° ×${v}`).join(" · "));
}
console.log("");
