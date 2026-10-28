import { CONFIG } from "../../YourBots/config.js";
import { normaliseProject, normaliseWebsite, savedProjects, saveProject, deleteSavedProject, inFolder, resolveProject, resolveList, pickPublic, hrefFor, exportFiles, KINDS, KIND_LABELS, cleanKind } from "./projects.js";
import { getSettings, saveSettings, settingsFileContent, cleanBadge, cleanSignup, publicSignup, cleanLinks, cleanBrand, cleanKeys, cleanDemo, SETTINGS_FILE_VIEW as SETTINGS_FILE } from "./settings.js";
// The GitHub repo this deploys from: the GITHUB_REPO secret first, config.js second (blank in the template on purpose).
const repoOf = (env) => String(env?.GITHUB_REPO || CONFIG.github?.repo || "").trim();
import { listSignups, signupsCsv } from "./signups.js";
import { tourState, listCodes, codeUses, createCode, disableCode } from "./tour.js";
import { handleSandbox, sandboxOwnerOf, visibleSandboxes } from "./sandbox.js";
import { PROJECTS as FOLDER_PROJECTS } from "../../YourBots/index.js";
// Does this site have a guide bot (and so workshop keys)? Decides whether the gate shows the key field.
const HAS_GUIDE = Object.values(FOLDER_PROJECTS).some((p) => p && p.tour);
import { handleIdentity, identify, linkByCode, signInMethods, adminNeedsCode, adminCodeOk, graceMinutesFor } from "../identity/index.js";
import { ensureIdentitySchema, userByEmail as idUserByEmail, listPending as idListPending } from "../identity/devices.js";
import { listThreads, putThread, renameThread, deleteThread, usersWithHistory, ensureChatSchema } from "./chats.js";
import { addToList, removeFromList, listFor as allowlistFor, listCounts as allowlistCounts, hasKey as allowlistKeySet, isAllowed, blindFor, GLOBAL_SCOPE, createInvite, listInvites, disableInvite } from "./allowlist.js";
import { ensureExpirySchema, cleanUntil, asDateInput, setPersonUntil, setKeyUntil, keyRows, timelineFor, datedPeople, resolve as resolveExpiry, expiryFor, stateOf, noticeFor, LAPSE_MODES, LAPSE_LINES, cleanExpiryConfig, EXPIRY_BUILT_IN } from "./expiry.js";
import { buildSystemPrompt, PROMPT_FILES, ROOT_PROMPT_FILES } from "./prompt.js";
import { complete, gatewayStatus } from "./gateway.js";
import { classifyTurn, recordRoute, routingStats } from "./router.js";
import { recordUsage, usageReport } from "./usage.js";
import { isAllowanceError } from "./gateway.js";
import { screenInbound, screenOutbound, ensureHandoff, stripHandoffMarker, llamaGuard, redact, INJECTION_PATTERNS, SECRET_PATTERNS, LLAMA_GUARD_MODEL } from "./firewall.js";
import { detectLanguage, chooseLanguage, languageSettings } from "./language.js";
import { MODES } from "./modes.js";
import { retrieve, uploadFile, listFiles, deleteFile, downloadFile, rescanLibrary, extractText, libraryMeta, allExtensions, gate, safeName, scanText, websiteOf, crawlWebsite, websiteStatus, deleteWebsite } from "./library.js";
import { oneQuestion, normaliseHandoffActions, stripIntakeMarker, handoffEvent, runHandoffActions, handoffActionsView } from "./handoff.js";
import { listLeads, getLead, summariseLead, sendLead, maybeAutoLead, leadsConfig, cleanVisitor } from "./leads.js";
import { listGaps, getGap, setGapState, draftGap } from "./gaps.js";
import { normaliseBooking, bookingLive, bookingStep, bookingView } from "./booking.js";
import { handleTrack } from "./track.js";
import { listTextModels, isPickable, seesImages, CHAT_BOT } from "./models.js";
import { isHandoffId, createHandoff, readHandoff, addHandoffMessage, closeHandoff, listHandoffs, getHandoff, notifyHumanRequested, PERSON_LIMITS } from "./person.js";
import { gate as accessGate, effectiveAccess, accessSettings, accessToken, safeEqual, tokenFor, keyFor, accessView, cleanMode, cleanKeyName, cleanEmail, ACCESS_MODES, MODE_LINES } from "./access.js";

