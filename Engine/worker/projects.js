// ============================================================================
//  PROJECTS — one loader for every kind of bot.
//
//  Every deployable thing is a folder in YourBots/ with a project.json. The
//  file says what KIND it is:
//    "kind": "chat"   a chat bot (the default — every bot before v3.7 is one)
//    "kind": "food"   an app-shaped bot: the photo food log ("Plate")
//  The common fields are the same for every kind — name, tagline, greeting,
//  order, access, listed, accessKey, handoffActions. The kind-specific settings
//  live in one nested block: a chat bot keeps its fields where they always were
//  (mode, grounding, instructions, files …) so old folders still load unchanged;
//  a food bot has a "food": { … } block.
//
//  Where a bot comes from, in order: the saved copy in D1 (Configure → Save)
//  overrides the folder in YourBots/ (what discover.mjs bundled at deploy time).
//  YourBots/config.js → foodLog is still honoured as a DEPRECATED fallback: if no
//  folder says kind "food", a bot "plate" is made from it, with a warning.
// ============================================================================

import { CONFIG } from "../../YourBots/config.js";
import { PROJECTS, getProject as folderProject, listProjects as folderList } from "../../YourBots/index.js";
import { MODES } from "./modes.js";
import { normaliseHandoffActions } from "./handoff.js";
import { normaliseBooking } from "./booking.js";
import { cleanMode, cleanKeyName } from "./access.js";

export const KIND_LABELS = { chat: "chat bot", food: "food log (an app)" };
export const SIGNIN_PROVIDERS = ["google", "microsoft", "apple"];

// --- The kinds table. Add a kind: one function here, one panel in index.html. ----
export const KINDS = { chat: normaliseChat, food: normaliseFood };

export function cleanKind(k) { return KINDS[String(k || "").toLowerCase()] ? String(k).toLowerCase() : "chat"; }

// The fields every kind shares. `id` is the folder name; nothing here is kind-specific.
// A model id as Workers AI writes them, or a bare provider model for the openai/anthropic
// providers. Nothing clever: trim, cap, and drop anything with whitespace or quotes in it.
export function cleanModelId(v) {
  const s = String(v || "").trim().slice(0, 120);
  return /^[A-Za-z0-9@/._:-]+$/.test(s) ? s : "";
}

export function normaliseProject(p, id) {
  p = p && typeof p === "object" ? p : {};
  const kind = cleanKind(p.kind);
  const common = {
    id, kind, order: Number(p.order ?? 100),
    name: String(p.name || id).slice(0, 80), tagline: String(p.tagline || "").slice(0, 200), greeting: String(p.greeting || "").slice(0, 400),
    handoffActions: normaliseHandoffActions(p.handoffActions),   // { webhook, email, on } — Engine/worker/handoff.js
    // who can use THIS bot (Engine/worker/access.js): "" = the deployment default; listed = in the sidebar;
    // accessKey = the NAME of a per-bot secret (ACCESS_PASSPHRASE_…), never a passphrase itself
    access: cleanMode(p.access), listed: p.listed !== false, accessKey: cleanKeyName(p.accessKey),
    // This bot's own model. "" = the deployment's (YourBots/config.js → model). A bot doing a
    // constrained job is well served by something small and cheap; the ChatGPT-style assistant
    // is the one people compare against the real thing, and it can be worth more per turn.
    model: cleanModelId(p.model),
    // this bot's own identity knobs (Engine/identity/): graceMinutes = the return window; "" = the deployment's
    identity: normaliseIdentity(p.identity),
    // A visitor's own sandbox bot (Engine/worker/sandbox.js): who owns it and when it goes.
    // Only that person (by device identity) and the admin can see or use it.
    sandbox: p.sandbox && typeof p.sandbox === "object" && p.sandbox.email ? { email: String(p.sandbox.email).slice(0, 254), userId: String(p.sandbox.userId || "").slice(0, 64), expires_at: String(p.sandbox.expires_at || "").slice(0, 30), source: String(p.sandbox.source || "").slice(0, 120) } : null,
  };
  return { ...common, ...KINDS[kind](p, id) };
}

