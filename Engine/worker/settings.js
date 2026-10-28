// ============================================================================
//  SETTINGS — the deployment-wide knobs, read in ONE place with ONE merge order:
//
//      YourBots/config.js  <  YourBots/settings.json  <  the D1 "settings" rows
//
//  Later wins. config.js is what you ship; settings.json is what Settings →
//  Commit to GitHub wrote back into the repo; the D1 rows are what the Settings
//  screen saved (live at once, cached 10 s per isolate). If the database can't
//  be read, the last rows seen are kept — stale beats open — and failing that,
//  the files.
//
//  Three keys today, and the Settings screen edits exactly these:
//    access        { default, floor }        who can use a bot when it doesn't say
//    createYourOwn { show, text, url }       the badge under the chat
//    identity      { graceMinutes }          the return window (Engine/identity/devices.js);
//                                            a bot's own project.json → identity wins over this
//    expiry        { onLapse, graceDays,     what an end date DOES when it passes
//                    warnDays, defaultDays } (Engine/worker/expiry.js); a bot's own
//                                            project.json → expiry wins over this
// ============================================================================

import { CONFIG } from "../../YourBots/config.js";
import SETTINGS_FILE from "../../YourBots/settings.json";
import { accessSettings } from "./access.js";
import { cleanGrace, DEFAULT_GRACE_MINUTES } from "../identity/devices.js";
import { expirySettings, cleanExpiryConfig, EXPIRY_BUILT_IN } from "./expiry.js";

const KEYS = ["access", "createYourOwn", "identity", "expiry", "signup", "links", "brand", "keys", "demo"];
// ---- Workshop keys look like PREFIX-1234-5678. The prefix is yours (letters, up to 6).
export function cleanKeys(k) { if (!k || typeof k !== "object") return null; const p = String(k.prefix || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 6); return p ? { prefix: p } : null; }
function mergeKeys(c, f, s) { let cur = { prefix: "SO" }, source = "built-in"; for (const [layer, label] of [[c, "YourBots/config.js"], [f, "YourBots/settings.json"], [s, "saved (Settings screen)"]]) { const v = cleanKeys(layer); if (v) { cur = v; source = label; } } return { ...cur, source }; }

// ---- Who runs this site and what it's called: config.js ships a placeholder; Settings makes it yours.
export function cleanBrand(b) {
  if (!b || typeof b !== "object") return null;
  const owner = String(b.owner || "").trim().slice(0, 80), siteName = String(b.siteName || "").trim().slice(0, 80);
  return owner || siteName ? { owner, siteName } : null;
}
function mergeBrand(c, f, s) {
  let cur = { owner: String(c?.owner || ""), siteName: String(c?.siteName || "") }, source = "YourBots/config.js";
  for (const [layer, label] of [[f, "YourBots/settings.json"], [s, "saved (Settings screen)"]]) { const v = cleanBrand(layer); if (v) { cur = { owner: v.owner || cur.owner, siteName: v.siteName || cur.siteName }; source = label; } }
  return { ...cur, source };
}

