// ============================================================================
//  WHO CAN USE IT. One gate, used by every door a visitor can knock on
//  (/api/chat, /api/attach, /api/transcribe, /api/speak, /api/handoff*, and
//  /api/config so the page knows which lock screen to show).
//
//  Three layers, each in plain words:
//    1. The bot says what it wants   project.json → "access": "open" | "email" | "allow" | "key"
//                                     | "key+email" | "admin" | "draft"   (omit = the default)
//    2. The deployment sets a default and a floor   YourBots/config.js → access.default / access.floor
//                                     (YourBots/settings.json and the Settings screen override it)
//    3. The floor wins when it is stricter.  Order, most open first:
//                                     open < email < allow < key < key+email < admin < draft
//       So floor "key" makes every bot need the passphrase, even one that says "open".
//       That is the panic switch: one setting, every bot locked, no code change.
//
//  This file FAILS CLOSED. Anything that goes wrong inside the gate is a 401,
//  never an open door. (Features elsewhere fail open on purpose; access doesn't.)
//
//  What none of this is: sign-in. "key" is one shared passphrase. "email" is the visitor's
//  email tied to THIS browser through Engine/identity/ (email + device key, like Plate):
//  nobody checks the address is theirs, but a second browser can't just type it — the
//  owner links it with a code. The chat handler finds the email (visitorOf in index.js)
//  and passes it here; the gate only asks "is there one?".
//  "allow" is email PLUS a list: the visitor is identified the same way, and then
//  their address has to be on this bot's allowlist (or the deployment-wide one).
//  In the list → able to do things. Not in it → 403. The list is encrypted at rest
//  (Engine/worker/allowlist.js); no ALLOWLIST_KEY secret = nobody is on it = closed.
// ============================================================================

import { isAllowed, blindFor } from "./allowlist.js";
import { resolve as resolveExpiry, expiryFor, lapseReply, noticeFor } from "./expiry.js";

export const ACCESS_MODES = ["open", "email", "allow", "key", "key+email", "admin", "draft"];
const RANK = { open: 0, email: 1, allow: 2, key: 3, "key+email": 4, admin: 5, draft: 6 };

// One line per mode — the Settings screen and the Configure form show these.
export const MODE_LINES = {
  open: "Anyone with the link. For a public website bot (rely on the rate limit and a spend cap).",
  email: "Visitors type an email address once; this browser is then remembered (Engine/identity, the same as Plate). A second browser waits for the owner to link it. Feeds Leads.",
  allow: "Email, and the address must be on the allowlist (Settings → Allowlist: this bot's list or the one for every bot). Invited people only. Needs the ALLOWLIST_KEY secret.",
  key: "The shared passphrase (the ACCESS_PASSPHRASE secret). Demos, internal bots.",
  "key+email": "Both: the passphrase to get in, then an email so you know who asked.",
  admin: "Only the admin code opens it. For bots only you should talk to.",
  draft: "Nobody but the Configure preview. Chat page, widget and API all refuse. Publish to open it.",
};

// A mode string from anywhere (a file, the database, a form) → a valid mode, or the fallback.
export function cleanMode(m, fallback = "") {
  const s = String(m || "").trim().toLowerCase();
  return ACCESS_MODES.includes(s) ? s : fallback;
}

// The stricter of two modes.
export function stricter(a, b) {
  return (RANK[a] ?? 0) >= (RANK[b] ?? 0) ? a : b;
}

// --- The deployment's default and floor. Three places, later wins:
//     YourBots/config.js → access  (mode is the old name for default; still read)
//     YourBots/settings.json → access  (what Settings → Commit to GitHub writes)
//     the D1 settings row "access"     (what Settings → Save writes; live at once)
export function accessSettings(config, fileSettings, savedRow) {
  const c = config?.access || {};
  const f = fileSettings?.access || {};
  const s = savedRow?.access || {};
  const dflt = cleanMode(s.default) || cleanMode(f.default) || cleanMode(c.default) || cleanMode(c.mode) || "key";
  const floor = cleanMode(s.floor) || cleanMode(f.floor) || cleanMode(c.floor) || "open";
  const from = (k) => (cleanMode(s[k]) ? "saved (Settings screen)" : cleanMode(f[k]) ? "YourBots/settings.json" : cleanMode(c[k]) || (k === "default" && cleanMode(c.mode)) ? "YourBots/config.js" : "built-in");
  return { default: dflt, floor, source: { default: from("default"), floor: from("floor") } };
}