// project.json → identity: { graceMinutes }. Only what's set is kept, so the deployment's number still applies otherwise.
function normaliseIdentity(i) {
  const out = {};
  if (i && typeof i === "object" && i.graceMinutes !== undefined && i.graceMinutes !== null && i.graceMinutes !== "") {
    const n = Number(i.graceMinutes);
    if (Number.isFinite(n) && n >= 0) out.graceMinutes = Math.min(Math.round(n), 7 * 24 * 60);
  }
  return out;
}

// --- kind: chat. Exactly the shape it always had (backward compatible). ---------------
const OVERRIDABLE = ["1-identity.md", "2-capabilities.md", "3-personality.md", "4-formatting.md", "5-owner-instructions-intro.md", "6-files-strict.md", "6-files-open.md", "7-answering-strict.md", "7-answering-open.md", "8-links.md", "9-boundaries.md"];
const clean = (t) => String(t || "").replace(/<!--[\s\S]*?-->/g, "").trim();
function normaliseChat(p) {
  return {
    starters: (Array.isArray(p.starters) ? p.starters : []).map((x) => String(x).slice(0, 120)).filter(Boolean).slice(0, 4),
    mode: MODES[p.mode] ? p.mode : "answer", grounding: p.grounding === "open" ? "open" : "strict",
    handoffText: String(p.handoffText || "").slice(0, 300), handoffContact: String(p.handoffContact || "").slice(0, 300),
    allowedLinks: (Array.isArray(p.allowedLinks) ? p.allowedLinks : []).map((x) => String(x).trim()).filter((x) => /^https?:\/\//.test(x)).slice(0, 40),
    thinkingWords: (Array.isArray(p.thinkingWords) ? p.thinkingWords : []).map((x) => String(x).slice(0, 60)).filter(Boolean).slice(0, 40),
    intakeQuestions: (Array.isArray(p.intakeQuestions) ? p.intakeQuestions : []).map((x) => String(x).slice(0, 200)).slice(0, 10),
    bookingUrl: String(p.bookingUrl || ""), bookingFitRules: String(p.bookingFitRules || "").slice(0, 2000),
    booking: normaliseBooking(p.booking),                       // { provider, eventTypeId, timezone, durationNote } — Engine/worker/booking.js
    nextSteps: (Array.isArray(p.nextSteps) ? p.nextSteps : []).slice(0, 10),
    communityStep: Boolean(p.communityStep),                    // append config.community as the last next step (Engine/worker/modes.js)
    tour: p.tour && Array.isArray(p.tour.stops) ? { stops: p.tour.stops.map((x) => String(x).slice(0, 20)).filter(Boolean).slice(0, 8) } : null,   // this bot is the guide (Engine/worker/tour.js)
    website: normaliseWebsite(p.website),                       // one URL, and glob patterns for which pages to keep / skip
    instructions: clean(p.instructions).slice(0, 20000),
    files: Object.fromEntries(Object.entries(p.files || {}).filter(([n]) => /^[\w. -]{1,80}\.(md|txt|csv)$/i.test(n)).map(([n, t]) => [n, clean(t).slice(0, 200000)]).slice(0, 40)),
    // this bot's own copies of root prompt/ files (same names) — the folder-wins rule, from the form
    prompt: Object.fromEntries(Object.entries(p.prompt || {}).filter(([n]) => OVERRIDABLE.includes(n) || /^jobs\/[a-z-]+\.md$/.test(n)).map(([n, t]) => [n, clean(t).slice(0, 20000)]).filter(([, t]) => t.length > 0)),
  };
}
export function normaliseWebsite(w) {
  const globs = (v) => (Array.isArray(v) ? v : String(v || "").split(/[\n,]/)).map((x) => String(x).trim().slice(0, 200)).filter(Boolean).slice(0, 10);
  const url = String(w?.url || "").trim().slice(0, 500);
  const sitemap = String(w?.sitemap || "").trim().slice(0, 500);
  return { url: /^https?:\/\/\S+$/i.test(url) ? url : "", include: globs(w?.include), exclude: globs(w?.exclude), ...(sitemap ? { sitemap } : {}) };
}

// --- kind: food. Everything that was config.foodLog, in the bot's own "food" block. --------
const clampN = (v, min, max, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; };
function normaliseFood(p) {
  const f = p.food && typeof p.food === "object" ? p.food : {};
  const signIn = (Array.isArray(f.signIn) ? f.signIn : SIGNIN_PROVIDERS.map((provider) => ({ provider, clientId: "" })))
    .map((s) => ({ provider: String(s?.provider || "").toLowerCase(), clientId: String(s?.clientId || "").trim().slice(0, 200) }))
    .filter((s) => SIGNIN_PROVIDERS.includes(s.provider));
  return {
    food: {
      model: String(f.model || "@cf/google/gemma-4-26b-a4b-it").slice(0, 120),   // the vision model
      dailyPhotoLimit: clampN(f.dailyPhotoLimit, 1, 1000, 60),                 // vision calls per person per day
      maxPhotoBytes: clampN(f.maxPhotoBytes, 200 * 1024, 8 * 1024 * 1024, 2 * 1024 * 1024),
      coachName: String(f.coachName || "").slice(0, 80),                         // "Your coach: …" on the page
      signIn,                                                                    // [{ provider, clientId }] — a button shows only with a client id (or the <PROVIDER>_CLIENT_ID secret)
      honesty: String(f.honesty || "Photo estimates are typically within about 30%. Fix the portion when it's off.").slice(0, 300),
      passkeys: f.passkeys !== false,                                            // "Set up a passkey" on the page (needs a browser that can)
      totp: f.totp !== false,                                                    // authenticator-app code for a second device
    },
  };
}

// --- The deprecated fallback: config.foodLog → a bot "plate" (only if no folder is kind food).
let WARNED = false;
function legacyFoodBot() {
  const f = CONFIG.foodLog;
  if (!f || f.enabled === false) return null;
  if (Object.values(PROJECTS).some((p) => p.kind === "food")) return null;
  if (!WARNED) { WARNED = true; console.warn("config.foodLog is deprecated: move it to YourBots/plate/project.json with \"kind\": \"food\" (docs/FOOD-LOG.md). Using it as bot \"plate\" meanwhile."); }
  return normaliseProject({ kind: "food", name: f.name || "Plate", tagline: "Photo food log", order: 90, access: "email", food: { model: f.model, dailyPhotoLimit: f.dailyPhotoLimit, maxPhotoBytes: f.maxPhotoBytes, coachName: f.coachName, signIn: f.signIn } }, "plate");
}

// --- Saved copies (D1): Configure → Save writes here; a saved bot overrides the folder. ------
let SAVED_CACHE = { at: 0, map: {} };
let TABLE_OK = false;
async function ensureTable(env) {
  if (TABLE_OK || !env.DB) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL)`).run();
  TABLE_OK = true;
}
export async function savedProjects(env) {
  if (!env.DB) return {};
  if (Date.now() - SAVED_CACHE.at < 15000) return SAVED_CACHE.map;
  try {
    await ensureTable(env);
    const rows = (await env.DB.prepare(`SELECT id, json FROM projects`).all()).results || [];
    const map = {};
    for (const r of rows) { try { map[r.id] = normaliseProject(JSON.parse(r.json), r.id); } catch {} }
    SAVED_CACHE = { at: Date.now(), map };
  } catch (err) { console.error("saved projects read failed", err); }
  return SAVED_CACHE.map;
}
export async function saveProject(env, pid, raw) {
  const p = normaliseProject(raw, pid);
  await ensureTable(env);
  await env.DB.prepare(`INSERT INTO projects (id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`).bind(pid, JSON.stringify(p), new Date().toISOString()).run();
  SAVED_CACHE.at = 0;
  return p;
}
export async function deleteSavedProject(env, id) {
  await ensureTable(env);
  await env.DB.prepare(`DELETE FROM projects WHERE id = ?`).bind(id).run();
  SAVED_CACHE.at = 0;
}
export function inFolder(id) { return Boolean(PROJECTS[id]) || (id === "plate" && Boolean(legacyFoodBot())); }

// One bot by id: saved copy, else the folder, else the default bot.
export async function resolveProject(env, id) {
  const saved = await savedProjects(env);
  if (id && saved[id]) return saved[id];
  if (id && PROJECTS[id]) return normaliseProject(folderProject(id, CONFIG.defaultProject), id);
  if (id === "plate") { const l = legacyFoodBot(); if (l) return l; }
  return saved[CONFIG.defaultProject] || normaliseProject(folderProject(CONFIG.defaultProject, CONFIG.defaultProject), CONFIG.defaultProject);
}
// Every bot, every kind, sidebar order. `source` says where it came from.
export async function resolveList(env) {
  const saved = await savedProjects(env);
  const folder = folderList().map((p) => ({ ...p, kind: cleanKind(PROJECTS[p.id]?.kind), source: saved[p.id] ? "saved (overrides folder)" : "folder" }));
  const legacy = legacyFoodBot();
  if (legacy && !saved.plate) folder.push({ id: "plate", ...pickPublic(legacy), source: "config.js → foodLog (deprecated)" });
  const extra = Object.values(saved).filter((p) => !PROJECTS[p.id]).map((p) => ({ id: p.id, ...pickPublic(p), source: "saved" }));
  const merged = [...folder.map((p) => saved[p.id] ? { ...p, ...pickPublic(saved[p.id]), source: p.source } : p), ...extra];
  return merged.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || String(a.name).localeCompare(String(b.name)));
}
// What a bot shows to the page. `access` is what the bot SAYS ("" = default); the effective mode is per request. Never the secret's name.
export function pickPublic(p) {
  return { kind: cleanKind(p.kind), name: p.name, tagline: p.tagline, greeting: p.greeting, starters: p.starters, mode: p.mode, grounding: p.grounding, model: p.model || "", thinkingWords: (p.thinkingWords || []).length ? p.thinkingWords : undefined, order: p.order, access: cleanMode(p.access), listed: p.listed !== false, ...(p.tour ? { tour: p.tour } : {}), ...(p.sandbox ? { sandbox: { expires_at: p.sandbox.expires_at, source: p.sandbox.source, samples: p.sandbox.samples || {} } } : {}) };
}
// Where a bot lives on the page: chat bots on the chat page, apps at /apps/<id>.
export function hrefFor(p) { return cleanKind(p.kind) === "chat" ? `/?project=${encodeURIComponent(p.id)}` : `/apps/${encodeURIComponent(p.id)}`; }

// Export / Commit to GitHub: the folder's files for one bot, whatever its kind.
export function exportFiles(p, id) {
  const { instructions, files, prompt, id: _i, ...meta } = p;
  if (meta.kind === "chat") delete meta.kind;                       // chat bots stay exactly as before
  if (meta.identity && !Object.keys(meta.identity).length) delete meta.identity;
  const out = { [`YourBots/${id}/project.json`]: JSON.stringify(meta, null, 2) + "\n" };
  if (p.kind === "chat") {
    out[`YourBots/${id}/instructions.md`] = (instructions || "") + "\n";
    for (const [n, t] of Object.entries(files || {})) out[`YourBots/${id}/knowledge/${n}`] = t + "\n";
    for (const [n, t] of Object.entries(prompt || {})) out[`YourBots/${id}/prompt/${n}`] = t + "\n";
  }
  return out;
}
