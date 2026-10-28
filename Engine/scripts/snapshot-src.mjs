// Copies the engine's source files into public/engine/*.txt so the admin
// "Under the hood" view can show them. Runs automatically before `wrangler dev`
// and `wrangler deploy` (see "build" in wrangler.jsonc). The Worker refuses to
// serve /engine/* to anyone without the admin token.
import { mkdirSync, copyFileSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

// --- version stamp: package.json "version" (you bump it) + build time + git commit ------
// Written to public/version.json, shown in the page footer and at /health.
let version = "0.0.0"; try { version = JSON.parse(readFileSync("package.json", "utf8")).version || version; } catch {}
let commit = ""; try { commit = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch {}
const stamp = { version, builtAt: new Date().toISOString(), commit };
writeFileSync("Engine/public/version.json", JSON.stringify(stamp));
console.log(`version ${version} (${commit || "no git"}) built ${stamp.builtAt}`);
const files = ["YourBots/config.js", "YourBots/settings.json", "Engine/worker/index.js", "Engine/worker/access.js", "Engine/worker/prompt.js", "Engine/worker/modes.js", "Engine/worker/firewall.js", "Engine/worker/handoff.js", "Engine/worker/booking.js", "Engine/worker/leads.js", "Engine/worker/gateway.js", "Engine/worker/library.js", "YourBots/index.js", "Engine/scripts/discover.mjs", "Engine/scripts/sync-library.mjs", "wrangler.jsonc", "Engine/public/index.html", "Engine/public/widget.js", "Engine/tests/break-it.mjs"];
mkdirSync("Engine/public/engine", { recursive: true });
for (const f of readdirSync("Engine/public/engine")) if (f.endsWith(".txt") || f === "index.json") { try { (await import("node:fs")).unlinkSync(join("Engine/public/engine", f)); } catch {} }
for (const f of files) copyFileSync(f, join("Engine/public/engine", f.replace(/\//g, "__") + ".txt"));
writeFileSync("Engine/public/engine/index.json", JSON.stringify(files));
console.log(`engine snapshot: ${files.length} files → Engine/public/engine/`);