// --- The per-bot secret name. Only ACCESS_PASSPHRASE_<SOMETHING> is ever honoured,
//     so a bot can never point at an arbitrary secret (GITHUB_TOKEN, say).
const KEY_NAME = /^ACCESS_PASSPHRASE_[A-Z0-9_]+$/;
export function cleanKeyName(name) {
  const s = String(name || "").trim();
  return KEY_NAME.test(s) ? s : "";
}

// --- What a bot actually requires, and why. --------------------------------
//     { mode, botMode, listed, keyName, reason }
//     reason reads like: "bot says open, floor says key → key"
export function effectiveAccess(project, settings) {
  const p = project || {};
  const s = settings || { default: "key", floor: "open" };
  const botMode = cleanMode(p.access);                     // "" = not set → the default
  const asked = botMode || s.default;
  const mode = stricter(asked, s.floor);
  const listed = p.listed !== false;
  const keyName = cleanKeyName(p.accessKey);
  const said = botMode ? `bot says ${botMode}` : `bot doesn't say (default ${s.default})`;
  const reason = mode !== asked ? `${said}, floor says ${s.floor} → ${mode}` : s.floor !== "open" ? `${said}, floor ${s.floor} doesn't change it → ${mode}` : `${said} → ${mode}`;
  return { mode, botMode, listed, keyName, reason, wantKey: /key/.test(mode), wantEmail: /email/.test(mode) || mode === "allow", wantList: mode === "allow" };
}

// --- The key a bot is opened with: which secret, and the token that secret makes.
//     A per-bot secret that isn't set falls back to the shared one. No shared
//     secret either = the door was never installed: runs open, says so in the logs
//     (that is the documented behaviour for a fresh deploy with access "key").
export function keyFor(env, project) {
  const own = cleanKeyName(project?.accessKey);
  if (own && env[own]) return { name: own, secret: String(env[own]), shared: false };
  if (own && !env[own]) console.warn(`bot "${project?.id}" names the secret ${own} but it isn't set — using the shared ACCESS_PASSPHRASE`);
  if (env.ACCESS_PASSPHRASE) return { name: "ACCESS_PASSPHRASE", secret: String(env.ACCESS_PASSPHRASE), shared: true };
  return { name: "ACCESS_PASSPHRASE", secret: "", shared: true };
}

// A token derived from a passphrase, never the passphrase itself. The label
// carries the secret's NAME for per-bot keys, so a token minted for client X
// can never open client Y even if the two passphrases happen to match.
export async function accessToken(secret, label = "bot-you-own/access/v1") {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(secret || "")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(label));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const keyLabel = (name) => (name === "ACCESS_PASSPHRASE" ? "bot-you-own/access/v1" : `bot-you-own/access/v1/${name}`);
export async function tokenFor(env, project) {
  const k = keyFor(env, project);
  return { ...k, token: k.secret ? await accessToken(k.secret, keyLabel(k.name)) : null };
}