// ============================================================================
//  THE WORKER. Four routes and a static folder.
//    GET  /api/config   → what the page needs to draw itself
//    POST /api/chat     → { project, messages, stream, attachments } → SSE stream (or JSON)
//    POST /api/attach   → multipart "file" → { ok, name, chars, text } (the paperclip;
//                         nothing is stored — the text goes back to the visitor's browser)
//    POST /api/transcribe → multipart "audio" → { text, language } (the mic: Whisper on Workers AI)
//    POST /api/speak    → { text } → audio bytes (the speaker: a Deepgram Aura voice on Workers AI)
//    GET  /health       → "ok"
//    *                  → public/ (the chat page, the widget)
//  Who can use each of those: Engine/worker/access.js (per-bot access, default + floor).
//    POST /api/unlock { passphrase, project } → { token } for that bot's key
//  History on any computer (identified visitors only — Engine/worker/chats.js):
//    GET /api/chats?bot= · PUT /api/chats/<id> · PATCH /api/chats/<id> · DELETE /api/chats/<id>?bot=
//    Admin, read-only ("see what they see"): GET /api/admin/chats/users?bot= · GET /api/admin/chats?bot=&email=
//  The allowlist (access mode "allow" — Engine/worker/allowlist.js), admin:
//    GET /api/admin/allowlist?scope=<bot|*> · POST {scope,email} · DELETE {scope,email}
//  Apps (bots of kind "food" — Engine/worker/projects.js): /apps/<id> · /api/apps/<id>/… ·
//    /api/admin/apps/<id>/… (Engine/worker/track.js). /food and /api/food/… still reach
//    the bot "plate" for one release. Identity for every kind: /api/id/* (Engine/identity/).
//  Admin (x-admin-token): /api/admin/engine, /audit, /projects, /project,
//    GET/PUT /api/admin/settings (default + floor) · POST /api/admin/settings/sync (→ YourBots/settings.json)
//    GET /api/admin/events?limit=100   every admin write, newest first (ip hashed, never stored)
//    /api/admin/library?project=<id>  GET list · POST upload (multipart "file",
//    optional "override") · DELETE /api/admin/library/<itemId>?project=<id>
//    POST /api/admin/library/rescan?project=<id>   re-check every document (read-only)
//    GET  /api/admin/library/audit?project=<id|*>  what the scan did, newest first
//    /api/admin/library/crawl?project=<id>  GET status of the bot's website
//    crawl · POST crawl it now (creates the crawler instance the first time) ·
//    DELETE remove the crawler instance and its pages
//    GET  /api/admin/gaps?project=<id>&days=30&limit=20   what the bot couldn't answer, as a to-do list
//    POST /api/admin/gaps/<id>/draft · /accept · /dismiss · /reopen   (Engine/worker/gaps.js)
//  Talk to a person (same door as /api/chat; Engine/worker/person.js):
//    POST /api/handoff                    → { id }   the visitor asks for a human
//    GET  /api/handoff/<id>?since=<msgId> → status + the owner's new messages (the page polls)
//    POST /api/handoff/<id>/message       → the visitor's reply into the thread
//  Admin: GET /api/admin/handoffs?project=<id|*>&status=open|waiting|closed|all
//    GET /api/admin/handoff/<id> · POST /api/admin/handoff/<id>/reply · POST …/close
// ============================================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health") { const v = await versionStamp(env); return new Response(`ok ${v.version} ${v.commit} ${v.builtAt}`.trim()); }

    // --- THE ADMIN CODE. A second secret, ADMIN_PASSPHRASE, opens "Under the
    //     hood": the exact prompt, the files, the firewall rules, the source.
    //     Visitors never see it. An admin token also counts as a visitor token.
    //     The token carries a version (ADMIN_TOKEN_VERSION, default 1): bump the
    //     secret and every admin is logged out, no code change. docs/DEPLOY.md §B3.
    const adminEnabled = Boolean(env.ADMIN_PASSPHRASE);
    const adminToken = adminEnabled ? await accessToken(env.ADMIN_PASSPHRASE, adminLabel(env)) : null;
    const isAdmin = adminEnabled && safeEqual(request.headers.get("x-admin-token") || "", adminToken);

    // --- WHO CAN USE IT. Per bot, not per deployment: each bot's project.json
    //     says open | email | key | key+email | admin | draft (or nothing = the
    //     default), and the deployment's floor can only make it stricter.
    //     Engine/worker/access.js is the one gate every visitor route goes through.
    //     `settings` = the default and the floor (config.js < settings.json < the
    //     Settings screen). `guard(project)` = is THIS request allowed in?
    const settings = await getSettings(env);
    const guard = async (project, opts = {}) => {
      // A sandbox bot answers to its owner (this browser's identity, on any bot) and the admin. Nobody else.
      if (project?.sandbox && !isAdmin) {
        const owner = await sandboxOwnerOf(env, request);
        if (!owner || owner !== project.sandbox.email) return { ok: false, error: "sandbox", reply: "That bot belongs to someone else." };
        if (project.sandbox.expires_at && project.sandbox.expires_at < new Date().toISOString()) return { ok: false, error: "sandbox", reply: "That sandbox bot has expired." };
        return { ok: true, mode: "open", wantKey: false, wantEmail: false };
      }
      return accessGate(request, env, project, settings, { isAdmin, ...opts });
    };
    // Email mode for a CHAT bot: WHO the visitor is comes from the device identity
    // (Engine/identity/ — the same email + device key Plate uses), never from a field
    // in the request body. An unknown browser gives "" and the gate answers 401 "email";
    // the page then offers the join screen. Anything that breaks here also gives "":
    // identity fails closed. Leads, the audit log and handoffs all key on this email.
    const visitorOf = async (project) => {
      try {
        if (isAdmin) return "";                                                   // the admin is "admin" to the gate
        const a = effectiveAccess(project, settings);
        if (!a.wantEmail || cleanKind(project.kind) !== "chat" || !env.DB) return "";
        const who = await identify(request, env, project);
        return who.user ? who.user.email : "";
      } catch (err) { console.error("identity lookup failed — treating the visitor as unknown", err?.message || err); return ""; }
    };

    if (url.pathname === "/api/admin/unlock") {
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      if (!adminEnabled) return json({ error: "no admin code is set" }, 404);
      if (!(await allowed(env, request)) || !(await unlockAllowed(env, request))) return json({ error: "too many attempts" }, 429);
      const { body: b, error } = await readJson(request, { max: 8 * 1024, strict: false }); if (error) return error;
      // THE BREAK-GLASS KEY. ADMIN_UNLOCK_KEY typed where the admin code goes opens the door
      // on its own: no passphrase check, no authenticator code — even when ADMIN_TOTP_SECRET
      // is set, lost or wrong. It exists so the owner can always get back to Settings and
      // re-set the second factor. Every use is written to admin_events. docs/DEPLOY.md → B3d.
      if (breakGlassKey(env)) {
        const want = await accessToken(breakGlassKey(env), "bot-you-own/admin/break-glass");
        const got = await accessToken(String(b.passphrase || ""), "bot-you-own/admin/break-glass");
        if (safeEqual(got, want)) {
          await logAdminEvent(env, request, "admin-break-glass", "ADMIN_UNLOCK_KEY", `the break-glass key opened the admin door${adminNeedsCode(env) ? " (the authenticator step was skipped)" : ""} — re-set ADMIN_TOTP_SECRET / bump ADMIN_TOKEN_VERSION if this wasn't you`);
          return json({ token: adminToken, breakGlass: true, note: "You are in with the break-glass key. Go to Under the hood → Settings and re-set the admin second factor (docs/DEPLOY.md → B3d)." });
        }
      }
      const given = await accessToken(String(b.passphrase || ""), adminLabel(env));
      if (!safeEqual(given, adminToken)) return json({ error: "wrong admin code", needsCode: adminNeedsCode(env) }, 401);
      // The optional second factor: ADMIN_TOTP_SECRET set → the six digits from the owner's authenticator app, too.
      if (adminNeedsCode(env) && !(await adminCodeOk(env, b.code))) return json({ error: b.code ? "wrong code" : "code required", needsCode: true, reply: "This deployment asks for the authenticator code as well (docs/IDENTITY.md)." }, 401);
      return json({ token: adminToken });
    }
    if (url.pathname === "/api/admin/unlock/needs") return json({ needsCode: adminNeedsCode(env), adminEnabled });

    // --- APPS: a bot of kind "food" answers at /apps/<id> (Engine/worker/track.js). A bot that
    //     isn't that kind, or doesn't exist, is a 404. /food, /api/food/*, /api/admin/food/* are
    //     aliases for the bot "plate" for one release (docs/FOOD-LOG.md).
    const app = url.pathname.match(/^\/(apps|api\/apps|api\/admin\/apps)\/([a-z0-9-]{1,40})(?=\/|$)/) || (/^\/(food|api\/food|api\/admin\/food)(?=\/|$)/.test(url.pathname) ? { alias: true } : null);
    if (app) {
      const id = app.alias ? "plate" : app[2];
      const bot = await resolveProject(env, id);
      if (bot.id !== id || bot.kind === "chat") return url.pathname.startsWith("/api/") ? json({ error: "not found" }, 404) : new Response("Not found", { status: 404 });
      const paths = app.alias ? { page: "/food", api: "/api/food/", admin: "/api/admin/food/" } : { page: `/apps/${id}`, api: `/api/apps/${id}/`, admin: `/api/admin/apps/${id}/` };
      if (bot.kind === "food") return handleTrack(request, env, url, { ctx, bot, ...paths, isAdmin, adminEnabled, allowed, graceMinutes: graceMinutesFor(bot, settings.identity?.graceMinutes), expiry: expiryFor(bot, settings) });
      return json({ error: "not found" }, 404);
    }
    // --- IDENTITY, shared by every kind: passkeys and authenticator codes (Engine/identity/index.js).
    if (url.pathname.startsWith("/api/id/")) {
      const bid = String(url.searchParams.get("bot") || (request.method === "POST" ? (await request.clone().json().catch(() => ({})))?.bot : "") || "").toLowerCase();
      const bot = await resolveProject(env, bid);
      if (!bid || bot.id !== bid) return json({ error: "which bot? send { bot }" }, 400);
      return handleIdentity(request, env, url, { bot, allowed, unlockAllowed, graceMinutes: graceMinutesFor(bot, settings.identity?.graceMinutes), signup: settings.signup });
    }

    // A keyed visitor's own bots: paste a GPT, pick a licensed prompt, add files, chat, take it with you.
    if (url.pathname === "/api/sandbox" || url.pathname.startsWith("/api/sandbox/")) {
      return handleSandbox(request, env, url, { isAdmin, allowed, settings, resolveProject, guard });
    }

    // The tour strip: where this visitor is, and whether deploy is open to them (Engine/worker/tour.js).
    if (url.pathname === "/api/tour") {
      const bid = String(url.searchParams.get("bot") || (request.method === "POST" ? (await request.clone().json().catch(() => ({})))?.bot : "") || "").toLowerCase();
      const guide = await resolveProject(env, bid);
      if (!bid || guide.id !== bid || !guide.tour) return json({ error: "which guide? send { bot }" }, 400);
      let stop = "", code = "", reset = false;
      if (request.method === "POST") { if (!(await allowed(env, request))) return json({ error: "rate-limited" }, 429); const b = (await request.clone().json().catch(() => ({}))) || {}; stop = String(b.stop || "").slice(0, 20); code = String(b.code || "").slice(0, 20); reset = b.reset === true; }
      return json(await tourState(env, request, guide, { stop, code, reset, links: settings.links }));
    }

    if (url.pathname.startsWith("/api/admin/") || url.pathname.startsWith("/engine/")) {
      if (!isAdmin) return json({ error: "admin only" }, adminEnabled ? 401 : 404);
      if (url.pathname === "/api/admin/engine") return json(await engineView(env, url.searchParams.get("project")));
      if (url.pathname === "/api/admin/audit") return json(await auditView(env, url.searchParams));
      if (url.pathname === "/api/admin/library" || url.pathname.startsWith("/api/admin/library/")) return handleLibrary(request, env, url);
      if (url.pathname === "/api/admin/leads" || url.pathname.startsWith("/api/admin/leads/")) return handleLeads(request, env, url);
      if (url.pathname === "/api/admin/signups") return json(await listSignups(env, { project: String(url.searchParams.get("project") || "*").toLowerCase(), limit: url.searchParams.get("limit") }));
      // Deploy codes (Engine/worker/tour.js): make, list, disable; every use is logged with who.
      if (url.pathname === "/api/admin/deploy-codes") {
        if (request.method === "GET") return json({ codes: await listCodes(env) });
        if (request.method !== "POST") return json({ error: "POST only" }, 405);
        if (!env.DB) return json({ error: "Deploy codes need the D1 database." }, 400);
        const { body: b, error } = await readJson(request); if (error) return error;
        const code = await createCode(env, { issuedTo: b?.issuedTo, note: b?.note, maxUses: b?.maxUses, prefix: settings.keys?.prefix });
        await logAdminEvent(env, request, "deploy-code-make", code, `for ${String(b?.issuedTo || "").slice(0, 80) || "(unnamed)"}`, String(b?.issuedTo || "").slice(0, 120));
        return json({ ok: true, code });
      }
      const dc = url.pathname.match(/^\/api\/admin\/deploy-codes\/([A-Za-z0-9-]{4,20})\/(disable|enable|uses)$/);
      if (dc) {
        if (dc[2] === "uses") return json({ uses: await codeUses(env, dc[1]) });
        if (request.method !== "POST") return json({ error: "POST only" }, 405);
        await disableCode(env, dc[1], dc[2] === "disable");
        await logAdminEvent(env, request, "deploy-code-" + dc[2], dc[1].toUpperCase(), "");
        return json({ ok: true });
      }
      if (url.pathname === "/api/admin/signups.csv") { await logAdminEvent(env, request, "signups-export", String(url.searchParams.get("project") || "*"), "CSV download"); return signupsCsv(env, { project: String(url.searchParams.get("project") || "*").toLowerCase() }); }
      // The owner links a visitor's second browser: the visitor reads out the 6-character
      // code their screen shows, the owner types it here with the email. Both must match.
      if (url.pathname === "/api/admin/id/pending") { if (!env.DB) return json({ pending: [] }); await ensureIdentitySchema(env); return json({ pending: await idListPending(env) }); }
      if (url.pathname === "/api/admin/id/link") {
        if (request.method !== "POST") return json({ error: "POST only" }, 405);
        if (!env.DB) return json({ error: "Identity needs the D1 database (wrangler.jsonc → d1_databases)." }, 503);
        const { body: b, error } = await readJson(request, { max: 8 * 1024, strict: false }); if (error) return error;
        const target = await resolveProject(env, String(b.bot || "").toLowerCase());
        const email = cleanEmail(b.email);
        if (!target.id || !email) return json({ error: "bot and email are required" }, 400);
        const r = await linkByCode(env, target.id, { email, code: b.code });
        if (r.ok) await logAdminEvent(env, request, "device-link", target.id, `linked a second device for ${email}`);
        return json(r, r.ok ? 200 : r.status || 400);
      }
      // The allowlist (access mode "allow"): per bot (scope = its id) or every bot (scope = "*").
      // GET lists it DECRYPTED — the owner can see who is on it. POST adds, DELETE removes. Engine/worker/allowlist.js.
      if (url.pathname === "/api/admin/allowlist") {
        if (!env.DB) return json({ error: "The allowlist needs the D1 database (wrangler.jsonc → d1_databases)." }, 503);
        if (request.method === "GET") { const r = await allowlistFor(env, url.searchParams.get("scope") || GLOBAL_SCOPE); return json({ ...r, counts: await allowlistCounts(env), keySet: allowlistKeySet(env) }, r.ok ? 200 : r.status || 400); }
        if (request.method !== "POST" && request.method !== "DELETE") return json({ error: "method" }, 405);
        const { body: b, error } = await readJson(request, { max: 8 * 1024 }); if (error) return error;
        const r = request.method === "POST" ? await addToList(env, b.scope, b.email, "admin", cleanUntil(b.until)) : await removeFromList(env, b.scope, b.email);
        if (r.ok) await logAdminEvent(env, request, request.method === "POST" ? (r.existed ? "access-extend" : "allowlist-add") : "allowlist-remove", r.scope === GLOBAL_SCOPE ? "every bot" : r.scope, `${r.email}${request.method === "POST" ? ` · invitation ${r.was ? String(r.was).slice(0, 10) : "unlimited"} → ${r.until ? String(r.until).slice(0, 10) : "unlimited"}` : ""}${request.method === "DELETE" && !r.removed ? " (wasn't on it)" : ""}`, r.email);
        return json(r, r.ok ? 200 : r.status || 400);
      }
      // Invite codes (allow mode): a ticket that puts whoever redeems it on the list, with a date.
      // GET ?scope=<bot|*> · POST {scope, until, note, maxUses} · DELETE {code, on} (disable, or re-enable with on:true).
      if (url.pathname === "/api/admin/invites") {
        if (!env.DB) return json({ error: "Invites need the D1 database (wrangler.jsonc → d1_databases)." }, 503);
        if (request.method === "GET") { const r = await listInvites(env, url.searchParams.get("scope") || GLOBAL_SCOPE); return json({ ...r, keySet: allowlistKeySet(env) }, r.ok ? 200 : r.status || 400); }
        if (request.method !== "POST" && request.method !== "DELETE") return json({ error: "method" }, 405);
        const { body: b, error } = await readJson(request, { max: 8 * 1024 }); if (error) return error;
        const r = request.method === "POST" ? await createInvite(env, { scope: b.scope, until: cleanUntil(b.until), note: b.note, maxUses: b.maxUses, who: "admin" }) : await disableInvite(env, b.code, b.on === undefined ? true : !b.on);
        if (r.ok) await logAdminEvent(env, request, request.method === "POST" ? "invite-make" : (r.disabled ? "invite-disable" : "invite-enable"), r.scope === GLOBAL_SCOPE ? "every bot" : r.scope, `${r.code}${request.method === "POST" ? ` · ends ${r.until ? String(r.until).slice(0, 10) : "never"} · ${r.maxUses === 1 ? "one person" : `up to ${r.maxUses}`}${b.note ? ` · ${String(b.note).slice(0, 80)}` : ""}` : ""}`);
        return json(r, r.ok ? 200 : r.status || 400);
      }
      // See what a visitor sees — READ ONLY. Their threads and turns, exactly as their page has them
      // (Engine/worker/chats.js). No writes here: the admin can look, never send as them.
      // --- WHEN ACCESS RUNS OUT (Engine/worker/expiry.js). Three things can carry a
      //     date and this is where all three are set. Every write is audited with the
      //     person's address in `subject`, which is what the timeline reads.
      //       GET    /api/admin/access?bot=<id>     everyone with a date, plus the keys
      //       PUT    /api/admin/access              {bot, email, until}  (until:"" = unlimited)
      //       PUT    /api/admin/access/key          {name, until, note}
      //       GET    /api/admin/access/timeline?email=…   one person, newest first
      if (url.pathname === "/api/admin/access") {
        if (!env.DB) return json({ error: "Access dates need the D1 database (wrangler.jsonc → d1_databases)." }, 503);
        if (request.method === "GET") {
          const bot = String(url.searchParams.get("bot") || "").trim();
          return json({ people: await datedPeople(env, bot), keys: await keyRows(env), expiry: settings.expiry, modes: LAPSE_MODES.map((id) => ({ id, line: LAPSE_LINES[id] })) });
        }
        if (request.method !== "PUT") return json({ error: "method" }, 405);
        const { body: b, error } = await readJson(request); if (error) return error;
        const email = cleanEmail(b?.email);
        const bot = String(b?.bot || "").trim();
        if (!email || !bot) return json({ error: "bot and a valid email are required" }, 400);
        if (b?.until && !cleanUntil(b.until)) return json({ error: "until must be a date like 2026-12-31, or empty for unlimited" }, 400);
        const r = await setPersonUntil(env, { bot, email, until: b.until, log: logAdminEvent, request });
        return json(r, r.ok ? 200 : r.status || 400);
      }
      if (url.pathname === "/api/admin/access/key") {
        if (!env.DB) return json({ error: "Access dates need the D1 database (wrangler.jsonc → d1_databases)." }, 503);
        if (request.method !== "PUT") return json({ error: "PUT only" }, 405);
        const { body: b, error } = await readJson(request); if (error) return error;
        const name = String(b?.name || "").trim();
        // Only a real ACCESS_PASSPHRASE* name, so a date can never be hung on GITHUB_TOKEN.
        if (!(name === "ACCESS_PASSPHRASE" || /^ACCESS_PASSPHRASE_[A-Z0-9_]+$/.test(name))) return json({ error: "name must be ACCESS_PASSPHRASE or ACCESS_PASSPHRASE_<SOMETHING>" }, 400);
        if (b?.until && !cleanUntil(b.until)) return json({ error: "until must be a date like 2026-12-31, or empty for unlimited" }, 400);
        const r = await setKeyUntil(env, { name, until: b.until, note: b.note, log: logAdminEvent, request });
        return json(r, r.ok ? 200 : r.status || 400);
      }
      if (url.pathname === "/api/admin/access/timeline") {
        if (!env.DB) return json({ error: "The timeline needs the D1 database (wrangler.jsonc → d1_databases)." }, 503);
        const email = cleanEmail(url.searchParams.get("email"));
        if (!email) return json({ error: "a valid email is required" }, 400);
        return json(await timelineFor(env, email, url.searchParams.get("limit")));
      }
      if (url.pathname === "/api/admin/chats" || url.pathname === "/api/admin/chats/users") {
        if (request.method !== "GET") return json({ error: "read only" }, 405);
        if (!env.DB) return json({ error: "History needs the D1 database (wrangler.jsonc → d1_databases)." }, 503);
        const target = await resolveProject(env, String(url.searchParams.get("bot") || "").toLowerCase());
        if (!target.id) return json({ error: "which bot? ?bot=<id>" }, 400);
        await ensureIdentitySchema(env);
        if (url.pathname === "/api/admin/chats/users") return json({ bot: target.id, users: await usersWithHistory(env, target.id) });
        const email = cleanEmail(url.searchParams.get("email"));
        if (!email) return json({ error: "which visitor? &email=" }, 400);
        const user = await idUserByEmail(env, target.id, email);
        if (!user) return json({ error: "no such visitor on this bot", bot: target.id, email }, 404);
        const threads = await listThreads(env, target.id, user.id);
        await logAdminEvent(env, request, "view-as", target.id, `viewed ${email}'s history (read only) · ${threads.length} thread${threads.length === 1 ? "" : "s"}`);
        return json({ bot: target.id, email, readOnly: true, threads, last_seen: user.last_seen });
      }
      if (url.pathname === "/api/admin/gaps" || url.pathname.startsWith("/api/admin/gaps/")) return handleGaps(request, env, url);
      if (url.pathname === "/api/admin/handoffs" || url.pathname.startsWith("/api/admin/handoff/")) return handlePersonAdmin(request, env, url);
      if (url.pathname === "/api/admin/projects") return json({ projects: (await resolveList(env)).map((p) => ({ ...p, href: hrefFor(p) })), kinds: Object.keys(KINDS).map((id) => ({ id, label: KIND_LABELS[id] })), adminNeedsCode: adminNeedsCode(env), jobs: Object.values(MODES).map((m) => ({ id: m.id, blurb: m.blurb, role: m.role, shape: m.shape, done: m.done })), model: CONFIG.model, canSave: Boolean(env.DB), rootPrompt: ROOT_PROMPT_FILES, github: { repo: CONFIG.github?.repo || "", branch: CONFIG.github?.branch || "main", ready: Boolean(CONFIG.github?.repo && env.GITHUB_TOKEN) }, library: libraryMeta(env, CONFIG), access: { default: settings.default, floor: settings.floor, modes: ACCESS_MODES.map((id) => ({ id, line: MODE_LINES[id] })), sharedKey: Boolean(env.ACCESS_PASSPHRASE) } });
      if (url.pathname === "/api/admin/project") {
        const id = String(url.searchParams.get("id") || "").toLowerCase();
        if (request.method === "GET") { const p = await resolveProject(env, id); return json({ project: { ...p, id: p.id || id }, source: (await savedProjects(env))[id] ? "saved" : (inFolder(id) ? "folder" : "new"), access: effectiveAccess(p, settings), signIn: signInMethods(p, env), href: hrefFor({ ...p, id: p.id || id }) }); }
        if (!env.DB) return json({ error: "Saving needs the D1 database (wrangler.jsonc → d1_databases). Export the files instead." }, 400);
        if (request.method === "PUT") {
          const { body: b, error } = await readJson(request); if (error) return error;
          const pid = String(b.id || id || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
          if (!pid) return json({ error: "give the bot a name" }, 400);
          const before = (await savedProjects(env))[pid];
          const p = await saveProject(env, pid, b);
          await logAdminEvent(env, request, "project-save", pid, `${before ? "updated" : "created"} the saved copy · ${p.kind} · access ${p.access || "(default)"} · ${p.listed ? "listed" : "unlisted"}${p.kind === "chat" ? ` · ${Object.keys(p.files).length} files` : ""}`);
          return json({ ok: true, id: pid, project: p, access: effectiveAccess(p, settings) });
        }
        if (request.method === "DELETE") { await deleteSavedProject(env, id); await logAdminEvent(env, request, "project-delete", id, inFolder(id) ? "removed the saved copy; the folder is live again" : "removed the saved copy"); return json({ ok: true, fallsBackToFolder: inFolder(id) }); }
        return json({ error: "method" }, 405);
      }
      if (url.pathname === "/api/admin/project/sync") {
        if (request.method !== "POST") return json({ error: "POST only" }, 405);
        const sid = String(url.searchParams.get("id") || "");
        const r = await syncToGitHub(env, sid);
        await logAdminEvent(env, request, "project-commit", sid, r.error ? `failed: ${r.error}` : `${r.committed.length} committed, ${r.deleted.length} removed, ${r.unchanged.length} unchanged${r.errors.length ? ` · errors: ${r.errors.join("; ")}` : ""}`);
        return json(r);
      }
      // --- Settings (default + floor). GET what applies and why; PUT { access: { default, floor } }
      //     saves it to D1 (live at once); POST /sync writes YourBots/settings.json into the repo.
      if (url.pathname === "/api/admin/settings") {
        if (request.method === "GET") return json(await settingsView(env, settings));
        if (request.method !== "PUT") return json({ error: "method" }, 405);
        if (!env.DB) return json({ error: "Saving settings needs the D1 database (wrangler.jsonc → d1_databases). Edit YourBots/config.js → access instead." }, 400);
        const { body: b, error } = await readJson(request); if (error) return error;
        const a = b?.access || {};
        const next = { default: cleanMode(a.default), floor: cleanMode(a.floor) };
        if (!next.default || !next.floor) return json({ error: `default and floor must each be one of: ${ACCESS_MODES.join(", ")}` }, 400);
        const badge = cleanBadge(b?.createYourOwn);
        const ident = b?.identity && typeof b.identity === "object" && b.identity.graceMinutes !== undefined ? { graceMinutes: b.identity.graceMinutes } : null;
        if (ident && !(Number.isFinite(Number(ident.graceMinutes)) && Number(ident.graceMinutes) >= -1)) return json({ error: "identity.graceMinutes must be a number of minutes, 0 or more (or -1: never block a second device)" }, 400);
        const exp = cleanExpiryConfig(b?.expiry);
        if (b?.expiry && !exp) return json({ error: `expiry.onLapse must be one of: ${LAPSE_MODES.join(", ")}, and the day counts must be numbers` }, 400);
        const su = b?.signup ? cleanSignup(b.signup, settings.signup) : null;
        const lk = b?.links ? cleanLinks(b.links) : null;
        const br = b?.brand ? cleanBrand(b.brand) : null;
        const ky = b?.keys ? cleanKeys(b.keys) : null;
        // Demo mode: the tour and the sample bots. A change to one switch keeps the other as it is.
        const dmIn = cleanDemo(b?.demo);
        const dm = dmIn ? { tour: settings.demo?.tour !== false, bots: settings.demo?.bots !== false, ...dmIn } : null;
        await saveSettings(env, { access: next, createYourOwn: badge, identity: ident, expiry: exp, signup: su, links: lk, brand: br, keys: ky, demo: dm });
        await logAdminEvent(env, request, "settings-save", "access", `default ${settings.default} → ${next.default} · floor ${settings.floor} → ${next.floor}${badge ? ` · badge ${badge.show ? `"${badge.text}"` : "hidden"}` : ""}${ident ? ` · return window ${settings.identity?.graceMinutes} → ${Math.round(Number(ident.graceMinutes))} min` : ""}${exp ? ` · when access lapses ${settings.expiry?.onLapse} → ${exp.onLapse ?? settings.expiry?.onLapse}${exp.graceDays !== undefined ? `, grace ${exp.graceDays}d` : ""}` : ""}`);
        if (dm && (dm.tour !== (settings.demo?.tour !== false) || dm.bots !== (settings.demo?.bots !== false))) await logAdminEvent(env, request, "demo-mode", "demo", `tour ${settings.demo?.tour !== false ? "on" : "off"} → ${dm.tour ? "on" : "off"} · sample bots ${settings.demo?.bots !== false ? "shown" : "hidden"} → ${dm.bots ? "shown" : "hidden"}`);
        return json(await settingsView(env, await getSettings(env)));
      }
      if (url.pathname === "/api/admin/settings/sync") {
        if (request.method !== "POST") return json({ error: "POST only" }, 405);
        const r = await syncSettingsToGitHub(env, settings);
        await logAdminEvent(env, request, "settings-commit", "YourBots/settings.json", r.error ? `failed: ${r.error}` : `default ${settings.default} · floor ${settings.floor}${r.unchanged ? " (unchanged)" : ""}`);
        return json(r);
      }
      // --- What changed, and when: every admin write, newest first. Never the IP — a hash of it.
      if (url.pathname === "/api/admin/events") return json(await adminEvents(env, url.searchParams.get("limit")));
      if (url.pathname === "/api/admin/project/export") {
        const id = String(url.searchParams.get("id") || "");
        return json({ files: exportFiles(await resolveProject(env, id), id) });
      }
      if (url.pathname === "/api/admin/source") {
        const name = String(url.searchParams.get("name") || "");
        const res = await env.ASSETS.fetch(new Request(`${url.origin}/engine/${name.replace(/\//g, "__")}.txt`));
        return new Response(await res.text(), { status: res.status, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      return env.ASSETS.fetch(request);
    }

    // --- The door: { passphrase, project } → a token for THAT bot's key (its own
    //     secret, or the shared one). The page keeps the token, never the passphrase.
    if (url.pathname === "/api/unlock") {
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      if (!(await allowed(env, request)) || !(await unlockAllowed(env, request))) return json({ error: "too many attempts" }, 429);
      const { body: b, error } = await readJson(request, { max: 8 * 1024, strict: false }); if (error) return error;
      const project = await resolveProject(env, String(b.project || ""));
      const a = effectiveAccess(project, settings);
      if (a.mode === "admin" || a.mode === "draft") return json({ error: a.mode, reply: a.mode === "draft" ? "This bot is a draft." : "This bot opens with the admin code, not a passphrase." }, 401);
      if (!a.wantKey) return json({ token: null, locked: false });
      const k = await tokenFor(env, project);
      if (!k.token) return json({ token: null, locked: false });            // no secret installed: documented open fallback
      const given = await accessToken(String(b.passphrase || ""), k.name === "ACCESS_PASSPHRASE" ? "bot-you-own/access/v1" : `bot-you-own/access/v1/${k.name}`);
      return safeEqual(given, k.token) ? json({ token: k.token, locked: true, shared: k.shared }) : json({ error: "wrong passphrase" }, 401);
    }

    // --- What the page needs to draw itself. ?project=<id> says which bot the
    //     visitor is looking at; the answer says what THAT bot requires, so the
    //     page knows which lock screen to show even before anyone is unlocked.
    if (url.pathname === "/api/config") {
      const current = await resolveProject(env, String(url.searchParams.get("project") || "").toLowerCase() || await landingProject(env, settings));
      const curId = current.id || CONFIG.defaultProject;
      const view = accessView(current, settings);
      const g = await guard(current);                                        // key / admin / draft — the email step is the chat's
      if (!g.ok) return json({ locked: true, project: curId, projectName: current.name, access: view, reason: g.error, reply: g.reply, adminEnabled, siteName: settings.brand?.siteName || CONFIG.siteName, accent: CONFIG.accent, signup: { ...publicSignup(settings.signup), keys: HAS_GUIDE } });
      const all = (await resolveList(env)).map((p) => { const a = effectiveAccess(p, settings); return { ...p, kind: cleanKind(p.kind), href: hrefFor(p), access: a.mode, listed: a.listed }; });
      // Visitors see listed bots that aren't drafts. The admin sees everything, with a badge.
      // "listed" is visibility, not security: an unlisted bot still checks its own door.
      // demo.bots off: the sample bots that ship in the box leave the sidebar. Visibility only —
      // nothing is deleted, the folders are untouched, the owner still sees them (badged, like an
      // unlisted bot) and can open any of them by its link. Flip it back and they all return.
      const showDemoBots = settings.demo?.bots !== false;
      let projects = (CONFIG.singleProject ? all.filter((p) => p.id === CONFIG.defaultProject) : all)
        .filter((p) => !p.sandbox && (isAdmin || (p.listed && p.access !== "draft")))
        .filter((p) => showDemoBots || isAdmin || !p.demo)
        .map((p) => (!showDemoBots && p.demo ? { ...p, sampleHidden: true } : p));   // the owner still sees them, badged
      // demo.tour off: drop the stops from the payload. The page decides there IS a guide by
      // finding a bot that carries tour.stops (index.html), so removing it takes the whole
      // layer with it — strip, pointing finger, $ badges, intro — and leaves the bot itself
      // as an ordinary bot. One field, because everything already hangs off that one check.
      if (settings.demo?.tour === false) projects = projects.map(({ tour, ...rest }) => rest);
      // …plus this visitor's own sandbox bots (Engine/worker/sandbox.js), and every sandbox for the admin.
      for (const sb of await visibleSandboxes(env, request, { isAdmin, all })) projects.push(sb);
      if (!projects.some((p) => p.id === curId)) projects.push({ ...pickPublic({ ...current, thinkingWords: current.thinkingWords || [] }), id: curId, href: hrefFor({ ...current, id: curId }), access: view.mode, listed: view.listed, source: "direct link" });
      // handoffText rides along so the page can offer "Talk to a person" under a
      // reply that contains it. It is said to visitors word for word anyway.
      for (const p of projects) p.handoffText = p.kind === "chat" ? (await resolveProject(env, p.id)).handoffText || "" : "";
      // Email mode: is THIS browser already someone? The server says, not localStorage.
      let identity = null;
      if (view.email && !isAdmin && cleanKind(current.kind) === "chat") {
        if (!env.DB) identity = { linked: false, pending: null, reason: "Email mode needs the D1 database (wrangler.jsonc → d1_databases)." };
        else try {
          const who = await identify(request, env, { ...current, id: curId });
          identity = who.user ? { linked: true, email: who.user.email, name: who.user.name || "" } : { linked: false, pending: who.pending ? { code: who.pending.code, email: who.pending.email } : null };
          // allow mode: say now whether they're on the list, so the page shows the right screen before the first message.
          if (who.user && view.list) { const r = await isAllowed(env, curId, who.user.email); identity.allowed = r.ok; if (!r.ok) identity.reason = r.reason; }
          // Their own window, in their own words: "your access ends in 5 days".
          // The person is told about THEIR date and nothing else — never the policy,
          // never anyone else's. docs/CUSTOMIZE.md → "When access runs out".
          if (who.user) {
            const cfg = expiryFor(current, settings);
            // The same three sources the gate uses, so the countdown warns about
            // whichever one is actually going to bite — not just the person's own date.
            const exp = await resolveExpiry(env, {
              bot: curId,
              email: who.user.email,
              emailHmac: view.list ? await blindFor(env, who.user.email) : "",
              keyName: view.key ? keyFor(env, current).name : "",
            }, cfg);
            identity.access = { until: exp.until, state: exp.state, days: exp.days, notice: noticeFor(exp), readOnly: exp.state === "lapsed" && cfg.onLapse === "readonly" };
          }
        }
        catch (err) { console.error("identity lookup failed on /api/config", err?.message || err); identity = { linked: false, pending: null }; }
      }
      return json({
        version: await versionStamp(env),
        identity,
        locked: view.key,                                                    // this bot needs a key (and the caller has one)
        accessMode: view.mode,
        access: view,
        current: curId,
        adminEnabled,
        owner: settings.brand?.owner || CONFIG.owner,
        siteName: settings.brand?.siteName || CONFIG.siteName,
        createYourOwn: settings.createYourOwn.show ? { text: settings.createYourOwn.text, url: settings.createYourOwn.url } : null,
        signup: { ...publicSignup(settings.signup), keys: HAS_GUIDE },
        community: CONFIG.community && CONFIG.community.show !== false && CONFIG.community.url ? { name: CONFIG.community.name, url: CONFIG.community.url, pitch: CONFIG.community.pitch } : null,
        ...(isAdmin ? { links: settings.links } : {}),           // the owner's page may show them; a visitor asks /api/tour
        accent: CONFIG.accent,
        thinkingWords: Array.isArray(CONFIG.thinkingWords) ? CONFIG.thinkingWords : ["Thinking"],
        model: current.model || CONFIG.model,   // the pill should name what actually answers this bot
        provider: CONFIG.provider,
        defaultProject: CONFIG.defaultProject,
        projects,
        // the paperclip: whether to show it, and what it accepts
        attachments: { enabled: attachmentRules().enabled, max: attachmentRules().max, maxBytes: attachmentRules().maxBytes, extensions: allExtensions() },
        // the mic and the speaker: which halves are on (YourBots/config.js → voice)
        voice: { enabled: voiceRules().enabled, in: voiceRules().in, out: voiceRules().out, maxSeconds: voiceRules().maxSeconds },
      });
    }

    // History on any computer: an identified visitor's own threads (Engine/worker/chats.js).
    // The bot's door is asked first (key, list…), then WHO from the device key. No identity → 401.
    if (url.pathname === "/api/chats" || url.pathname.startsWith("/api/chats/")) {
      return handleChats(request, env, url, { isAdmin, guard, settings });
    }

    // Every visitor route below finds its bot, then asks the gate. The handlers do
    // that themselves (the bot id is in the body / the form), with `guard`.
    // /chat and every chat's own address (/chat/<id>) are the one page (Engine/public/chat/index.html).
    if (url.pathname === "/chat" || url.pathname.startsWith("/chat/")) {
      if (url.pathname === "/chat") return Response.redirect(url.origin + "/chat/", 302);
      return env.ASSETS.fetch(new Request(`${url.origin}/chat/`, { headers: request.headers }));
    }
    // The text models /chat can pick from: Cloudflare's live catalogue, with our price snapshot.
    if (url.pathname === "/api/models" && request.method === "GET") {
      if (!(await allowed(env, request))) return json({ error: "rate-limited" }, 429);
      return json({ models: await listTextModels(env), default: (await resolveProject(env, CHAT_BOT)).model || CONFIG.model, bot: CHAT_BOT });
    }
    if (url.pathname === "/api/chat") {
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      return handleChat(request, env, ctx, { isAdmin, guard, visitorOf });
    }

    // The paperclip. Same door as /api/chat; switched off = it doesn't exist.
    if (url.pathname === "/api/attach") {
      if (!attachmentRules().enabled) return json({ error: "not found" }, 404);
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      return handleAttach(request, env, ctx, { guard });
    }

    // The mic and the speaker. Same door as /api/chat; switched off = they don't exist.
    if (url.pathname === "/api/transcribe" || url.pathname === "/api/speak") {
      const v = voiceRules();
      const half = url.pathname === "/api/transcribe" ? v.in : v.out;
      if (!v.enabled || !half) return json({ error: "not found" }, 404);
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      return url.pathname === "/api/transcribe" ? handleTranscribe(request, env, { guard }) : handleSpeak(request, env, { guard });
    }

    // Talk to a person. Same door as /api/chat: the bot's own gate decides.
    if (url.pathname === "/api/handoff" || url.pathname.startsWith("/api/handoff/")) {
      return handlePerson(request, env, ctx, url, { isAdmin, guard, visitorOf });
    }

    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
  },
};

// --- LLM10 Unbounded Consumption: rate limit per visitor (fail-open) -------
async function allowed(env, request) {
  if (!env.RATE_LIMITER) return true;
  const ip = request.headers.get("cf-connecting-ip") || "anon";
  try {
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    return success;
  } catch (err) {
    console.error("rate limit check failed, allowing through", err);
    return true;
  }
}

// The passphrase screens get a tighter limit than chat: 10 tries a minute per
// visitor (wrangler.jsonc → UNLOCK_LIMITER). Wrong guesses and right ones both
// count. Missing binding = no extra limit (the 30/min above still applies).
async function unlockAllowed(env, request) {
  if (!env.UNLOCK_LIMITER) return true;
  const ip = request.headers.get("cf-connecting-ip") || "anon";
  try {
    const { success } = await env.UNLOCK_LIMITER.limit({ key: ip });
    return success;
  } catch (err) {
    console.error("unlock limit check failed, allowing through", err);
    return true;
  }
}

// The admin token's label. Bump the ADMIN_TOKEN_VERSION secret (1 → 2) and every
// stored admin token stops working; the code doesn't change. docs/DEPLOY.md §B3.
function adminLabel(env) {
  return "bot-you-own/admin/v" + String(env.ADMIN_TOKEN_VERSION || "1").replace(/[^\w.-]/g, "").slice(0, 20);
}
// The break-glass key, if one is set and long enough to be one. Under 16 characters
// it is ignored (with a warning): a recovery credential that is short is a back door.
let BG_WARNED = false;
function breakGlassKey(env) {
  const k = String(env.ADMIN_UNLOCK_KEY || "");
  if (!k) return "";
  if (k.length < 16) { if (!BG_WARNED) { BG_WARNED = true; console.warn("ADMIN_UNLOCK_KEY is shorter than 16 characters — ignored. Set a long random one (docs/DEPLOY.md → B3d)."); } return ""; }
  return k;
}

// A JSON body, with a size cap (256 KB unless told otherwise) and — for the
// admin's writes — a check that it was sent as JSON. { body } or { error: Response }.
const MAX_JSON = 256 * 1024;
async function readJson(request, { max = MAX_JSON, strict = true } = {}) {
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  if (strict && !ct.includes("application/json")) return { error: json({ error: "send JSON (content-type: application/json)" }, 415) };
  const tooBig = json({ error: `That's too big — the limit is ${Math.round(max / 1024)} KB.` }, 413);
  if (Number(request.headers.get("content-length") || 0) > max) return { error: tooBig };
  let text;
  try { text = await request.text(); } catch { return { error: json({ error: "bad request" }, 400) }; }
  if (text.length > max) return { error: tooBig };
  try { const body = JSON.parse(text); return body && typeof body === "object" ? { body } : { error: json({ error: "bad request" }, 400) }; }
  catch { return { error: json({ error: "bad request" }, 400) }; }
}

async function handleChat(request, env, ctx, { isAdmin = false, guard, visitorOf = async () => "" } = {}) {
  const settings = await getSettings(env);                                   // brand (run by), cached 10 s
  if (!(await allowed(env, request))) {
    return json({ reply: "You're sending messages faster than I can think. Give me a moment and try again.", flags: ["rate-limited"] }, 429);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: "bad request" }, 400); }
  if (!body || typeof body !== "object") return json({ error: "bad request" }, 400);

  // Configure → Preview talks to an unsaved draft (admin only). Everything else is a bot by id.
  const draftPreview = Boolean(isAdmin && body.draft && typeof body.draft === "object");
  const project = draftPreview
    ? normaliseProject(body.draft, String(body.draft.id || "draft"))
    : await resolveProject(env, String(body.project || ""));

  // An app-shaped bot (kind "food") has no chat: its page is /apps/<id>.
  if (project.kind && project.kind !== "chat") return json({ error: "not a chat bot", reply: `${project.name} is an app, not a chat bot. Open /apps/${project.id}.`, href: `/apps/${project.id}` }, 404);
  // --- THE GATE. This bot's door: key, email, admin code, or draft. Engine/worker/access.js.
  const g = await guard(project, { draftPreview, email: await visitorOf(project) });   // body.visitor is ignored: identity says who
  if (!g.ok) return json({ error: g.error, reply: g.reply, access: g.mode, expiry: g.expiry || null }, g.status);
  // "readonly" (YourBots/config.js → expiry.onLapse): their window closed, they may
  // still READ their own history — /api/chats keeps working — but nothing new is sent
  // to the model. Refused here rather than in the gate so the reason is a proper reply.
  if (g.readOnly) return json({ error: "expired", reply: g.notice, access: g.mode, readOnly: true, expiry: g.expiry || null }, 403);
  const who = g.who;                                                          // the email they typed, "admin", or ""
  const stream = body.stream !== false;
  const fw = CONFIG.firewall || {};

  // --- Trim history: last N turns, capped per message ----------------------
  const history = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-(fw.maxTurns || 12))
    .map((m) => ({ role: m.role, content: m.content.slice(0, fw.maxChars || 4000) }));
  if (!history.length || history[history.length - 1].role !== "user") {
    return json({ error: "last message must be from the user" }, 400);
  }

  const handoff = [project.handoffText, project.handoffContact].filter(Boolean).join(" ")
    || "I can't help with that one.";
  const send = (reply, flags) => stream ? sseOnce(reply, flags) : json({ reply, flags });

  // --- LLM01 / LLM07: the inbound screen. Never reaches the model. ----------
  const last = history[history.length - 1];
  const screen = screenInbound(last.content);
  last.content = screen.text;
  const flags = [];
  // The page says so when the visitor spoke the message (the mic → /api/transcribe).
  // A chip on the turn, a word in the log; the text itself is screened the same.
  if (body.voice === "in" && voiceRules().in) flags.push("voice-in");
  if (screen.invisible) flags.push("invisible-text-stripped");
  if (screen.secret) flags.push("secret-detected");
  if (screen.injection && fw.blockInjections !== false) {
    flags.push("injection-blocked");
    const reply = `I'm here to help with ${project.name}, so I'll skip that one. What can I help you with?`;
    ctx.waitUntil(afterReply(env, { project, question: last.content, reply, flags, who, history, url: request.url }));
    return send(reply, flags);
  }

  // --- Optional: Llama Guard on the user's turn ------------------------------
  if (fw.llamaGuard) {
    const g = await llamaGuard(env, [{ role: "user", content: last.content }]);
    if (g.ran && !g.safe) {
      flags.push("guard-blocked:" + (g.categories.join(",") || "unspecified"));
      const reply = "I can't help with that. If you're in a difficult situation, please reach out to someone qualified to help.";
      ctx.waitUntil(afterReply(env, { project, question: last.content, reply, flags, who, history, url: request.url }));
      return send(reply, flags);
    }
  }

  // --- The visitor's attachment(s). The page got the text from /api/attach and
  //     sends it back with every turn, like the history. The checks run AGAIN
  //     here — /api/chat is where it matters, and nothing stops a script from
  //     skipping /api/attach. Never logged; never stored.
  const attachments = [];
  const rules = attachmentRules();
  if (rules.enabled && Array.isArray(body.attachments)) {
    for (const a of body.attachments.slice(0, rules.max)) {
      if (!a || typeof a.text !== "string" || !a.text.trim()) continue;
      const v = vetAttachment(a.text, rules.maxChars);
      if (v.refused) {
        flags.push(v.flag);
        ctx.waitUntil(logTurn(env, project, last.content, v.reason, flags, who));
        return send(v.reason, flags);
      }
      attachments.push({ name: safeName(a.name || "attachment").slice(0, 120) || "attachment", text: v.text });
    }
  }
  if (attachments.length) flags.push("attachment-used");

  // --- LAYER 2b: the library, and the website if the bot has one. Relevant
  //     excerpts from this bot's documents (PDFs, sheets, transcripts) and its
  //     crawled pages for THIS question. The search is given the visitor's last
  //     few messages, not just the latest one, so a follow-up like "and on
  //     Thursdays?" still finds the right page. "" if none, or if AI Search
  //     isn't set up — the bot answers from knowledge/ regardless.
  //     `sources` = the document names / page URLs, shown under the answer.
  const userTurns = history.filter((m) => m.role === "user").map((m) => m.content);
  const found = await retrieve(env, CONFIG, project.id || CONFIG.defaultProject, userTurns, { website: websiteOf(project) });
  const passages = found.text;
  const sources = found.sources;
  if (found.library) flags.push("library-used");
  if (found.website) flags.push("website-used");

  // --- LAYER 1a: which language to answer in. A cheap guess from the visitor's
  //     last two messages — script and stopwords, no model call (Engine/worker/
  //     language.js). Unsure = English, exactly as before. The flag records what
  //     the visitor wrote in; config.languages decides what the bot replies in.
  const language = chooseLanguage(languageSettings(CONFIG), detectLanguage(userTurns.slice(-2)));
  if (language.detected) flags.push("language:" + language.detected);
  if (language.unavailable) flags.push("language-unavailable");

  // --- LAYER 1: build the prompt --------------------------------------------
  const prompt = buildSystemPrompt({ config: { ...CONFIG, owner: settings.brand?.owner || CONFIG.owner, siteName: settings.brand?.siteName || CONFIG.siteName }, project, passages, attachments, bookingLive: bookingLive(env, project), language, tour: project.tour && Array.isArray(body.tour) ? body.tour.map((x) => String(x).slice(0, 20)).slice(0, 8) : null });
  const outboundOpts = { allowedLinks: project.allowedLinks, protectedText: prompt.protectedText, config: CONFIG, project };
  // A second, non-streaming call with the same prompt — used only if the first reply came out as garbage (see finish()).
  // The retry exists for a reply that came back degenerate or empty. Re-asking with the
  // SAME budget just reproduces the same failure — which is exactly what happened on the
  // first empty-reply turns: no retry ever succeeded. Give it real headroom instead.
  // This bot's own model if it names one, otherwise the deployment's.
  // /chat lets the person pick the model (and compare several) — only on the open Assistant, and only a
  // model on Cloudflare's own text-generation list (Engine/worker/models.js). A picked model is never routed
  // to the small model: a comparison has to be the model they chose, every turn.
  const picked = project.id === CHAT_BOT && (CONFIG.provider || "workers-ai") === "workers-ai" && body.model && await isPickable(env, body.model) ? String(body.model) : "";
  const botModel = picked || project.model || "";
  // /chat can send pictures with the latest message (body.images: small data: URLs the page made). They go to
  // the model only if it can see (models.js → sees); the words go either way. Never logged, never stored here.
  const pics = picked && seesImages(picked) && Array.isArray(body.images)
    ? body.images.filter((u) => typeof u === "string" && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(u) && u.length <= 2_000_000).slice(0, 4) : [];
  const modelHistory = pics.length
    ? history.map((m, k) => k === history.length - 1 ? { role: m.role, content: [{ type: "text", text: m.content }, ...pics.map((url) => ({ type: "image_url", image_url: { url } }))] } : m)
    : history;
  if (pics.length) flags.push("images:" + pics.length);
  const retry = () => complete({ env, config: CONFIG, system: prompt.text, messages: modelHistory, stream: false, model: botModel, maxTokens: Math.max(Number(CONFIG.maxTokens) || 900, 4000) * 2 });

  // --- LAYER 3c: the router. "hi" / "thanks" / "ok" go to the small model with
  //     the same prompt; everything else to the main model. Engine/worker/router.js.
  const routing = CONFIG.routing || {};
  const route = routing.smallTurns && routing.smallModel
    ? classifyTurn(last.content, { project, attachments: attachments.length })
    : { kind: "real", reason: "routing off" };
  let small = route.kind === "chit-chat" && !picked;
  if (small) console.log(JSON.stringify({ event: "route", project: project.name, kind: route.kind, reason: route.reason, model: routing.smallModel }));

  // --- LAYER 3b: call the model through the gateway --------------------------
  //     `meta` comes back saying whether the call went via the gateway or direct,
  //     and with token counts when the model reports them.
  let result;
  const meta = {};
  try {
    if (small) {
      try {
        result = await complete({ env, config: CONFIG, system: prompt.text, messages: modelHistory, stream, model: routing.smallModel, maxTokens: routing.smallMaxTokens || 200, meta });
      } catch (err) {
        // The small model is a saving, not a dependency: if it fails, the main model answers.
        console.error("small model failed, using the main model", err?.message || err);
        small = false;
      }
    }
    if (!small) result = await complete({ env, config: CONFIG, system: prompt.text, messages: modelHistory, stream, model: botModel, meta });
  } catch (err) {
    console.error("model call failed", err?.code || "", err?.message || err);
    const spent = isAllowanceError(err);
    const f = [...flags, err?.code === "gateway-blocked" ? "gateway-blocked" : err?.code === "rate-limited" ? "provider-rate-limited" : spent ? "ai-allowance-spent" : "model-error"];
    ctx.waitUntil(recordUsage(env, { model: botModel || CONFIG.model, error: true }));
    ctx.waitUntil(afterReply(env, { project, question: last.content, reply: handoff, flags: f, who, history, url: request.url }));
    return send(handoff, f);
  }
  if (small) flags.push("small-model");
  if (meta.gateway === "direct (gateway missing)") flags.push("gateway-direct");
  // the split for Under the hood: counted now for a full reply, after the last chunk for a stream
  const countRoute = () => {
    recordRoute(small ? "small" : "main", meta.usage);
    // The same numbers, kept: router.js counts in memory and an isolate forgets.
    ctx.waitUntil(recordUsage(env, { model: small ? (routing.smallModel || "") : (botModel || CONFIG.model), usage: meta.usage }));
  };

  // --- Non-streaming path -----------------------------------------------------
  if (!stream) {
    countRoute();
    const out = await finish(String(result), { env, fw, flags, handoff, outboundOpts, retry, who, history });
    ctx.waitUntil(afterReply(env, { project, question: last.content, reply: out.reply, flags: out.flags, who, history, url: request.url, booking: out.booking }));
    return json({ reply: out.reply, flags: out.flags, sources });
  }

  // --- Streaming path: send deltas as they come, then a "final" event with the
  //     firewall-checked text. The page replaces what it showed with "final".
  //     (Links and leaks can span chunks, so the check runs on the whole reply.)
  const encoder = new TextEncoder();
  const sse = new ReadableStream({
    async start(controller) {
      const push = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      let full = "";
      try {
        for await (const chunk of result) {
          full += chunk;
          push({ type: "delta", text: chunk });
        }
        countRoute();
        const out = await finish(full, { env, fw, flags, handoff, outboundOpts, retry, who, history });
        push({ type: "final", text: out.reply, flags: out.flags, sources });
        ctx.waitUntil(afterReply(env, { project, question: last.content, reply: out.reply, flags: out.flags, who, history, url: request.url, booking: out.booking }));
      } catch (err) {
        console.error("stream failed", err);
        push({ type: "final", text: handoff, flags: [...flags, "stream-error"] });
      }
      controller.close();
    },
  });
  return new Response(sse, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" } });
}