// ---- Links the app hands out but the repo never carries (config.js → links is blank on purpose).
export function cleanLinks(l) {
  if (!l || typeof l !== "object") return null;
  const u = (v) => { v = String(v || "").trim().slice(0, 500); return /^https?:\/\//.test(v) ? v : ""; };
  return { code: u(l.code), checklist: u(l.checklist), prompts: u(l.prompts) };
}
function mergeLinks(c, f, s) {
  let cur = { code: "", checklist: "", prompts: "" }, source = "built-in";
  for (const [layer, label] of [[c, "YourBots/config.js"], [f, "YourBots/settings.json"], [s, "saved (Settings screen)"]]) { const v = cleanLinks(layer); if (v && (v.code || v.checklist || v.prompts)) { cur = { code: v.code || cur.code, checklist: v.checklist || cur.checklist, prompts: v.prompts || cur.prompts }; source = label; } }
  return { ...cur, source };
}

// ---- The sign-up gate: what "email" mode asks for and stores. Same merge order.
export const SIGNUP_BUILT_IN = {
  title: "Try it, free", blurb: "",
  askName: "optional", askPhone: "off",
  marketing: { show: true, required: false, checked: false, text: "Email me news and the occasional offer. Unsubscribe any time." },
  sms: { show: false, required: false, checked: false, text: "Text me about this. Message rates may apply; reply STOP to end." },
  privacyLine: "We keep your email and a hashed record of your device and connection to spot abuse. Shared only with the tools we use to email or text you. Delete it any time.",
  webhook: "",
  blockThrowaway: true,          // refuse disposable-email domains at the gate
  checkMx: true,                 // refuse an email whose domain doesn't accept mail (a DNS lookup, 2 s, fails open)
};
const ASK = ["required", "optional", "off"];
const askOf = (v, d) => (ASK.includes(String(v || "")) ? String(v) : d);
const boxOf = (b, d) => (b && typeof b === "object" ? { show: b.show === undefined ? d.show : b.show !== false, required: Boolean(b.required), checked: Boolean(b.checked), text: String(b.text ?? d.text).slice(0, 300) } : d);
// Clean one layer. Returns null for "nothing here"; otherwise every field, defaults filled from `base`.
export function cleanSignup(s, base = SIGNUP_BUILT_IN) {
  if (!s || typeof s !== "object") return null;
  const url = String(s.webhook ?? base.webhook ?? "").trim().slice(0, 500);
  return {
    title: String(s.title ?? base.title).slice(0, 80), blurb: String(s.blurb ?? base.blurb).slice(0, 400),
    askName: askOf(s.askName, base.askName), askPhone: askOf(s.askPhone, base.askPhone),
    marketing: boxOf(s.marketing, base.marketing), sms: boxOf(s.sms, base.sms),
    privacyLine: String(s.privacyLine ?? base.privacyLine).slice(0, 400),
    webhook: /^https?:\/\//.test(url) ? url : "",
    blockThrowaway: s.blockThrowaway === undefined ? base.blockThrowaway : Boolean(s.blockThrowaway),
    checkMx: s.checkMx === undefined ? base.checkMx : Boolean(s.checkMx),
  };
}
function mergeSignup(c, f, s) {
  let cur = SIGNUP_BUILT_IN, source = "built-in";
  for (const [layer, label] of [[c, "YourBots/config.js"], [f, "YourBots/settings.json"], [s, "saved (Settings screen)"]]) { const v = cleanSignup(layer, cur); if (v) { cur = v; source = label; } }
  return { ...cur, source };
}
// What a visitor's page may know: the fields and the words, never the webhook.
export function publicSignup(su) { const { webhook, source, ...pub } = su || SIGNUP_BUILT_IN; return pub; }
let CACHE = { at: 0, rows: null };

async function readRows(env) {
  if (!env.DB) return null;
  if (Date.now() - CACHE.at < 10000) return CACHE.rows;
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT)`).run();
    const rows = {};
    for (const r of (await env.DB.prepare(`SELECT key, json FROM settings`).all()).results || []) { if (KEYS.includes(r.key)) { try { rows[r.key] = JSON.parse(r.json); } catch {} } }
    CACHE = { at: Date.now(), rows };
  } catch (err) { console.error("settings read failed (keeping the last known)", err?.message || err); }
  return CACHE.rows;
}

// The one reader. Returns:
//   { default, floor, source: { default, floor } }   (the access shape every gate already uses)
//   + createYourOwn: { show, text, url, source }
// What ships in the box: the guided tour, and the sample bots. Config, then the file,
// then the saved row — later wins, same as every other setting. Both default ON so a
// fresh button-deploy has something to click the moment it comes up.
// What the page may save: only the two switches, only real booleans. Anything else is dropped.
export function cleanDemo(d) {
  if (!d || typeof d !== "object") return null;
  const out = {};
  if (typeof d.tour === "boolean") out.tour = d.tour;
  if (typeof d.bots === "boolean") out.bots = d.bots;
  return Object.keys(out).length ? out : null;
}
export function mergeDemo(c, f, row) {
  const pick = (...vals) => { for (const v of vals) if (typeof v === "boolean") return v; return true; };
  return {
    tour: pick(row?.tour, f?.tour, c?.tour),
    bots: pick(row?.bots, f?.bots, c?.bots),
  };
}

export async function getSettings(env) {
  const rows = (await readRows(env)) || {};
  const access = accessSettings(CONFIG, SETTINGS_FILE, rows.access ? { access: rows.access } : null);
  const badge = mergeBadge(CONFIG.createYourOwn, SETTINGS_FILE?.createYourOwn, rows.createYourOwn);
  const identity = mergeIdentity(CONFIG.identity, SETTINGS_FILE?.identity, rows.identity);
  const expiry = expirySettings(CONFIG, SETTINGS_FILE, rows.expiry ? { expiry: rows.expiry } : null);
  const signup = mergeSignup(CONFIG.signup, SETTINGS_FILE?.signup, rows.signup);
  const links = mergeLinks(CONFIG.links, SETTINGS_FILE?.links, rows.links);
  const brand = mergeBrand({ owner: CONFIG.owner, siteName: CONFIG.siteName }, SETTINGS_FILE?.brand, rows.brand);
  const keys = mergeKeys(CONFIG.keys, SETTINGS_FILE?.keys, rows.keys);
  const demo = mergeDemo(CONFIG.demo, SETTINGS_FILE?.demo, rows.demo);
  return { ...access, createYourOwn: badge, identity, expiry, signup, links, brand, keys, demo };
}
// identity.graceMinutes: the return window, in minutes. 0 = off. Same three places, later wins.
const graceOf = (i) => (i && typeof i === "object" && i.graceMinutes !== undefined && i.graceMinutes !== null && i.graceMinutes !== "" && Number.isFinite(Number(i.graceMinutes)) && Number(i.graceMinutes) >= -1 ? cleanGrace(i.graceMinutes) : null);
function mergeIdentity(c, f, s) {
  const pick = [graceOf(s), graceOf(f), graceOf(c)].find((v) => v !== null);
  const source = graceOf(s) !== null ? "saved (Settings screen)" : graceOf(f) !== null ? "YourBots/settings.json" : graceOf(c) !== null ? "YourBots/config.js" : "built-in";
  return { graceMinutes: pick === undefined ? DEFAULT_GRACE_MINUTES : pick, source };
}
export function cleanBadge(b) {
  if (!b || typeof b !== "object") return null;
  const url = String(b.url || "").trim().slice(0, 500);
  return { show: b.show !== false, text: String(b.text || "").slice(0, 80), url: /^https?:\/\//.test(url) ? url : "" };
}
function mergeBadge(c, f, s) {
  const pick = [cleanBadge(s), cleanBadge(f), cleanBadge(c)].find(Boolean);
  const source = cleanBadge(s) ? "saved (Settings screen)" : cleanBadge(f) ? "YourBots/settings.json" : cleanBadge(c) ? "YourBots/config.js" : "built-in";
  return { show: pick ? pick.show : true, text: pick?.text || "Create your own bot", url: pick?.url || "", source };
}

// The Settings screen's Save: one row per key, live within 10 s everywhere.
export async function saveSettings(env, { access, createYourOwn, identity, expiry, signup, links, brand, keys, demo } = {}) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT)`).run();
  const put = (key, obj) => env.DB.prepare(`INSERT INTO settings (key, json, updated_at, updated_by) VALUES (?, ?, ?, 'admin') ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`).bind(key, JSON.stringify(obj), new Date().toISOString());
  const ops = [];
  if (access) ops.push(put("access", { default: access.default, floor: access.floor }));
  if (createYourOwn) ops.push(put("createYourOwn", cleanBadge(createYourOwn)));
  if (identity && graceOf(identity) !== null) ops.push(put("identity", { graceMinutes: graceOf(identity) }));
  if (expiry && cleanExpiryConfig(expiry)) ops.push(put("expiry", cleanExpiryConfig(expiry)));
  if (signup && cleanSignup(signup)) ops.push(put("signup", cleanSignup(signup)));
  if (links && cleanLinks(links)) ops.push(put("links", cleanLinks(links)));
  if (brand && cleanBrand(brand)) ops.push(put("brand", cleanBrand(brand)));
  if (keys && cleanKeys(keys)) ops.push(put("keys", cleanKeys(keys)));
  if (demo && cleanDemo(demo)) ops.push(put("demo", cleanDemo(demo)));
  if (ops.length) await env.DB.batch(ops);
  CACHE = { at: 0, rows: null };
}

// What Settings → Commit to GitHub writes: the file half of the merge, as JSON.
export function settingsFileContent(s) {
  const e = s.expiry || EXPIRY_BUILT_IN;
  const { source, ...su } = s.signup || SIGNUP_BUILT_IN;
  return JSON.stringify({ access: { default: s.default, floor: s.floor }, createYourOwn: { show: s.createYourOwn.show, text: s.createYourOwn.text, url: s.createYourOwn.url }, identity: { graceMinutes: s.identity?.graceMinutes ?? DEFAULT_GRACE_MINUTES }, expiry: { onLapse: e.onLapse, graceDays: e.graceDays, warnDays: e.warnDays, defaultDays: e.defaultDays }, signup: su, demo: { tour: s.demo?.tour !== false, bots: s.demo?.bots !== false } }, null, 2) + "\n";
}
export const SETTINGS_FILE_VIEW = SETTINGS_FILE;
