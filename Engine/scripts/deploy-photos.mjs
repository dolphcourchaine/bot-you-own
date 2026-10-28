// Deploys with Plate's photo bucket switched on, without changing wrangler.jsonc (the
// template stays deployable on accounts without R2). Uncomments the r2_buckets block into
// a throwaway config beside the real one, deploys with it, and removes it.
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

const src = readFileSync("wrangler.jsonc", "utf8");
const on = src.replace(/  \/\/ "r2_buckets": \[\n  \/\/ (.*)\n  \/\/ \],/, '  "r2_buckets": [\n  $1\n  ],');
if (on === src) { console.error("No commented r2_buckets block found in wrangler.jsonc."); process.exit(1); }
writeFileSync(".wrangler.photos.jsonc", on);
// Plate's orientation second opinion (Engine/worker/track-orient.js) runs in shadow on the live site: asked and logged,
// never acted on. ORIENT_CLEF=live (or off) and ORIENT_CLEF_SAMPLE=0.25 in the shell change it for this deploy.
const mode = ["off", "shadow", "live"].includes(process.env.ORIENT_CLEF) ? process.env.ORIENT_CLEF : "shadow";
const sample = Number.isFinite(Number(process.env.ORIENT_CLEF_SAMPLE)) && process.env.ORIENT_CLEF_SAMPLE !== undefined ? String(Math.min(1, Math.max(0, Number(process.env.ORIENT_CLEF_SAMPLE)))) : "1";
console.log(`Orientation check (Clef): ${mode}, sample ${sample}`);
const r = spawnSync("npx", ["wrangler", "deploy", "--config", ".wrangler.photos.jsonc", "--var", `ORIENT_CLEF:${mode}`, "--var", `ORIENT_CLEF_SAMPLE:${sample}`, ...process.argv.slice(2)], { stdio: "inherit" });
rmSync(".wrangler.photos.jsonc", { force: true });
process.exit(r.status ?? 1);