// LAYER 3a outbound: links, leaks, optional Llama Guard on the answer.
async function finish(raw, { env, fw, flags, handoff, outboundOpts, retry = null, who = "", history = [] }) {
  const out = screenOutbound(raw.trim(), outboundOpts);
  let reply = out.text;
  const f = [...flags, ...out.flags];
  let booking = null;
  // Models occasionally come apart and emit "!!!!!!!!" or "Quick Quick Quick…"
  // for a whole reply (seen three times in one evening's test runs, always
  // gpt-oss). A visitor should never see that. Enforced in code: a reply that
  // is mostly one repeated character or one repeated word becomes the handoff.
  if (reply && isDegenerate(reply)) {
    // One more go, non-streaming, before giving up on the answer. Costs one
    // extra model call about once in thirty turns; saves a good answer most times.
    let again = "";
    try { again = retry ? String(await retry()).trim() : ""; } catch (err) { console.error("retry after degenerate reply failed", err?.message || err); }
    if (again && !isDegenerate(again)) { f.push("degenerate-retried"); reply = screenOutbound(again, outboundOpts).text; }
    else { f.push("degenerate-reply"); reply = ""; }
  }
  if (reply) {
    // A strict bot ends a decline with "[HANDOFF]" (YourBots/_prompt/7-answering-strict.md)
    // so the code can tell a decline in any language. Take the line out, then make
    // sure the owner's contact is there — appended, verbatim, if the model dropped it.
    const hm = stripHandoffMarker(reply);
    if (hm.found) { reply = hm.text; f.push("declined"); }          // the bot said no by its rules: worth a chip
    const h = ensureHandoff(reply, outboundOpts.project, { declined: hm.found });
    if (h.added) { reply = h.text; f.push("handoff-appended"); }
    // An intake bot ends its final summary with "[INTAKE COMPLETE]" (YourBots/_prompt/jobs/intake.md).
    // Take the line out — the visitor and the audit log never see it — and remember it fired.
    // (On the streaming path the line may flash for a moment before "final" replaces the text.)
    const m = stripIntakeMarker(reply);
    if (m.found) { reply = m.text; if (m.done && outboundOpts.project.mode === "intake") f.push("intake-complete"); }
    // One question at a time, enforced in code (the prompt says it; gpt-oss ignores it about one turn in ten).
    if (outboundOpts.project.mode === "intake") { const q = oneQuestion(reply); if (q.trimmed) { reply = q.text; f.push("intake-trimmed"); } }
    // A booking bot ends with "[BOOKING: OFFER]" or "[BOOKING: CONFIRM …]" (YourBots/_prompt/jobs/booking.md).
    // Engine/worker/booking.js takes the line out and does the actual work: lists free
    // times, or books the chosen one. Without a provider configured it only strips the line.
    if (outboundOpts.project.mode === "booking") {
      try {
        const b = await bookingStep(env, outboundOpts.project, reply, { who, history });
        reply = b.reply; f.push(...b.flags); booking = b.booking;
      } catch (err) { console.error("booking step failed (continuing)", err?.message || err); }
    }
  }
  if (reply && fw.llamaGuard) {
    const g = await llamaGuard(env, [{ role: "user", content: "(user message)" }, { role: "assistant", content: reply }]);
    if (g.ran && !g.safe) { f.push("guard-blocked-output:" + g.categories.join(",")); reply = ""; }
  }
  // An empty reply used to become the handoff line with no flag on it, so a turn
  // that failed looked identical to one that went fine — nothing in the audit, nothing
  // in Gaps, nothing to chase. Retry once (the same one degenerate replies get), and
  // if it is still empty, say so in the flags so it lands in D1 and in Under the hood.
  if (!reply) {
    const spentRetry = f.includes("degenerate-reply") || f.includes("degenerate-retried");
    const guardBlocked = f.some((x) => String(x).startsWith("guard-blocked-output"));
    if (!spentRetry && !guardBlocked) {
      let again = "";
      try { again = retry ? String(await retry()).trim() : ""; } catch (err) { console.error("retry after empty reply failed", err?.message || err); }
      if (again && !isDegenerate(again)) { f.push("empty-retried"); reply = screenOutbound(again, outboundOpts).text; }
    }
    if (!reply) {
      f.push(String(raw || "").trim() ? "empty-after-screen" : "empty-reply");
      // Not a decline: the bot did not refuse, it produced nothing. Saying "I can't help
      // with that one" blames the question and tells the visitor nothing they can act on.
      reply = "I didn't manage to put an answer together that time. Ask me again, or give me a bit more to work with.";
    }
  }
  return { reply, flags: f, booking };
}

