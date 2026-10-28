// Sync YourBots/<bot>/knowledge/ documents → the bot's library (Cloudflare AI Search).
//
// The build bundles .md/.txt/.csv from knowledge/ into the prompt. Everything
// ELSE in knowledge/ — PDFs, Word, spreadsheets, images — and anything at all
// inside knowledge/library/ (long transcripts as .txt belong there) is the
// library's job. This script sends those to the running bot, which scans and
// indexes them. Runs in GitHub Actions on every commit that touches knowledge/
// (.github/workflows/sync-library.yml). Needs two repository secrets:
//   BOT_URL           https://your-bot.workers.dev
//   ADMIN_PASSPHRASE  the same admin code the Configure screen uses
//
// Goes through the bot's own /api/admin/library route, so the same type gate,
// the same scan and the same admin code apply as in the browser. No Cloudflare
// API token needed. Items it uploaded are tagged "github"; it only ever removes
// those, never ones dropped in through Configure.
//
// The scan: a held-back file fails the job and prints what was found. To say
// "I've read that, put it in anyway", add the filename on its own line in
// YourBots/<bot>/knowledge/APPROVED.txt and commit. That IS the override, and
// it's in git — a record of who approved what, and when.
//
// Local use:  BOT_URL=… ADMIN_PASSPHRASE=… node Engine/scripts/sync-library.mjs [bot-id]

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const BOT_URL = (process.env.BOT_URL || "").replace(/\/+$/, "");
const PASS = process.env.ADMIN_PASSPHRASE || "";
const ONLY = process.argv[2] || "";
const TEXT = /\.(md|txt|csv)$/i;

if (!BOT_URL || !PASS) {
  console.log("BOT_URL or ADMIN_PASSPHRASE not set — skipping library sync. See docs/CUSTOMIZE.md → Give it documents.");
  process.exit(0);
}

// --- admin token, same as the browser ---------------------------------------
const unlock = await fetch(`${BOT_URL}/api/admin/unlock`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase: PASS }) });
const { token } = await unlock.json().catch(() => ({}));
if (!unlock.ok || !token) { console.error(`admin unlock failed (${unlock.status}). Is ADMIN_PASSPHRASE right, and is the bot deployed?`); process.exit(2); }
const headers = { "x-admin-token": token };

const isDir = async (p) => { try { return (await stat(p)).isDirectory(); } catch { return false; } };
async function walk(dir) {
  const out = [];
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

// Which files in one bot's knowledge/ are the library's: non-text at the top
// level, and everything under knowledge/library/.
async function libraryFiles(kdir) {
  const top = (await readdir(kdir, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isFile() && !e.name.startsWith(".") && !TEXT.test(e.name) && e.name.toLowerCase() !== "approved.txt")
    .map((e) => join(kdir, e.name));
  const sub = await walk(join(kdir, "library"));
  return [...top, ...sub];
}

const bots = (await readdir("YourBots", { withFileTypes: true }))
  .filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith(".") && (!ONLY || e.name === ONLY))
  .map((e) => e.name);

let failed = 0, uploaded = 0, removed = 0;
for (const bot of bots) {
  const kdir = join("YourBots", bot, "knowledge");
  if (!(await isDir(kdir))) continue;
  const approved = new Set((await readFile(join(kdir, "APPROVED.txt"), "utf8").catch(() => "")).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")));
  const files = await libraryFiles(kdir);

  // The bot's own type list, so we skip early with a reason.
  const metaRes = await fetch(`${BOT_URL}/api/admin/library?project=${encodeURIComponent(bot)}`, { headers });
  const meta = await metaRes.json().catch(() => ({}));
  if (!metaRes.ok) { console.log(`${bot}: ${meta.error || metaRes.status}`); if (metaRes.status === 503) process.exit(0); failed++; continue; }
  const exts = new Set(meta.extensions || []);
  const existing = (meta.files || []);
  if (!files.length && !existing.some((f) => f.source === "github")) continue;
  console.log(`\n${bot}`);

  const wanted = new Set();
  for (const p of files) {
    const rel = relative(kdir, p).split(sep).join("/");
    const ext = (rel.toLowerCase().match(/\.[a-z0-9]+$/) || [""])[0];
    if (!exts.has(ext)) { console.log(`  skip   ${rel}  (${ext || "no extension"} isn't a supported type)`); continue; }
    const size = (await stat(p)).size;
    if (size > (meta.maxBytes || 4194304)) { console.log(`  skip   ${rel}  (${(size / 1048576).toFixed(1)} MB, limit is 4 MB)`); continue; }

    const fd = new FormData();
    fd.append("source", "github");
    if (approved.has(rel)) fd.append("override", "1");
    fd.append("file", new Blob([await readFile(p)]), rel);
    const r = await fetch(`${BOT_URL}/api/admin/library?project=${encodeURIComponent(bot)}`, { method: "POST", headers, body: fd });
    const j = await r.json().catch(() => ({}));
    const res = j.results?.[0];
    if (r.ok && res?.ok) {
      uploaded++; wanted.add(res.name);
      console.log(`  upload ${res.name}  (${res.status}${res.chunks != null ? `, ${res.chunks} passages` : ""}${approved.has(rel) ? ", approved override" : ""})`);
    } else if (res?.needsOverride) {
      failed++;
      console.log(`  HELD   ${rel}  — the scan found:`);
      for (const f of res.flagged || []) console.log(`           · ${f.count > 1 ? `${f.count} ${f.label} (e.g. ${f.sample})` : `${f.label}${f.sample ? `: ${f.sample}` : ""}`}`);
      console.log(`           To put it in anyway, add "${rel}" on its own line in YourBots/${bot}/knowledge/APPROVED.txt and commit.`);
    } else {
      failed++;
      console.log(`  FAIL   ${rel}  ${res?.reason || j.error || r.status}`);
    }
  }

  // Remove what this script put there before and the repo no longer has.
  for (const f of existing) {
    if (f.source !== "github" || wanted.has(f.name)) continue;
    const r = await fetch(`${BOT_URL}/api/admin/library/${encodeURIComponent(f.id)}?project=${encodeURIComponent(bot)}`, { method: "DELETE", headers });
    if (r.ok) { removed++; console.log(`  remove ${f.name}`); } else { failed++; console.log(`  FAIL   remove ${f.name} (${r.status})`); }
  }
}

console.log(`\n${uploaded} uploaded, ${removed} removed, ${failed} problem(s).`);
process.exit(failed ? 1 : 0);