export function safeEqual(a, b) {
  a = String(a || ""); b = String(b || "");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const EMAIL_SHAPE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
export const cleanEmail = (e) => { const s = String(e || "").trim().toLowerCase().slice(0, 254); return EMAIL_SHAPE.test(s) ? s : ""; };

// --- THE GATE. ---------------------------------------------------------------
//   gate(request, env, project, settings, { isAdmin, draftPreview, email })
//     → { ok: true,  mode, wantEmail, who }
//     → { ok: false, status, error, reply, mode, wantKey, wantEmail, needAdmin }
//   isAdmin      the request carried a valid admin token (checked by the caller)
//   draftPreview the Configure preview (admin + body.draft) — the only way into a draft bot
//   email        the visitor's email from the body; pass undefined on a route that
//                can't carry one (the mic, the speaker) and the email step is skipped
//                there — /api/chat is where it matters, and it always checks.
export async function gate(request, env, project, settings, { isAdmin = false, draftPreview = false, email } = {}) {
  try {
    const a = effectiveAccess(project, settings);
    const base = { mode: a.mode, wantKey: a.wantKey, wantEmail: a.wantEmail };
    const who = cleanEmail(email) || (isAdmin ? "admin" : "");

    // draft: only the Configure preview, and only with the admin code.
    if (a.mode === "draft") {
      if (isAdmin && draftPreview) return { ok: true, ...base, who };
      return { ok: false, status: 403, error: "draft", reply: "This bot is a draft. It only answers in the Configure preview — publish it to open it up.", ...base, needAdmin: true };
    }
    // admin: the admin token, nothing else.
    if (a.mode === "admin") {
      if (isAdmin) return { ok: true, ...base, who };
      return { ok: false, status: 401, error: "admin", reply: "This bot is for the owner only. Enter the admin code to continue.", ...base, needAdmin: true };
    }
    // key / key+email: the bot's key (its own secret, or the shared one). An admin
    // token counts as a visitor token, as it always has.
    if (a.wantKey && !isAdmin) {
      const k = await tokenFor(env, project);
      if (k.token) {
        const given = request.headers.get("x-access-token") || "";
        if (!safeEqual(given, k.token)) return { ok: false, status: 401, error: "locked", reply: "This bot is locked. Enter the passphrase to continue.", ...base };
      } else {
        console.warn(`bot "${project?.id}" wants a key but no ACCESS_PASSPHRASE is set — running open`);
      }
    }
    // email / allow / key+email: an address before chatting. Identification, not authentication.
    if (a.wantEmail && !isAdmin && email !== undefined && !cleanEmail(email)) {
      return { ok: false, status: 401, error: "email", reply: "Please enter your email address to start.", ...base };
    }
    // allow: identified, AND on the list. This bot's list or the deployment-wide one ("*").
    // No key, a broken lookup, an address that isn't there: all the same closed door.
    let hmac = "";
    if (a.wantList && !isAdmin && email !== undefined) {
      const r = await isAllowed(env, project?.id, cleanEmail(email));
      if (!r.ok) return { ok: false, status: 403, error: "allow", reply: r.reason || `${cleanEmail(email)} isn't on the list for ${project?.name || "this bot"}. Ask the owner to add it.`, ...base, list: true };
      hmac = r.hmac || "";
    }

    // --- IS IT STILL IN DATE? (Engine/worker/expiry.js) --------------------------
    // The door has already said yes by this point. This asks the second question:
    // has the person's window, their invitation, or the key they used run out?
    // The admin is never time-boxed — the owner locking themselves out of their own
    // bot would be a bug, not a feature. Everything here fails OPEN: a lookup that
    // breaks contributes no date, so a database hiccup can't lock out a paying client.
    if (!isAdmin) {
      const cfg = expiryFor(project, settings);
      const who2 = cleanEmail(email);
      if (!hmac && a.wantList && who2) hmac = await blindFor(env, who2);
      // The key's date only counts for a bot that actually opens with a key — a date
      // on the shared ACCESS_PASSPHRASE must not quietly time-box an "open" or plain
      // "email" bot that never asks for it.
      const keyName = a.wantKey ? keyFor(env, project).name : "";
      const exp = await resolveExpiry(env, { bot: project?.id, email: who2, emailHmac: hmac, keyName }, cfg);
      if (exp.state === "lapsed") {
        // "readonly" is not a refusal — it is a yes with the composer off. The caller
        // (handleChat) turns readOnly into "you can read, you can't send"; a route that
        // ignores the flag simply keeps working, which is the right failure direction.
        if (exp.onLapse === "readonly") return { ok: true, ...base, who, expiry: exp, readOnly: true, notice: lapseReply(exp, project) };
        return { ok: false, status: 403, error: "expired", reply: lapseReply(exp, project), ...base, expiry: exp };
      }
      if (exp.state === "warn" || exp.state === "grace") return { ok: true, ...base, who, expiry: exp, notice: noticeFor(exp) };
      return { ok: true, ...base, who, expiry: exp };
    }
    return { ok: true, ...base, who };
  } catch (err) {
    // Fail CLOSED: a broken check locks, it never opens.
    console.error("access gate failed — refusing", err?.message || err);
    return { ok: false, status: 401, error: "locked", reply: "This bot is locked. Enter the passphrase to continue.", mode: "key", wantKey: true, wantEmail: false };
  }
}

// What /api/config tells the page about a bot (never the secret's name — just whether it has its own).
export function accessView(project, settings) {
  const a = effectiveAccess(project, settings);
  return { mode: a.mode, key: a.wantKey, email: a.wantEmail, list: a.wantList, admin: a.mode === "admin", draft: a.mode === "draft", ownKey: Boolean(a.keyName), listed: a.listed };
}