// --- THE PAPERCLIP: a visitor attaches one file to the conversation. ----------
//     Read it → cut it to size → screen it → hand the TEXT back to the browser.
//     Nothing is stored here: not the file, not the text. The page keeps the
//     text with the chat and sends it back with every message (index.html).
//     The scan is the library's (Engine/worker/library.js), but the verdicts
//     are different: a card number or a key is refused outright (a visitor
//     can't override), while their own email address or phone number is fine.
function attachmentRules() {
  const a = CONFIG.attachments || {};
  return { enabled: a.enabled !== false, max: Math.max(1, Number(a.max) || 1), maxBytes: Number(a.maxBytes) || 4 * 1024 * 1024, maxChars: Number(a.maxChars) || 20000 };
}
// The blocking half of the scan. Emails/phones/"confidential" are the
// visitor's business; these are the things that should never be in a chat.
const ATTACH_BLOCKS = ["card", "ssn", "iban", "secret", "password", "privkey"];
function vetAttachment(text, maxChars) {
  let t = String(text || "");
  const notes = [];
  if (t.length > maxChars) { t = t.slice(0, maxChars) + "\n[truncated]"; notes.push(`Only the first ${maxChars.toLocaleString("en-US")} characters are used; the rest was cut.`); }
  const screen = screenInbound(t);                  // strips invisible characters, looks for "ignore your instructions…"
  t = screen.text;
  if (screen.invisible) notes.push("Hidden characters were removed.");
  if (screen.injection) return { refused: true, flag: "attachment-injection-blocked", reason: "That file contains text that reads like instructions for me (\"ignore your previous instructions…\"), so I can't take it. If it's your own document, remove that part and try again." };
  const found = scanText(t).filter((f) => ATTACH_BLOCKS.includes(f.id));
  if (found.length) return { refused: true, flag: "attachment-secret-blocked", reason: `That file looks like it contains ${found.map((f) => f.label).join(" and ")} — remove it and try again. I don't take card numbers, keys or ID numbers in chat.` };
  return { text: t, notes };
}
async function handleAttach(request, env, ctx, { guard } = {}) {
  if (!(await allowed(env, request))) return json({ ok: false, reason: "You're sending files faster than I can read them. Give me a moment and try again.", flags: ["rate-limited"] }, 429);
  const rules = attachmentRules();
  let form;
  try { form = await request.formData(); } catch { return json({ ok: false, reason: "Send the file as multipart/form-data in a 'file' field." }, 400); }
  const project = await resolveProject(env, String(form.get("project") || ""));
  const door = await guard(project);                                         // the bot's door (the email step is the chat's)
  if (!door.ok) return json({ ok: false, error: door.error, reply: door.reply, reason: door.reply }, door.status);
  const f = form.get("file");
  if (!f || typeof f.arrayBuffer !== "function") return json({ ok: false, reason: "No file in the request." }, 400);
  const log = (chars, flags) => console.log(JSON.stringify({ event: "attach", project: project.name, name: safeName(f.name).slice(0, 120), chars, flags }));

  // 1. Type and size — the library's gate, with its plain-English hints (".pptx → export as PDF").
  const g = gate(f.name, f.size);
  if (!g.ok) { log(0, ["attachment-refused"]); return json({ ok: false, name: safeName(f.name), reason: g.reason, flags: ["attachment-refused"] }, 400); }
  if (f.size > rules.maxBytes) { log(0, ["attachment-refused"]); return json({ ok: false, name: g.name, reason: `That file is ${(f.size / 1048576).toFixed(1)} MB. The limit is ${Math.round(rules.maxBytes / 1048576)} MB.`, flags: ["attachment-refused"] }, 400); }

  // 2. Read it. Text files are decoded; PDFs, Word, sheets and images go
  //    through Cloudflare's converter (an image comes back as a description).
  const isImage = /\.(jpe?g|png|webp|gif|svg|bmp)$/.test(g.ext);
  let text = "";
  try { text = await extractText(env, g.name, g.ext, await f.arrayBuffer()); } catch (err) { console.error("attach: extract failed", err?.message || err); }
  if (!String(text || "").trim()) { log(0, ["attachment-refused"]); return json({ ok: false, name: g.name, reason: isImage ? "I couldn't make out anything in that image. Try a clearer picture, or a PDF." : "I couldn't read any text in that file. If it's a scan, try a clearer copy; if it's a document, try exporting it as PDF.", flags: ["attachment-refused"] }, 400); }

  // 3. Cut, then screen: injections and secrets are refused, with the reason.
  const v = vetAttachment(text, rules.maxChars);
  if (v.refused) { log(text.length, [v.flag]); return json({ ok: false, name: g.name, reason: v.reason, flags: [v.flag] }, 400); }
  const notes = [...v.notes];
  if (isImage) notes.push("Images come back as a description from Cloudflare's converter — what it noticed, not the pixels.");
  log(v.text.length, []);
  return json({ ok: true, name: g.name, chars: v.text.length, text: v.text, notes });
}

// --- VOICE: the mic (speech → text) and the speaker (text → speech). ----------
//     Both are ordinary Workers AI calls (YourBots/config.js → voice). Nothing is
//     stored: the clip is read, sent to the model, and forgotten; the audio that
//     comes back is streamed straight to the visitor's browser. Each half can be
//     off on its own (no model id = that half is off); enabled:false = both are 404.
function voiceRules() {
  const v = CONFIG.voice || {};
  const enabled = v.enabled === true;
  const sttModel = String(v.sttModel || "").trim(), ttsModel = String(v.ttsModel || "").trim();
  return {
    enabled, sttModel, ttsModel,
    in: enabled && Boolean(sttModel), out: enabled && Boolean(ttsModel),
    ttsVoice: String(v.ttsVoice || "").trim(),
    maxSeconds: Math.min(Math.max(Number(v.maxSeconds) || 60, 5), 300),
    maxChars: Math.min(Math.max(Number(v.maxChars) || 1500, 50), 5000),
  };
}
// Whisper wants the clip as a base64 string in `audio`
// (developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo → API schema).
function toBase64(buf) {
  const u = new Uint8Array(buf); let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
// The mic. multipart "audio" (webm/opus from the browser, or wav/mp3) → { text, language }.
// The clip is capped by size rather than by the clock: the page stops recording
// at maxSeconds, and a minute of browser audio is well under a megabyte.
async function handleTranscribe(request, env, { guard } = {}) {
  if (!(await allowed(env, request))) return json({ error: "rate-limited", reason: "You're sending clips faster than I can listen. Give me a moment and try again.", flags: ["rate-limited"] }, 429);
  const v = voiceRules();
  let form;
  try { form = await request.formData(); } catch { return json({ error: "bad request", reason: "Send the clip as multipart/form-data in an 'audio' field." }, 400); }
  const g = await guard(await resolveProject(env, String(form.get("project") || "")));   // the bot's door
  if (!g.ok) return json({ error: g.error, reply: g.reply, reason: g.reply }, g.status);
  if (!env.AI) return json({ error: "no-model", reason: "Voice needs Workers AI (wrangler.jsonc → ai binding)." }, 503);
  const clip = form.get("audio");
  if (!clip || typeof clip.arrayBuffer !== "function") return json({ error: "bad request", reason: "No audio in the request." }, 400);
  const maxBytes = 4 * 1024 * 1024;                         // 4 MB: minutes of opus, a minute or two of wav
  if (clip.size > maxBytes) return json({ error: "too-long", reason: `That clip is too big (${(clip.size / 1048576).toFixed(1)} MB). Keep it under ${v.maxSeconds} seconds.` }, 413);
  if (clip.size < 100) return json({ error: "empty", reason: "I didn't get any audio. Try again." }, 400);
  const started = Date.now();
  let out;
  try {
    out = await env.AI.run(v.sttModel, { audio: toBase64(await clip.arrayBuffer()) });
  } catch (err) {
    console.error("transcribe: model call failed", err?.message || err);
    return json({ error: "model-error", reason: "I couldn't make out that clip. Try again, or type it." }, 502);
  }
  // Whisper's output: text (the transcription), word_count, segments; some builds add language.
  const text = String(out?.text || "").trim();
  const language = String(out?.language || out?.transcription_info?.language || "").trim();
  console.log(JSON.stringify({ event: "transcribe", bytes: clip.size, type: String(clip.type || ""), chars: text.length, language, ms: Date.now() - started }));
  if (!text) return json({ error: "empty", reason: "I couldn't hear any words in that clip. Try again a little closer to the mic." }, 422);
  return json({ text, language });
}
// The speaker. { text } → audio bytes. The reply is a chat message with markdown
// in it, so the marks are taken out first (nobody wants to hear "asterisk asterisk").
function speakable(text, maxChars) {
  let t = String(text || "");
  t = t.replace(/```[\s\S]*?```/g, " ")                    // code blocks: skipped
       .replace(/`([^`]*)`/g, "$1")
       .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")               // images
       .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")             // [label](url) → label
       .replace(/\bhttps?:\/\/\S+/g, " a link ")
       .replace(/^\s{0,3}#{1,6}\s+/gm, "")                  // headings
       .replace(/^\s*[-*•]\s+/gm, "")                       // bullets
       .replace(/(\*\*|__|\*|_|~~)/g, "")
       .replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
  return t.length > maxChars ? t.slice(0, maxChars).replace(/\s+\S*$/, "") : t;
}
async function handleSpeak(request, env, { guard } = {}) {
  if (!(await allowed(env, request))) return json({ error: "rate-limited", reason: "Too many read-outs in a row. Give me a moment and try again.", flags: ["rate-limited"] }, 429);
  const v = voiceRules();
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad request", reason: "Send { text } as JSON." }, 400); }
  const g = await guard(await resolveProject(env, String(body?.project || "")));       // the bot's door
  if (!g.ok) return json({ error: g.error, reply: g.reply, reason: g.reply }, g.status);
  if (!env.AI) return json({ error: "no-model", reason: "Voice needs Workers AI (wrangler.jsonc → ai binding)." }, 503);
  const text = speakable(body?.text, v.maxChars);
  if (!text) return json({ error: "empty", reason: "Nothing to read." }, 400);
  const started = Date.now();
  try {
    // Aura takes { text, speaker }; with returnRawResponse the binding hands back the
    // model's own Response — a stream of MPEG audio — which goes straight to the browser
    // (developers.cloudflare.com/workers-ai/models/aura-1 → Usage, Output).
    const input = { text, ...(v.ttsVoice ? { speaker: v.ttsVoice } : {}) };
    const raw = await env.AI.run(v.ttsModel, input, { returnRawResponse: true });
    console.log(JSON.stringify({ event: "speak", chars: text.length, model: v.ttsModel, voice: v.ttsVoice, ms: Date.now() - started }));
    const headers = { "cache-control": "no-store", "x-spoken-chars": String(text.length) };
    if (raw instanceof Response) {
      if (!raw.ok) { console.error("speak: model returned", raw.status, (await raw.text().catch(() => "")).slice(0, 200)); return json({ error: "model-error", reason: "The voice model didn't answer. Try again." }, 502); }
      headers["content-type"] = raw.headers.get("content-type") || "audio/mpeg";
      return new Response(raw.body, { status: 200, headers });
    }
    // Older bindings ignore returnRawResponse and hand back the bytes or a stream.
    headers["content-type"] = "audio/mpeg";
    return new Response(raw?.audio ? Uint8Array.from(atob(raw.audio), (c) => c.charCodeAt(0)) : raw, { status: 200, headers });
  } catch (err) {
    console.error("speak: model call failed", err?.message || err);
    return json({ error: "model-error", reason: "The voice model didn't answer. Try again." }, 502);
  }
}

// --- After the reply has gone out: tell someone (if configured), then log. ----
// Runs inside ctx.waitUntil, so the visitor never waits for any of it. The
// action runs FIRST and the audit row is written afterwards — on purpose: that
// way the row records what actually happened (handoff-webhook-sent / -failed,
// handoff-email-skipped) instead of a guess, and the only cost is that the row
// lands up to five seconds later. The reply already went out, so the chips on
// the visitor's screen don't show these flags; the Audit tab does.
async function afterReply(env, { project, question, reply, flags, who, history, url, booking = null }) {
  let f = flags;
  try {
    const event = handoffEvent(project, reply, flags);
    if (event) {
      let page = "";
      try { const u = new URL(url); page = `${u.origin}/?project=${encodeURIComponent(project.id || "")}`; } catch {}
      f = [...flags, ...(await runHandoffActions(env, CONFIG, { project, event, question, reply, history, flags, who, url: page, booking }))];
    }
  } catch (err) {
    console.error("handoff action failed (continuing)", err);
  }
  await logTurn(env, project, question, reply, f, who);
  // Leads: after this visitor's Nth turn (config.leads.autoAfterTurns), write
  // the summary and push it to the webhook if the score clears the bar. Runs
  // AFTER the row is logged so the summary sees this turn too.
  const leadFlags = await maybeAutoLead(env, CONFIG, project, who);
  if (leadFlags.length) console.log(JSON.stringify({ event: "lead-auto", visitor: who, flags: leadFlags }));
}

// --- History on any computer (Engine/worker/chats.js). ------------------------------
//   GET    /api/chats?bot=<id>                        → { threads: [...] }
//   PUT    /api/chats/<id>   { bot, title, messages, meta }
//   PATCH  /api/chats/<id>   { bot, title }
//   DELETE /api/chats/<id>?bot=<id>
//   Only for a visitor the server knows (device key → email) on a bot that identifies
//   people (email / allow / key+email). The admin has no identity here: their chats stay
//   in their browser, and they read a visitor's through /api/admin/chats instead.
async function handleChats(request, env, url, { isAdmin, guard, settings }) {
  if (!env.DB) return json({ error: "History needs the D1 database (wrangler.jsonc → d1_databases).", enabled: false }, 503);
  if (!(await allowed(env, request))) return json({ error: "rate-limited" }, 429);
  const id = url.pathname.slice("/api/chats".length).replace(/^\//, "");
  let body = {};
  if (request.method === "PUT" || request.method === "PATCH") { const { body: b, error } = await readJson(request); if (error) return error; body = b; }
  const pid = String(url.searchParams.get("bot") || body.bot || "").toLowerCase();
  const project = await resolveProject(env, pid);
  if (!pid || project.id !== pid) return json({ error: "which bot? send { bot } or ?bot=" }, 400);
  if (cleanKind(project.kind) !== "chat") return json({ error: "not a chat bot" }, 404);
  const a = effectiveAccess(project, settings);
  if (!a.wantEmail) return json({ error: "no identity", enabled: false, reason: "This bot doesn't identify visitors (its access mode has no email), so history stays in the browser." }, 404);
  if (isAdmin) return json({ error: "no identity", enabled: false, reason: "The admin has no visitor identity; admin chats stay in the browser. Use /api/admin/chats to read a visitor's." }, 404);
  let who;
  try { who = await identify(request, env, project); } catch (err) { console.error("identity lookup failed on /api/chats — refusing", err?.message || err); return json({ error: "email", reply: "Please enter your email address to start." }, 401); }
  if (!who.user) return json({ error: "email", reply: "Please enter your email address to start." }, 401);
  const g = await guard(project, { email: who.user.email });
  if (!g.ok) return json({ error: g.error, reply: g.reply, access: g.mode }, g.status);
  // "readonly" after a window closes (YourBots/config.js → expiry.onLapse): reading
  // their own history is the whole point, so GET stays open and everything that
  // CHANGES it is refused. Under "tell" and "silent" the gate above already said no.
  if (g.readOnly && request.method !== "GET") return json({ error: "expired", reply: g.notice, access: g.mode, readOnly: true }, 403);
  try {
    if (request.method === "GET" && !id) return json({ bot: pid, email: who.user.email, threads: await listThreads(env, pid, who.user.id) });
    if (!id) return json({ error: "which thread? /api/chats/<id>" }, 400);
    if (request.method === "PUT") { const r = await putThread(env, pid, who.user.id, id, body); return json(r, r.ok ? 200 : r.status || 400); }
    if (request.method === "PATCH") { const r = await renameThread(env, pid, who.user.id, id, body.title); return json(r, r.ok ? 200 : r.status || 400); }
    if (request.method === "DELETE") { const r = await deleteThread(env, pid, who.user.id, id); return json(r, r.ok ? 200 : r.status || 400); }
    return json({ error: "method" }, 405);
  } catch (err) {
    console.error("chat history request failed", err?.message || err);
    return json({ error: "History hit an error: " + String(err?.message || err).slice(0, 200) }, 500);
  }
}

// --- Leads (admin): the visitors who gave an email, and what they wanted. -------
//   GET  /api/admin/leads?project=<id|*>&limit=100     the list
//   GET  /api/admin/leads/<visitor>                    turns + stored summary
//   POST /api/admin/leads/<visitor>/summarise[?refresh=1]
//   POST /api/admin/leads/<visitor>/send               push to the bot's webhook
async function handleLeads(request, env, url) {
  if (!env.DB) return json({ enabled: false, reason: "No D1 database is bound (wrangler.jsonc → d1_databases), so there is nothing to list. Turns still go to Workers Logs.", rows: [] });
  await ensureSchema(env);
  const parts = url.pathname.split("/").filter(Boolean);        // api, admin, leads, <visitor>, <action>
  const settings = leadsConfig(CONFIG);
  const projectId = String(url.searchParams.get("project") || "*");
  const project = projectId === "*" ? null : await resolveProject(env, projectId);
  try {
    if (parts.length === 3 && request.method === "GET") {
      const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "100", 10) || 100, 1), 500);
      const access = await getSettings(env);
      return json({ ...(await listLeads(env, { projectName: project ? project.name : "*", limit })), settings: { ...settings, webhook: settings.webhook ? "set" : "" }, emailMode: /email/.test(project ? effectiveAccess(project, access).mode : access.default), note: "The summary reads the redacted log (emails, phones and dates inside messages are already replaced). Names are not redacted. The visitor column is the email they typed; nobody verified it." });
    }
    const visitor = cleanVisitor(decodeURIComponent(parts[3] || ""));
    if (!visitor) return json({ error: "which visitor?" }, 400);
    const action = parts[4] || "";
    if (!action && request.method === "GET") { const lead = await getLead(env, CONFIG, visitor); return lead ? json(lead) : json({ error: "no such visitor" }, 404); }
    if (action === "summarise" && request.method === "POST") {
      const lead = await summariseLead(env, CONFIG, visitor, { refresh: ["1", "true"].includes(String(url.searchParams.get("refresh") || "")) });
      return json(lead, lead.error ? 422 : 200);
    }
    if (action === "send" && request.method === "POST") {
      const lead = await getLead(env, CONFIG, visitor);
      if (!lead?.summary) return json({ error: "Summarise first — there is nothing to send yet." }, 400);
      const bot = project || await resolveProject(env, (await resolveList(env)).find((p) => p.name === lead.bot)?.id || "");
      const result = await sendLead(env, CONFIG, lead, { project: bot });
      await logAdminEvent(env, request, "lead-send", visitor, result);
      return json({ result, webhook: bot?.handoffActions?.webhook ? "bot" : settings.webhook ? "config" : "none" }, result === "lead-webhook-failed" ? 502 : 200);
    }
  } catch (err) {
    console.error("leads request failed", err);
    return json({ error: "Leads hit an error: " + String(err?.message || err).slice(0, 200) }, 500);
  }
  return json({ error: "method" }, 405);
}

// --- Gaps (admin): what the bot couldn't answer, as a to-do list. ---------------
//   GET  /api/admin/gaps?project=<id>&days=30&limit=20   the list (counts refreshed on every read)
//   POST /api/admin/gaps/<id>/draft?project=<id>         one model call → a FAQ entry, grounded in the files
//   POST /api/admin/gaps/<id>/accept?project=<id>        body { draft, file } → appended to that file on the SAVED copy
//   POST /api/admin/gaps/<id>/dismiss · /reopen
//   The reading and the model call are in Engine/worker/gaps.js.
async function handleGaps(request, env, url) {
  if (!env.DB) return json({ enabled: false, reason: "No D1 database is bound (wrangler.jsonc → d1_databases), so there is nothing to list. Turns still go to Workers Logs.", rows: [] });
  await ensureSchema(env);
  const parts = url.pathname.split("/").filter(Boolean);        // api, admin, gaps, <id>, <action>
  const bot = String(url.searchParams.get("project") || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 40);
  try {
    if (parts.length === 3) {
      if (request.method !== "GET") return json({ error: "method" }, 405);
      if (!bot) return json({ error: "which bot? add ?project=<id>" }, 400);
      if (!inFolder(bot) && !(await savedProjects(env))[bot]) return json({ error: "unknown bot" }, 404);
      const project = await resolveProject(env, bot);
      return json({ ...(await listGaps(env, { bot, projectName: project.name, days: url.searchParams.get("days"), limit: url.searchParams.get("limit") })), bot, files: Object.keys(project.files || {}), source: (await savedProjects(env))[bot] ? "saved" : (inFolder(bot) ? "folder" : "new"), note: "Questions the bot refused (the firewall's catches are left out). Draft writes from the bot's own files only; blanks mean the files don't say. Add puts the entry on the saved copy — live at once. Commit to GitHub to make the folder the source." });
    }
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    const gap = await getGap(env, parts[3]);
    if (!gap) return json({ error: "no such gap" }, 404);
    const action = parts[4] || "";
    const project = await resolveProject(env, gap.bot);
    if (action === "draft") {
      const d = await draftGap(env, CONFIG, project, gap);
      if (d.error) return json(d, 422);
      const saved = await setGapState(env, gap.id, "drafted", { draft: d.draft, grounded: d.grounded, missing: d.missing });
      console.log(JSON.stringify({ event: "gap-draft", bot: gap.bot, id: gap.id, grounded: d.grounded, missing: d.missing.length }));
      return json({ ...saved, question: gap.question, draft: d.draft, grounded: d.grounded, missing: d.missing });
    }
    if (action === "accept") {
      const { body: b, error } = await readJson(request); if (error) return error;
      const draft = String(b.draft ?? gap.draft ?? "").replace(/<!--[\s\S]*?-->/g, "").trim().slice(0, 4000);
      if (!draft) return json({ error: "nothing to add — draft it first, or send { draft }" }, 400);
      const file = String(b.file || "faq.md").trim();
      if (!/^[\w. -]{1,80}\.(md|txt|csv)$/i.test(file)) return json({ error: "file must be a .md, .txt or .csv name" }, 400);
      // The saved copy: the folder version if there isn't one yet (what Configure → Save
      // starts from), with the entry appended to the chosen file. Live on the next turn.
      const files = { ...(project.files || {}) };
      files[file] = ((files[file] || "").replace(/\s*$/, "") + "\n\n" + draft + "\n").replace(/^\n+/, "");
      const p = await saveProject(env, gap.bot, { ...project, files });
      const saved = await setGapState(env, gap.id, "accepted", { draft, file });
      console.log(JSON.stringify({ event: "gap-accept", bot: gap.bot, id: gap.id, file, chars: draft.length }));
      await logAdminEvent(env, request, "gap-accept", gap.bot, `${draft.length} chars added to ${file} (gap ${gap.id})`);
      return json({ ...saved, ok: true, file, source: "saved", chars: p.files[file]?.length || 0, note: "Live now in the saved copy. Commit to GitHub to make it permanent." });
    }
    if (action === "dismiss") return json(await setGapState(env, gap.id, "dismissed"));
    if (action === "reopen") return json(await setGapState(env, gap.id, "open"));
  } catch (err) {
    console.error("gaps request failed", err);
    return json({ error: "Gaps hit an error: " + String(err?.message || err).slice(0, 200) }, 500);
  }
  return json({ error: "method" }, 405);
}

// --- Talk to a person (visitor side). Engine/worker/person.js has the tables. ---
//   POST /api/handoff                     { project, chatId, transcript, visitor: { email }, note } → { id }
//   GET  /api/handoff/<id>?since=<msgId>  { status, messages } — the page polls this every 10 s
//   POST /api/handoff/<id>/message        { text } → the visitor's reply into the thread
// The id is the visitor's secret: 48 random hex characters, stored with their chat.
async function handlePerson(request, env, ctx, url, { isAdmin = false, guard, visitorOf = async () => "" } = {}) {
  if (!env.DB) return json({ error: "no-database", reply: "Talking to a person isn't switched on here: no database is bound (wrangler.jsonc → d1_databases)." }, 503);
  await ensureSchema(env);
  const parts = url.pathname.split("/").filter(Boolean);        // api, handoff, <id>, <action>
  try {
    if (parts.length === 2) {
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      if (!(await allowed(env, request))) return json({ error: "rate-limited", reply: "Give me a moment and try again." }, 429);
      let b; try { b = await request.json(); } catch { return json({ error: "bad request" }, 400); }
      const project = await resolveProject(env, String(b.project || ""));
      const g = await guard(project, { email: await visitorOf(project) });            // the bot's door, the identity's email included
      if (!g.ok) return json({ error: g.error, reply: g.reply }, g.status);
      const who = g.who;
      const chatId = String(b.chatId || "").replace(/[^\w-]/g, "").slice(0, 40);
      if (!chatId) return json({ error: "chatId is required" }, 400);
      const r = await createHandoff(env, { bot: project.id || CONFIG.defaultProject, chatId, visitor: who, transcript: b.transcript, note: b.note });
      if (r.exists) return json({ error: "already-open", id: r.exists, reply: "You already asked for a person in this chat. They'll reply here." }, 409);
      // The deep link opens under the hood → Conversations on that request (admin code asked for if needed).
      let page = ""; try { const u = new URL(request.url); page = `${u.origin}/?project=${encodeURIComponent(project.id || "")}&handoff=${r.id}`; } catch {}
      console.log(JSON.stringify({ event: "human-requested", project: project.name, who, handoff: r.id }));
      ctx.waitUntil(notifyHumanRequested(env, project, { id: r.id, visitor: who, transcript: r.transcript, note: r.note, url: page }));
      return json({ id: r.id, status: "open", flags: ["human-requested"] }, 201);
    }
    const id = String(parts[2] || "");
    if (!isHandoffId(id)) return json({ error: "no such conversation" }, 404);
    // An existing thread belongs to a bot; that bot's door applies (the email was given when it opened).
    const owner = await env.DB.prepare(`SELECT bot FROM handoffs WHERE id = ?`).bind(id).first();
    if (!owner) return json({ error: "no such conversation" }, 404);
    const g = await guard(await resolveProject(env, String(owner.bot || "")));
    if (!g.ok) return json({ error: g.error, reply: g.reply }, g.status);
    const action = parts[3] || "";
    if (!action && request.method === "GET") {
      const h = await readHandoff(env, id, url.searchParams.get("since"));
      return h ? json(h) : json({ error: "no such conversation" }, 404);
    }
    if (action === "message" && request.method === "POST") {
      if (!(await allowed(env, request))) return json({ error: "rate-limited", reply: "Give me a moment and try again." }, 429);
      let b; try { b = await request.json(); } catch { return json({ error: "bad request" }, 400); }
      const r = await addHandoffMessage(env, id, "visitor", b.text);
      if (r.missing) return json({ error: "no such conversation" }, 404);
      if (r.closed) return json({ error: "closed", status: "closed", reply: "That conversation was closed. I'm the bot again — ask me anything." }, 409);
      if (r.empty) return json({ error: "say something first" }, 400);
      if (r.full) return json({ error: "full", reply: `That's ${PERSON_LIMITS.visitorMessages} messages in this conversation — the most it holds. Start a new chat if you need more.` }, 429);
      return json({ ok: true, message: { id: r.id, from: r.from, text: r.text, created_at: r.created_at }, status: r.status });
    }
  } catch (err) {
    console.error("talk-to-a-person request failed", err);
    return json({ error: "Talk to a person hit an error: " + String(err?.message || err).slice(0, 200) }, 500);
  }
  return json({ error: "method" }, 405);
}

// --- Talk to a person (owner side, admin token). Under the hood → Conversations. ---
//   GET  /api/admin/handoffs?project=<id|*>&status=open|waiting|closed|all&limit=100
//   GET  /api/admin/handoff/<id>              transcript + the whole thread
//   POST /api/admin/handoff/<id>/reply        { text } → into the thread; status → answered
//   POST /api/admin/handoff/<id>/close        the bot takes over again on the visitor's page
async function handlePersonAdmin(request, env, url) {
  if (!env.DB) return json({ enabled: false, reason: "No D1 database is bound (wrangler.jsonc → d1_databases), so there is nowhere to keep a conversation. The button on the chat page says so too.", rows: [], openCount: 0 });
  await ensureSchema(env);
  const parts = url.pathname.split("/").filter(Boolean);        // api, admin, handoffs | api, admin, handoff, <id>, <action>
  try {
    if (parts[2] === "handoffs") {
      if (request.method !== "GET") return json({ error: "method" }, 405);
      const bot = String(url.searchParams.get("project") || "*").toLowerCase().replace(/[^a-z0-9*-]+/g, "-").slice(0, 40) || "*";
      const status = String(url.searchParams.get("status") || "waiting");
      const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "100", 10) || 100, 1), 500);
      const list = await listHandoffs(env, { bot, status, limit });
      const names = {}; for (const r of list.rows) if (!(r.bot in names)) names[r.bot] = (await resolveProject(env, r.bot)).name || r.bot;
      return json({ enabled: true, ...list, rows: list.rows.map((r) => ({ ...r, botName: names[r.bot] })), limits: PERSON_LIMITS, note: "The transcript (the chat before they pressed the button) is redacted like the audit log. The thread itself is not: a phone number the visitor gives you here is the point. The visitor column is what they typed at the door; nobody verified it." });
    }
    const id = String(parts[3] || "");
    if (!isHandoffId(id)) return json({ error: "no such conversation" }, 404);
    const action = parts[4] || "";
    if (!action && request.method === "GET") {
      const h = await getHandoff(env, id);
      return h ? json({ ...h, botName: (await resolveProject(env, h.bot)).name || h.bot, limits: PERSON_LIMITS }) : json({ error: "no such conversation" }, 404);
    }
    if (action === "reply" && request.method === "POST") {
      const { body: b, error } = await readJson(request); if (error) return error;
      const r = await addHandoffMessage(env, id, "owner", b.text);
      if (r.missing) return json({ error: "no such conversation" }, 404);
      if (r.closed) return json({ error: "That conversation is closed. The visitor's page has gone back to the bot." }, 409);
      if (r.empty) return json({ error: "write something first" }, 400);
      await logAdminEvent(env, request, "handoff-reply", id, `${String(r.text || "").length} chars`);
      return json({ ok: true, message: { id: r.id, from: r.from, text: r.text, created_at: r.created_at }, status: r.status });
    }
    if (action === "close" && request.method === "POST") {
      const done = await closeHandoff(env, id);
      if (done) await logAdminEvent(env, request, "handoff-close", id, "");
      return done ? json({ ok: true, status: "closed" }) : json({ ok: false, error: "already closed, or no such conversation" }, 409);
    }
  } catch (err) {
    console.error("conversations request failed", err);
    return json({ error: "Conversations hit an error: " + String(err?.message || err).slice(0, 200) }, 500);
  }
  return json({ error: "method" }, 405);
}

// One character over and over, or one word over and over, is not an answer.
function isDegenerate(text) {
  const t = String(text).trim();
  if (t.length < 12) return false;
  const chars = t.replace(/\s+/g, "");
  const top = [...new Set(chars)].map((c) => chars.split(c).length - 1).sort((a, b) => b - a)[0] || 0;
  if (top / chars.length > 0.8) return true;                         // "!!!!!!!!!!!!"
  const words = t.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 8) return false;
  const counts = {}; for (const w of words) counts[w] = (counts[w] || 0) + 1;
  return Math.max(...Object.values(counts)) / words.length > 0.6;     // "Quick Quick Quick Quick…"
}

// --- Audit log (optional D1). Fail-open: no DB bound = no logging. ------------
// The single most useful thing your bot produces is a record of what people
// asked and what it couldn't answer. Every refusal is a page your site should have.
async function logTurn(env, project, question, answer, flags, who = "") {
  const refused = flags.some((f) => /blocked|error|empty/.test(f)) || answer.includes("rather not guess") || answer.includes("don't have a solid answer");
  // Always goes to Workers Logs (dashboard → Worker → Logs). The visitor email is
  // kept on purpose in email mode; the question and answer are redacted.
  console.log(JSON.stringify({ event: "turn", project: project.name, who, refused, flags, asked: redact(question).slice(0, 200) }));
  if (!env.DB) return;
  try {
    await ensureSchema(env);
    await env.DB.prepare(
      `INSERT INTO conversations (project, visitor, asked, answered, refused, flags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(project.name, who, redact(question), redact(answer), refused ? 1 : 0, flags.join(","), new Date().toISOString()).run();
  } catch (err) {
    console.error("log failed (continuing)", err);
  }
}

// --- Saved projects, normalising, resolving: Engine/worker/projects.js (one loader for every kind).

// --- The library: this bot's documents in AI Search. Admin only; every upload
//     is scanned first (Engine/worker/library.js). ---------------------------------
async function handleLibrary(request, env, url) {
  const raw = String(url.searchParams.get("project") || "");
  // The audit needs D1, not AI Search, and takes "*" for every bot — so it goes first.
  if (request.method === "GET" && url.pathname === "/api/admin/library/audit") return json(await libraryAudit(env, raw, url.searchParams.get("limit")));
  const bot = raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 40);
  if (!bot) return json({ error: "which bot? add ?project=<id>" }, 400);
  const meta = libraryMeta(env, CONFIG);
  if (!meta.enabled) return json({ error: "The library isn't switched on: wrangler.jsonc needs the ai_search_namespaces binding and YourBots/config.js → library.name. See docs/CUSTOMIZE.md → Give it documents.", ...meta }, 503);
  try {
    // --- The website: GET = where it stands · POST = crawl now · DELETE = forget it.
    //     The URL comes from the saved bot; the form can send an unsaved one in the
    //     body so "Crawl now" works before "Save" (the chat only uses it once saved).
    if (url.pathname === "/api/admin/library/crawl") {
      const project = await resolveProject(env, bot);
      let site = websiteOf(project);
      if (request.method === "POST") {
        let b = {}; try { b = await request.json(); } catch {}
        if (b && typeof b.website === "object") site = websiteOf({ website: normaliseWebsite(b.website) }) || site;
        if (!site) return json({ error: "This bot has no website URL. Configure → Website, or project.json → website.url." }, 400);
        const r = await crawlWebsite(env, CONFIG, bot, site);
        console.log(JSON.stringify({ event: "website-crawl", bot, url: site.url, instance: r.name, created: r.created, recreated: r.recreated }));
        return json({ ok: true, ...r, status: await websiteStatus(env, CONFIG, bot, site) });
      }
      if (request.method === "DELETE") return json({ ok: true, removed: await deleteWebsite(env, CONFIG, bot) });
      if (request.method === "GET") return json(await websiteStatus(env, CONFIG, bot, site));
      return json({ error: "method" }, 405);
    }
    if (request.method === "GET" && url.pathname === "/api/admin/library") return json({ ...meta, files: await listFiles(env, CONFIG, bot) });
    if (request.method === "POST" && url.pathname === "/api/admin/library") {
      const form = await request.formData();
      const files = form.getAll("file").filter((f) => f && typeof f.arrayBuffer === "function");
      if (!files.length) return json({ error: "No file in the request. Send multipart/form-data with a 'file' field." }, 400);
      const override = ["1", "true", "yes"].includes(String(form.get("override") || "").toLowerCase());
      const source = String(form.get("source") || "upload");   // "github" = the sync action owns it
      const who = source === "github" ? "github" : "admin";     // the only two things that upload today
      const results = [];
      for (const f of files.slice(0, 10)) {
        const res = await uploadFile(env, CONFIG, bot, f.name, await f.arrayBuffer(), { override, source });
        // The override is the one thing worth a permanent line in the logs.
        if (override && res.ok) console.log(JSON.stringify({ event: "library-override", bot, file: res.name }));
        // …and every outcome gets a row in the audit table (when D1 is bound).
        if (res.ok) await logLibraryEvent(env, bot, res.name, override ? "override" : "upload", "", who);
        else if (res.needsOverride) await logLibraryEvent(env, bot, res.name, "held", JSON.stringify(res.flagged), who);
        results.push(res);
      }
      await logAdminEvent(env, request, "library-upload", bot, results.map((r) => `${r.name || "?"}: ${r.ok ? (override ? "put in (override)" : "put in") : r.needsOverride ? "held" : "refused"}`).join("; "));
      return json({ results });
    }
    // Scan again: every document, same checks as an upload, nothing changed.
    if (request.method === "POST" && url.pathname === "/api/admin/library/rescan") {
      const r = await rescanLibrary(env, CONFIG, bot);
      for (const f of r.results) if (f.flagged.length) await logLibraryEvent(env, bot, f.name, "rescan-held", JSON.stringify(f.flagged), "admin");
      await logAdminEvent(env, request, "library-rescan", bot, `${r.scanned} scanned, ${r.results.filter((f) => f.flagged.length).length} with findings`);
      return json({ ...r, scanWithModel: meta.scanWithModel });
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/api/admin/library/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/admin/library/".length));
      const gone = await deleteFile(env, CONFIG, bot, id);
      if (!gone) return json({ error: "no such file for this bot" }, 404);
      await logLibraryEvent(env, bot, gone.name, "remove", "", "admin");
      await logAdminEvent(env, request, "library-delete", bot, gone.name);
      return json({ ok: true });
    }
    // The original file back out (admin only) — what Commit to GitHub writes into the repo.
    if (request.method === "GET" && /^\/api\/admin\/library\/[^/]+\/download$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split("/")[4]);
      const d = await downloadFile(env, CONFIG, bot, id);
      if (!d) return json({ error: "no such file for this bot" }, 404);
      return new Response(d.bytes, { headers: { "content-type": d.contentType || "application/octet-stream", "content-disposition": `attachment; filename="${d.name.split("/").pop().replace(/"/g, "")}"` } });
    }
  } catch (err) {
    console.error("library request failed", err);
    return json({ error: "The library hit an error: " + String(err?.message || err).slice(0, 200) }, 500);
  }
  return json({ error: "method" }, 405);
}
// --- The scan's own record. What was held, what was put in anyway, what was
//     removed — durable, in D1, next to the conversations. Fail-open: no DB, no
//     row, no error. Workers Logs still get the override line above.
//     event: held | override | upload | remove | rescan-held
//     detail: for held/rescan-held, the JSON list the admin was shown (labels, counts, masked samples)
//     who: "admin" (Configure) or "github" (the sync action)
async function logLibraryEvent(env, bot, file, event, detail = "", who = "admin") {
  if (!env.DB) return;
  try {
    await ensureSchema(env);
    await env.DB.prepare(`INSERT INTO library_events (bot, file, event, detail, who, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(bot, file, event, String(detail || "").slice(0, 4000), who, new Date().toISOString()).run();
  } catch (err) { console.error("library event log failed (continuing)", err?.message || err); }
}

// GET /api/admin/library/audit?project=<bot>&limit=100 — newest first. project=* for every bot.
async function libraryAudit(env, project, limitRaw) {
  if (!env.DB) return { enabled: false, rows: [], reason: "No D1 database is bound (wrangler.jsonc → d1_databases). Overrides still go to Workers Logs." };
  await ensureSchema(env);
  const limit = Math.min(Math.max(parseInt(limitRaw || "100", 10) || 100, 1), 500);
  const all = !project || project === "*";
  const bot = project.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 40);
  const sql = `SELECT id, bot, file, event, detail, who, created_at FROM library_events ${all ? "" : "WHERE bot = ?"} ORDER BY id DESC LIMIT ?`;
  const stmt = all ? env.DB.prepare(sql).bind(limit) : env.DB.prepare(sql).bind(bot, limit);
  const rows = ((await stmt.all()).results || []).map((r) => { let detail = []; try { detail = r.detail ? JSON.parse(r.detail) : []; } catch { detail = []; } return { ...r, detail }; });
  return { enabled: true, rows };
}

// resolveList / pickPublic: Engine/worker/projects.js.

// The audit table creates itself the first time it's needed (no schema step for
// attendees). Engine/schema.sql is the same DDL, kept for reading; this is the source.
let SCHEMA_OK = false;
async function ensureSchema(env) {
  if (SCHEMA_OK || !env.DB) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT, visitor TEXT, asked TEXT, answered TEXT, refused INTEGER DEFAULT 0, flags TEXT, created_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_conv_created ON conversations(created_at)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_conv_refused ON conversations(refused)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    // What the document scan did: held / override / upload / remove / rescan-held. See logLibraryEvent.
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS library_events (id INTEGER PRIMARY KEY AUTOINCREMENT, bot TEXT, file TEXT, event TEXT NOT NULL, detail TEXT, who TEXT, created_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_libev_bot ON library_events(bot, id)`),
    // Leads: one row per visitor email, with the stored AI summary. See Engine/worker/leads.js.
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS leads (visitor TEXT PRIMARY KEY, bot TEXT, summary TEXT, score INTEGER, updated_at TEXT NOT NULL, turns_at_summary INTEGER DEFAULT 0, sent_at TEXT)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_conv_visitor ON conversations(visitor, id)`),
    // Gaps: one row per refused question per bot, with its state (open / drafted / accepted / dismissed). See Engine/worker/gaps.js.
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS gaps (id INTEGER PRIMARY KEY AUTOINCREMENT, bot TEXT NOT NULL, question_key TEXT NOT NULL, question TEXT, count_seen INTEGER DEFAULT 0, last_seen TEXT, state TEXT NOT NULL DEFAULT 'open', draft TEXT, grounded INTEGER, missing TEXT, file TEXT, updated_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_gaps_bot_key ON gaps(bot, question_key)`),
    // Talk to a person: one row per request, and the thread. See Engine/worker/person.js.
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS handoffs (id TEXT PRIMARY KEY, bot TEXT, chat_id TEXT, visitor TEXT, transcript TEXT, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_handoffs_status ON handoffs(status, updated_at)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_handoffs_chat ON handoffs(bot, chat_id, status)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS handoff_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, handoff_id TEXT NOT NULL, from_role TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_hmsg_handoff ON handoff_messages(handoff_id, id)`),
    // Settings: one row per key. "access" holds { default, floor } from the Settings screen. See loadSettings.
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT)`),
    // Admin events: every write the admin makes, with a hash of the IP (never the IP). See logAdminEvent.
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS admin_events (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, target TEXT, detail TEXT, who TEXT, ip_hash TEXT, created_at TEXT NOT NULL, subject TEXT)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_adminev_created ON admin_events(id)`),
  ]);
  // History on any computer (Engine/worker/chats.js) and the allowlist (Engine/worker/allowlist.js) make their own.
  await ensureChatSchema(env);
  await ensureExpirySchema(env);   // the ALTERs for id_users / allowlist / admin_events, once the tables above exist
  SCHEMA_OK = true;
}

// Demo mode off and the guide hidden: a visit with no ?project= must not land on the hidden
// guide ("Five short stops…" with no stops). It lands on the first bot a visitor can see.
// Any other case returns "" and the default project is used, exactly as before.
async function landingProject(env, settings) {
  if (settings.demo?.tour !== false) return "";
  try {
    const def = await resolveProject(env, CONFIG.defaultProject);
    if (!def?.tour || effectiveAccess(def, settings).listed) return "";
    const showDemoBots = settings.demo?.bots !== false;
    for (const p of await resolveList(env)) {
      if (p.id === CONFIG.defaultProject || p.sandbox || p.tour) continue;
      if (!showDemoBots && p.demo) continue;
      const a = effectiveAccess(p, settings);
      if (a.listed && a.mode !== "draft" && cleanKind(p.kind) === "chat") return p.id;
    }
  } catch (err) { console.error("landing fallback failed (using the default)", err?.message || err); }
  return "";
}
// Has a model call gone through the AI Gateway? This isolate's last call if it has made one,
// else the newest answered turn on the record. "unknown" = nothing to go on yet.
async function gatewaySeen(env) {
  const id = CONFIG.gateway?.id || "";
  if (!id) return { id, state: "off" };
  const live = gatewayStatus(CONFIG).lastCall;
  if (live === "via gateway") return { id, state: "ok" };
  if (live === "direct (gateway missing)") return { id, state: "missing" };
  if (env.DB) try {
    await ensureSchema(env);
    const rows = (await env.DB.prepare(`SELECT flags FROM conversations WHERE answered != '' ORDER BY id DESC LIMIT 30`).all()).results || [];
    for (const r of rows) {
      const f = String(r.flags || "");
      if (/gateway-direct/.test(f)) return { id, state: "missing" };
      if (!/blocked|rate-limited|model-error|declined/.test(f)) return { id, state: "ok" };
    }
  } catch {}
  return { id, state: "unknown" };
}

// --- Settings: Engine/worker/settings.js (config.js < settings.json < D1). ------------------
// Under the hood → Settings: what applies, where it came from, and every bot's effective mode (and why).
async function settingsView(env, settings) {
  const bots = [];
  const counts = await allowlistCounts(env);
  for (const p of await resolveList(env)) {
    const full = await resolveProject(env, p.id);
    const a = effectiveAccess(full, settings);
    const m = signInMethods(full, env);
    const signIn = full.kind === "chat" ? (a.wantEmail ? `email + device key${a.wantList ? " · on the allowlist" : ""}` : "") : ["email + device key", m.passkeys ? "passkeys" : "", ...m.providers.map((x) => `sign in with ${x.provider}`), m.totp ? "authenticator code" : "", "owner links a device"].filter(Boolean).join(" · ");
    bots.push({ id: p.id, tour: Boolean(full.tour && Array.isArray(full.tour.stops) && full.tour.stops.length), demo: full.demo === true || p.demo === true, kind: cleanKind(full.kind), href: hrefFor(full), name: p.name, access: a.botMode, effective: a.mode, reason: a.reason, listed: a.listed, source: p.source, ownKey: a.keyName ? (env[a.keyName] ? `${a.keyName} (set)` : `${a.keyName} (NOT set — the shared key is used)`) : "", signIn, graceMinutes: full.identity?.graceMinutes, allowlisted: counts[p.id] || 0, expiry: expiryFor(full, settings) });
  }
  return {
    access: { default: settings.default, floor: settings.floor },
    createYourOwn: settings.createYourOwn,
    signup: settings.signup,
    brand: settings.brand,
    keyPrefix: settings.keys,                        // Settings → Workshop keys (the rows with an end date are `keys`, below)
    identity: { graceMinutes: settings.identity?.graceMinutes, source: settings.identity?.source },
    allowlist: { keySet: allowlistKeySet(env), counts, global: counts[GLOBAL_SCOPE] || 0 },
    // When access runs out: the policy, everyone who currently has an end date, and
    // the passphrases that have one. Engine/worker/expiry.js.
    expiry: settings.expiry || EXPIRY_BUILT_IN,
    expiryModes: LAPSE_MODES.map((id) => ({ id, line: LAPSE_LINES[id] })),
    dated: env.DB ? await datedPeople(env) : [],
    keys: env.DB ? await keyRows(env) : [],
    breakGlass: Boolean(breakGlassKey(env)),
    source: settings.source,
    file: SETTINGS_FILE?.access || {},
    adminTotp: adminNeedsCode(env),
    // Demo mode (the tour strip, the sample bots), the guide bot, and whether the gateway has been seen working.
    demo: { tour: settings.demo?.tour !== false, bots: settings.demo?.bots !== false },
    guide: (() => { const g = bots.find((x) => x.tour); return g ? { id: g.id, name: g.name, listed: g.listed } : null; })(),
    sampleBots: bots.filter((x) => x.demo).map((x) => x.name),
    gateway: await gatewaySeen(env),
    pepperSet: Boolean(env.FOODLOG_PEPPER),          // user ids are salted with a real secret, not the dev pepper
    modes: ACCESS_MODES.map((id) => ({ id, line: MODE_LINES[id] })),
    order: ACCESS_MODES.join(" < "),
    sharedKey: Boolean(env.ACCESS_PASSPHRASE),
    adminTokenVersion: String(env.ADMIN_TOKEN_VERSION || "1"),
    canSave: Boolean(env.DB),
    github: { repo: repoOf(env), branch: CONFIG.github?.branch || "main", ready: Boolean(repoOf(env) && env.GITHUB_TOKEN), source: env.GITHUB_REPO ? "GITHUB_REPO secret" : CONFIG.github?.repo ? "YourBots/config.js" : "unset" },
    bots,
    note: "A bot's effective mode is the stricter of what it says (or the default) and the floor. The floor is the panic switch: set it to key and every bot needs the passphrase, whatever its file says. Save is live at once; Commit to GitHub writes YourBots/settings.json so the repo carries it.",
  };
}
// Settings → Commit to GitHub: one file, YourBots/settings.json, via the Contents API.
async function syncSettingsToGitHub(env, settings) {
  const repo = repoOf(env), branch = CONFIG.github?.branch || "main";
  if (!repo) return { error: "No repo: set the GITHUB_REPO secret (or YourBots/config.js → github.repo)" };
  if (!env.GITHUB_TOKEN) return { error: "GITHUB_TOKEN secret is not set (fine-grained token, Contents: read & write, only this repo)" };
  const path = "YourBots/settings.json";
  const content = settingsFileContent(settings);
  const gh = async (p, init = {}) => {
    const r = await fetch(`https://api.github.com/repos/${repo}/${p}`, { ...init, headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "bot-you-own", "content-type": "application/json", ...(init.headers || {}) } });
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
  };
  const cur = await gh(`contents/${path}?ref=${encodeURIComponent(branch)}`);
  const sha = cur.ok && cur.body?.sha ? cur.body.sha : "";
  if (sha && cur.body?.content && atob(String(cur.body.content).replace(/\n/g, "")) === content) return { ok: true, repo, branch, path, unchanged: true, note: "The repo already has these settings." };
  const r = await gh(`contents/${path}`, { method: "PUT", body: JSON.stringify({ message: `${sha ? "update" : "add"} ${path} (from Settings)`, content: btoa(unescape(encodeURIComponent(content))), branch, ...(sha ? { sha } : {}) }) });
  if (!r.ok) return { error: `${r.status} ${r.body?.message || "GitHub refused the commit"}`, repo, branch, path };
  return { ok: true, repo, branch, path, commitUrl: r.body?.commit?.html_url || "", note: "YourBots/settings.json is in the repo. If it is connected to Workers Builds this redeploys in about a minute; the saved row stays live meanwhile and still wins — the file is the fallback when the database has no row." };
}

// --- Admin events: what changed, and when. Every write the admin makes gets a
//     row: the action, what it touched, a one-line detail, and a SHA-256 of the
//     caller's IP — never the IP itself. Fail-open: no DB, no row, no error.
async function sha256Hex(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// `subject` is WHO the event is about (an email address), as opposed to `target`
// which is what was touched (a bot, a file). Access events fill it in, and that is
// what makes "show me everything that happened to this person" one indexed read —
// Under the hood → Settings → Access over time. Everything else leaves it empty.
async function logAdminEvent(env, request, action, target = "", detail = "", subject = "") {
  console.log(JSON.stringify({ event: "admin", action, target: String(target).slice(0, 200), detail: String(detail).slice(0, 300), subject: String(subject).slice(0, 254) }));
  if (!env.DB) return;
  try {
    await ensureSchema(env);
    await ensureExpirySchema(env);
    const ip = request?.headers?.get("cf-connecting-ip") || "";
    await env.DB.prepare(`INSERT INTO admin_events (action, target, detail, who, ip_hash, created_at, subject) VALUES (?, ?, ?, 'admin', ?, ?, ?)`)
      .bind(String(action).slice(0, 60), String(target).slice(0, 200), String(detail).slice(0, 2000), ip ? await sha256Hex(ip) : "", new Date().toISOString(), String(subject || "").toLowerCase().slice(0, 254)).run();
  } catch (err) { console.error("admin event log failed (continuing)", err?.message || err); }
}
// GET /api/admin/events?limit=100 — newest first.
async function adminEvents(env, limitRaw) {
  if (!env.DB) return { enabled: false, rows: [], reason: "No D1 database is bound (wrangler.jsonc → d1_databases). Admin writes still go to Workers Logs." };
  await ensureSchema(env);
  const limit = Math.min(Math.max(parseInt(limitRaw || "100", 10) || 100, 1), 500);
  await ensureExpirySchema(env);
  const rows = (await env.DB.prepare(`SELECT id, action, target, detail, who, ip_hash, created_at, subject FROM admin_events ORDER BY id DESC LIMIT ?`).bind(limit).all()).results || [];
  return { enabled: true, rows, note: "ip_hash is a SHA-256 of the caller's IP address; the address itself is never stored." };
}

// Under the hood → Audit. Who asked what, what the bot said, what the firewall did.
async function auditView(env, q) {
  if (!env.DB) return { enabled: false, reason: "No D1 database is bound (wrangler.jsonc → d1_databases). Turns still go to Workers Logs." };
  await ensureSchema(env);
  const project = String(q.get("project") || "");
  const filter = String(q.get("filter") || "all");           // all | refused | flagged | visitor:<email>
  const limit = Math.min(Math.max(parseInt(q.get("limit") || "50", 10) || 50, 1), 200);
  const where = []; const args = [];
  if (project && project !== "*") { const meta = await resolveProject(env, project); where.push("project = ?"); args.push(meta.name); }
  if (filter === "refused") where.push("refused = 1");
  if (filter === "flagged") where.push("flags != ''");
  if (filter.startsWith("visitor:")) { where.push("visitor = ?"); args.push(filter.slice(8).toLowerCase()); }
  const W = where.length ? "WHERE " + where.join(" AND ") : "";
  const rows = (await env.DB.prepare(`SELECT id, project, visitor, asked, answered, refused, flags, created_at FROM conversations ${W} ORDER BY id DESC LIMIT ?`).bind(...args, limit).all()).results || [];
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const stats = (await env.DB.prepare(`SELECT COUNT(*) turns, SUM(refused) refused, SUM(CASE WHEN flags != '' THEN 1 ELSE 0 END) flagged, COUNT(DISTINCT visitor) visitors FROM conversations WHERE created_at >= ?`).bind(since).first()) || {};
  const top = (await env.DB.prepare(`SELECT asked, COUNT(*) n FROM conversations WHERE refused = 1 AND created_at >= ? GROUP BY asked ORDER BY n DESC LIMIT 10`).bind(since).all()).results || [];
  return { enabled: true, rows, stats: { ...stats, since }, topRefused: top, note: "Emails, phone numbers and dates inside questions and answers are redacted before storage. Names are not. The visitor column is kept on purpose in email mode." };
}

// --- Commit a bot's folder to GitHub (Contents API). One commit per file; files
//     that no longer exist in the bot are deleted from the folder. Needs the
//     GITHUB_TOKEN secret (fine-grained, Contents read/write, this repo only).
// exportFiles: Engine/worker/projects.js (project.json for every kind; the chat files for chat bots).
async function syncToGitHub(env, id) {
  const repo = repoOf(env), branch = CONFIG.github?.branch || "main";
  if (!repo) return { error: "No repo: set the GITHUB_REPO secret (or YourBots/config.js → github.repo)" };
  if (!env.GITHUB_TOKEN) return { error: "GITHUB_TOKEN secret is not set (fine-grained token, Contents: read & write, only this repo)" };
  const p = await resolveProject(env, id);
  if (!p || p.id !== id) return { error: "unknown bot" };
  const want = exportFiles(p, id);                    // text: project.json, instructions, knowledge/*.md|txt|csv, prompt/*
  const gh = async (path, init = {}) => {
    const r = await fetch(`https://api.github.com/repos/${repo}/${path}`, { ...init, headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "bot-you-own", "content-type": "application/json", ...(init.headers || {}) } });
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body };
  };
  // existing files in the folder → sha map (and what to delete)
  const existing = {};
  const walk = async (dir) => {
    const r = await gh(`contents/${dir}?ref=${encodeURIComponent(branch)}`);
    if (!r.ok || !Array.isArray(r.body)) return;
    for (const e of r.body) { if (e.type === "file") existing[e.path] = e.sha; else if (e.type === "dir") await walk(e.path); }
  };
  await walk(`YourBots/${id}`);

  // --- The library's documents ride along, so the folder holds the same PDFs
  //     the bot answers from. Each one is the original bytes, written under
  //     knowledge/. Overrides go into knowledge/APPROVED.txt so the sync action
  //     (which re-scans everything it uploads) doesn't hold them back again.
  const docs = {};                                    // path → { bytes }
  const docErrors = [];
  let approvedNames = [];
  if (p.kind === "chat" && libraryMeta(env, CONFIG).enabled) {
    try {
      for (const f of await listFiles(env, CONFIG, id)) {
        if (f.status === "error" || f.status === "skipped") { docErrors.push(`${f.name}: not committed (status ${f.status})`); continue; }
        try {
          const d = await downloadFile(env, CONFIG, id, f.id);
          if (d) { docs[`YourBots/${id}/knowledge/${f.name}`] = { bytes: d.bytes }; if (f.approved) approvedNames.push(f.name); }
        } catch (err) { docErrors.push(`${f.name}: download failed (${String(err?.message || err).slice(0, 80)})`); }
      }
    } catch (err) { docErrors.push(`library list failed: ${String(err?.message || err).slice(0, 120)}`); }
  }
  const approvedPath = `YourBots/${id}/knowledge/APPROVED.txt`;
  if (approvedNames.length) {
    let current = "";
    if (existing[approvedPath]) { const r = await gh(`contents/${approvedPath}?ref=${encodeURIComponent(branch)}`); if (r.ok && r.body?.content) current = atob(String(r.body.content).replace(/\n/g, "")); }
    const lines = current.split(/\r?\n/);
    const have = new Set(lines.map((l) => l.trim()));
    const add = approvedNames.filter((n) => !have.has(n));
    if (add.length) want[approvedPath] = (current.trim() ? current.replace(/\s*$/, "\n") : "# Files the upload scan held back and you approved. One filename per line.\n") + add.join("\n") + "\n";
  }

  const b64 = (s) => btoa(unescape(encodeURIComponent(s)));
  const b64bytes = (buf) => { const u = new Uint8Array(buf); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  // git's blob id, so an unchanged PDF isn't re-committed every time.
  const blobSha = async (buf) => { const head = new TextEncoder().encode(`blob ${buf.byteLength}\0`); const all = new Uint8Array(head.length + buf.byteLength); all.set(head); all.set(new Uint8Array(buf), head.length); return [...new Uint8Array(await crypto.subtle.digest("SHA-1", all))].map((b) => b.toString(16).padStart(2, "0")).join(""); };

  const committed = [], unchanged = [], deleted = [], errors = [...docErrors];
  let lastCommit = "";
  const put = async (path, content, isText) => {
    const r = await gh(`contents/${path}`, { method: "PUT", body: JSON.stringify({ message: `${existing[path] ? "update" : "add"} ${path} (from Configure)`, content, branch, ...(existing[path] ? { sha: existing[path] } : {}) }) });
    if (r.ok) { committed.push(path); lastCommit = r.body?.commit?.html_url || lastCommit; }
    else if (r.status === 422 && /same/i.test(JSON.stringify(r.body))) unchanged.push(path);
    else errors.push(`${path}: ${r.status} ${r.body?.message || ""}`);
  };
  for (const [path, content] of Object.entries(want)) await put(path, b64(content), true);
  for (const [path, { bytes }] of Object.entries(docs)) {
    if (existing[path] && existing[path] === (await blobSha(bytes))) { unchanged.push(path); continue; }
    await put(path, b64bytes(bytes), false);
  }

  // Delete what the form no longer has. Text files and prompt overrides are fully
  // represented above, so a missing one was removed on purpose. Documents are
  // deleted only when the library was read successfully (otherwise a hiccup in
  // AI Search would wipe the repo's PDFs). APPROVED.txt is never deleted.
  const libraryRead = libraryMeta(env, CONFIG).enabled && !docErrors.some((e) => e.startsWith("library list failed"));
  const isText = (path) => /\.(md|txt|csv|json)$/i.test(path);
  const leftAlone = [];
  for (const path of Object.keys(existing)) {
    if (want[path] || docs[path] || path === approvedPath) continue;
    const doc = path.startsWith(`YourBots/${id}/knowledge/`) && !isText(path);
    if (doc && !libraryRead) { leftAlone.push(path); continue; }
    const r = await gh(`contents/${path}`, { method: "DELETE", body: JSON.stringify({ message: `remove ${path} (from Configure)`, sha: existing[path], branch }) });
    if (r.ok) { deleted.push(path); lastCommit = r.body?.commit?.html_url || lastCommit; } else errors.push(`delete ${path}: ${r.status}`);
  }
  return { ok: errors.length === 0, repo, branch, committed, deleted, unchanged, leftAlone, documents: Object.keys(docs).length, errors, commitUrl: lastCommit, note: "The folder is now in the repo, documents included. If the repo is connected to Cloudflare Workers Builds, this commit redeploys the bot in about a minute, and the Sync library action re-files the documents from the repo (they show as 'from GitHub' afterwards — the repo is now their source). The saved copy stays live meanwhile; remove it once the deploy lands so the folder is the single source." };
}

// The version stamp written by scripts/snapshot-src.mjs at build time.
let VERSION_CACHE = null;
async function versionStamp(env) {
  if (VERSION_CACHE) return VERSION_CACHE;
  try { VERSION_CACHE = await (await env.ASSETS.fetch(new Request("https://x/version.json"))).json(); }
  catch { VERSION_CACHE = { version: "dev", builtAt: "", commit: "" }; }
  return VERSION_CACHE;
}

// "Under the hood": everything the admin view shows, for one project.
async function engineView(env, projectId) {
  const settings = await getSettings(env);
  const project = await resolveProject(env, String(projectId || ""));
  const prompt = buildSystemPrompt({ config: { ...CONFIG, owner: settings.brand?.owner || CONFIG.owner, siteName: settings.brand?.siteName || CONFIG.siteName }, project, bookingLive: bookingLive(env, project) });
  let sources = [];
  try { sources = await (await env.ASSETS.fetch(new Request("https://x/engine/index.json"))).json(); } catch {}
  const { files, instructions, ...meta } = project;
  const libMeta = libraryMeta(env, CONFIG);
  const library = { ...libMeta, name: CONFIG.library?.name || "", files: [] };
  if (libMeta.enabled) { try { library.files = await listFiles(env, CONFIG, project.id || String(projectId || "")); } catch (err) { library.error = String(err?.message || err); } }
  // the website crawl, if this bot has one (null = no URL set)
  library.website = websiteOf(project) ? await websiteStatus(env, CONFIG, project.id || String(projectId || ""), websiteOf(project)) : null;
  return {
    project: { id: projectId, ...meta, instructions },
    library,
    prompt: prompt.text,
    promptFiles: PROMPT_FILES.map((f) => f.replace("<mode>", project.mode || "answer")),
    promptChars: prompt.text.length,
    promptTokensApprox: Math.round(prompt.text.length / 4),
    files,
    mode: MODES[project.mode] || MODES.answer,
    firewall: {
      config: CONFIG.firewall,
      rateLimit: env.RATE_LIMITER ? "on (wrangler.jsonc → ratelimits)" : "off (no binding)",
      door: (function (a) { return `${a.mode} — ${a.reason}${a.wantKey ? (a.keyName ? ` · own key ${a.keyName}${env[a.keyName] ? "" : " (NOT set; shared key used)"}` : env.ACCESS_PASSPHRASE ? " · shared key set" : " · NO shared key set: runs open") : ""}${a.listed ? "" : " · unlisted"}`; })(effectiveAccess(project, await getSettings(env))),
      injectionPatterns: INJECTION_PATTERNS.map(String),
      secretPatterns: SECRET_PATTERNS.map(String),
      llamaGuardModel: LLAMA_GUARD_MODEL,
      logging: env.DB ? "on (D1 bound) — see the Audit tab" : "off (no D1 binding; Workers Logs only)",
      flags: {
        "injection-blocked": "matched an injection pattern; model never called",
        "invisible-text-stripped": "zero-width / bidi characters removed",
        "secret-detected": "looks like a key, card or SSN was pasted (logged only)",
        "link-stripped": "a URL not in allowedLinks was removed after the answer",
        "leak-blocked": "answer repeated the protected prompt; withheld",
        "leak-blocked:paraphrase": "answer described its rules in its own words; withheld",
        "handoff-appended": "a decline in a strict project was missing the contact; added",
        "intake-complete": "an intake bot collected everything (the [INTAKE COMPLETE] line was found and removed)",
        "intake-trimmed": "an intake bot asked several questions in one reply; the code kept only the first (one question at a time)",
        "declined": "the bot refused by its own rules (not in its files, or out of bounds) and handed the person to a human — the [HANDOFF] marker was found and removed",
        "booking-slots-offered": "a booking bot asked the calendar for free times and listed them (the [BOOKING: OFFER] line was found and removed)",
        "booking-created": "the call was booked on the calendar (the [BOOKING: CONFIRM …] line was found, the time re-checked, the booking made)",
        "booking-failed": "the chosen time was no longer free (or didn't match an offered one); fresh times were offered",
        "booking-provider-failed": "the calendar couldn't be reached or refused; the bot fell back to bookingUrl",
        "booking-no-slots": "the calendar had nothing free in the next 7 days",
        "booking-incomplete": "the model tried to confirm without a time, a name or an email; asked for the missing bit",
        "handoff-webhook-sent / handoff-webhook-failed": "the bot's handoff webhook was called after the reply; Audit tab only",
        "handoff-email-sent / -failed / -skipped": "the handoff email; skipped = no send_email binding or no handoffEmailFrom",
        "human-requested": "the visitor pressed Talk to a person; the request is under the hood → Conversations (and on the webhook, with a link)",
        "library-used": "excerpts from this bot's documents (AI Search) were put in the prompt for this question",
        "degenerate-reply": "the model emitted one character or one word over and over, twice; replaced with the handoff",
        "degenerate-retried": "the first reply was garbage; a second call gave a proper answer",
        "attachment-used": "the visitor's attached file was put in the prompt (outside <files>; never a fact about the business)",
        "attachment-injection-blocked": "the attached file contained instructions for the bot; refused before the model",
        "attachment-secret-blocked": "the attached file looked like it held a card number, key or ID number; refused",
        "website-used": "excerpts from this bot's crawled website (AI Search web crawler) were put in the prompt for this question",
        "voice-in": "the visitor spoke this message (the mic → Whisper on Workers AI); the text was screened like any other",
        "guard-blocked:S#": "Llama Guard flagged the user turn (category S1–S14)",
        "gateway-blocked": "AI Gateway Guardrails blocked it at the edge",
        "gateway-direct": "a Cloudflare setup step is still to do: config names an AI Gateway but you haven't created it in the dashboard yet, so the call went straight to the model with no logs and no spend limit. Fix: Cloudflare → AI → AI Gateway → Create, named exactly as gateway.id, then set a spend limit (docs/OWNER-CHECKLIST.md §1)",
        "small-model": "small talk (\"hi\", \"thanks\", \"ok\") answered by routing.smallModel with the same prompt — Engine/worker/router.js",
        "rate-limited": "over the per-visitor limit",
      },
    },
    gateway: {
      provider: CONFIG.provider, model: CONFIG.model, maxTokens: CONFIG.maxTokens,
      gateway: { ...CONFIG.gateway, ...gatewayStatus(CONFIG) },
      routing: { ...(CONFIG.routing || {}), split: routingStats() },
      usage: await usageReport(env, 7),
    },
    handoffActions: handoffActionsView(env, CONFIG, project),
    booking: bookingView(env, project),
    version: await versionStamp(env),
    sources,
  };
}

function sseOnce(reply, flags) {
  const payload = `data: ${JSON.stringify({ type: "final", text: reply, flags })}\n\n`;
  return new Response(payload, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
