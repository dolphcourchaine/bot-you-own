// ============================================================================
//  THE SANDBOX — a keyed visitor's own bot, on this deployment, for two weeks.
//
//  "Make your own, here": paste the Instructions from a custom GPT, or start from
//  a licensed prompt in the library below, add a few knowledge files, and chat
//  with it from the sidebar. Only that person (this browser's identity) and the
//  admin can see or use it. It expires after SANDBOX_DAYS and can be deleted any
//  time. "Take it with you" hands back the three files a real bot folder needs.
//
//  Who may: the same key as deploy — on the allowlist, or a redeemed deploy code.
//
//    GET    /api/sandbox?bot=<guide>              { allowed, bots, library, limits }
//    POST   /api/sandbox   {bot, name, greeting, instructions | library, starters}   → { bot }
//    GET    /api/sandbox/<id>                     the full bot (owner) — for "take it with you"
//    POST   /api/sandbox/<id>/file   multipart    add one knowledge file (converted to text)
//    DELETE /api/sandbox/<id>
// ============================================================================

import { tourState } from "./tour.js";
import { savedProjects, saveProject, deleteSavedProject, pickPublic, hrefFor } from "./projects.js";
import { deviceHash, userForDeviceAnyBot } from "../identity/devices.js";
import { extractText, gate as fileGate, scanText } from "./library.js";
import { json } from "./track-common.js";
import { PROJECTS } from "../../YourBots/index.js";

// What may not go into a bot's instructions or files: a card number, an ID number, a key, a password.
const BLOCKS = ["card", "ssn", "iban", "secret", "password", "privkey"];
const blocked = (text) => { const f = scanText(text).filter((x) => BLOCKS.includes(x.id)); return f.length ? `That contains what looks like ${f.map((x) => x.label.toLowerCase()).join(", ")} — take it out first.` : ""; };

export const SANDBOX_DAYS = 14, MAX_PER_PERSON = 3, MAX_FILES = 8, MAX_FILE_CHARS = 50000, MAX_INSTRUCTIONS = 20000;

// Licensed, original, verified to exist. The server fetches the text at import time;
// nothing is copied into this repo. Keep the credit line: MIT asks for it.
export // A demo needs something to chew on. A paste-driven prompt ("Summarise this:") dead-ends
// in front of an audience: you click the starter and then have to go and find text. So the
// paste-driven library items ship one sample article, saved as a file on the new bot, and a
// starter that runs the whole demo in one click. Original text: no licence to worry about.
// A second sample for the paste-driven starters that are not about an article. Without one,
// "Give me the takeaways from this email thread:" loads a prompt with nothing under it and
// the demo stops dead at an empty box.
const SAMPLE_PARAGRAPH = "It should be noted that at this point in time the company is currently in the process of undertaking a comprehensive review of its existing customer onboarding procedures, with a view to potentially identifying areas in which improvements could conceivably be made going forward. It is anticipated that the findings of the aforementioned review will be communicated to all relevant stakeholders in due course.";
const SAMPLE_FUNCTION = "function averageOrderValue(orders) {\n  let total = 0;\n  for (let i = 0; i <= orders.length; i++) {\n    total += orders[i].amount;\n  }\n  return total / orders.length;\n}";
const SAMPLE_ERROR = "TypeError: Cannot read properties of undefined (reading 'amount')\n    at averageOrderValue (/app/src/reports.js:4:22)\n    at buildMonthlyReport (/app/src/reports.js:38:19)\n    at async run (/app/src/cron.js:12:3)";
const SAMPLE_SQL = "SELECT c.name, COUNT(*) AS orders, SUM(o.total) AS spend\nFROM customers c, orders o\nWHERE c.id = o.customer_id\n  AND o.created_at > '2026-01-01'\nGROUP BY c.name\nORDER BY spend DESC;";
const SAMPLE_THREAD = "Subject: Riverbend spring order \u2014 sizes and dates\n\nFrom: Dana Okonjo\nTue 09:12\nMarco, the spring order needs to go in by Friday. Last year we over-ordered mediums and sat on twelve of them until August. Can you check what actually sold?\n\nFrom: Marco Bellini\nTue 11:40\nChecked. Mediums sold 31 of 44. Larges sold out by mid-April and we turned people away \u2014 I counted nine we couldn't fill. Smalls were fine at 18 of 20.\n\nFrom: Dana Okonjo\nTue 11:58\nSo we shift the mix rather than the total. Cut mediums to 32, raise larges to 30, leave smalls. That keeps us at the same spend.\n\nFrom: Priya Raman\nTue 14:05\nOne thing before you send it: the supplier moved to a 6-week lead time in January, not 4. If we order Friday we get stock the first week of May, not mid-April. Larges will sell out before it lands again.\n\nFrom: Dana Okonjo\nTue 14:22\nGood catch. Then we order Wednesday instead and I'll ring them to confirm the lead time in writing. Marco, get me the final numbers by tomorrow lunchtime. Priya, can you check whether the 6 weeks applies to the whole range or just outerwear?";

const SAMPLE_ARTICLE = "# The Tuesday Meeting\n\nRiverbend Cycles has run the same Tuesday meeting for six years. Every manager gives a status update, in turn, for ninety minutes. Nobody has ever cancelled it.\n\nLast spring the workshop manager, Dana Okonjo, started timing it. Of the ninety minutes, she found that roughly sixty were spent on information that was already in the shared calendar or the repair queue. The remaining thirty were the part everyone actually needed: three or four decisions that required two people in a room agreeing on something.\n\nShe proposed a change. Status updates would be written down by Monday evening and read before the meeting. Tuesday would be thirty minutes, decisions only, and anyone with nothing to decide could skip it.\n\nThe first month went badly. People did not write their updates, so the meeting became thirty minutes of verbal status after all, just more rushed. Dana nearly abandoned it. What fixed it was smaller than the original idea: she began posting the decision list on Monday at 4pm, and anyone whose name was not on it was told plainly not to come.\n\nAttendance halved. The meeting now runs twenty-two minutes on average. Two of the managers have said, separately, that it is the only meeting they do not resent.\n\nDana's own conclusion was not about meetings. It was that people will not adopt a new habit to save time in the abstract, but they will adopt one immediately if it means they get an hour back on a specific afternoon.";

const LIBRARY = [
  { id: "fabric-extract-wisdom", name: "Extract wisdom", blurb: "Pulls ideas, quotes, habits and references out of anything you paste — a transcript, an article.", source: "danielmiessler/fabric", licence: "MIT", url: "https://raw.githubusercontent.com/danielmiessler/fabric/main/data/patterns/extract_wisdom/system.md", starters: ["Pull the wisdom out of the sample article", "Pull the wisdom out of the sample email thread"], samples: { "sample article": SAMPLE_ARTICLE, "email thread": SAMPLE_THREAD } },
  { id: "fabric-create-summary", name: "Summariser", blurb: "A 20-word overview, the main points, the takeaways. Paste anything long.", source: "danielmiessler/fabric", licence: "MIT", url: "https://raw.githubusercontent.com/danielmiessler/fabric/main/data/patterns/create_summary/system.md", starters: ["Summarise the sample article", "Summarise the sample email thread", "Summarise this for me:"], samples: { "sample article": SAMPLE_ARTICLE, "email thread": SAMPLE_THREAD } },
  { id: "fabric-improve-writing", name: "Writing improver", blurb: "Fixes grammar, clarity and flow without changing what you meant.", source: "danielmiessler/fabric", licence: "MIT", url: "https://raw.githubusercontent.com/danielmiessler/fabric/main/data/patterns/improve_writing/system.md", starters: ["Tighten the sample paragraph", "Tighten this paragraph:"], samples: { "sample paragraph": SAMPLE_PARAGRAPH } },
  { id: "fabric-explain-code", name: "Code explainer", blurb: "Explains what a piece of code does, in plain words.", source: "danielmiessler/fabric", licence: "MIT", url: "https://raw.githubusercontent.com/danielmiessler/fabric/main/data/patterns/explain_code/system.md", starters: ["Explain the sample function", "Explain the sample error", "Explain this for me:"], samples: { "sample function": SAMPLE_FUNCTION, "sample error": SAMPLE_ERROR } },
  { id: "fabric-write-essay", name: "Essay writer", blurb: "Writes a clear, personal essay on a topic you give it.", source: "danielmiessler/fabric", licence: "MIT", url: "https://raw.githubusercontent.com/danielmiessler/fabric/main/data/patterns/write_essay/system.md", starters: ["Write 500 words on why small businesses should own their tools", "An essay on saying no"] },
  { id: "hub-code-reviewer", name: "Senior code reviewer", blurb: "A staff-engineer persona that reviews code and ranks findings by severity.", source: "LichAmnesia/GPT-Prompt-Hub", licence: "MIT", url: "https://raw.githubusercontent.com/LichAmnesia/GPT-Prompt-Hub/main/prompts/engineering/senior-code-reviewer.md", starters: ["Review the sample function", "Review the sample SQL"], samples: { "sample function": SAMPLE_FUNCTION, "sample sql": SAMPLE_SQL } },
  { id: "hub-prd-writer", name: "PRD writer", blurb: "A product-manager persona with an 11-section PRD template, driven by KPIs.", source: "LichAmnesia/GPT-Prompt-Hub", licence: "MIT", url: "https://raw.githubusercontent.com/LichAmnesia/GPT-Prompt-Hub/main/prompts/business/product-manager-prd-writer-kpi-driven.md", starters: ["Write a PRD for a booking page for a dentist", "Turn this idea into a one-page PRD:"] },
  { id: "hub-socratic-tutor", name: "Socratic tutor", blurb: "Teaches any topic by asking, seven moves at a time.", source: "LichAmnesia/GPT-Prompt-Hub", licence: "MIT", url: "https://raw.githubusercontent.com/LichAmnesia/GPT-Prompt-Hub/main/prompts/learning/socratic-polymath-tutor-any-topic.md", starters: ["Teach me how DNS works", "I want to understand compound interest"] },
];

const now = () => new Date().toISOString();
const newId = () => "sb-" + [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("");

// Whose browser is this, on any bot? The email, or "".
export async function sandboxOwnerOf(env, request) {
  if (!env.DB) return "";
  try { const k = await deviceHash(request); const u = k ? await userForDeviceAnyBot(env, k) : null; return u ? u.email : ""; } catch { return ""; }
}
async function mine(env, email) {
  const saved = await savedProjects(env);
  return Object.values(saved).filter((p) => p.sandbox && p.sandbox.email === email && !(p.sandbox.expires_at && p.sandbox.expires_at < now()));
}
// The demo sample that belongs with this bot. Stored on the bot when it is made — but a bot
// built before the sample shipped has none, and rebuilding a bot to get a starter is a silly
// thing to ask anyone to do. So fall back to the library item named in its source line.
function sampleFor(p) {
  if (p.sandbox?.samples && Object.keys(p.sandbox.samples).length) return p.sandbox.samples;
  if (p.sandbox?.sample) return { "sample article": p.sandbox.sample };      // bots made before the set existed
  const src = String(p.sandbox?.source || "");
  const item = LIBRARY.find((l) => src === l.source + " \u00b7 " + l.name);
  return item?.samples || {};
}

// Sidebar rows: the visitor's own; the admin sees every sandbox with a badge. Expired ones are swept here.
let SWEPT_AT = 0;
export async function visibleSandboxes(env, request, { isAdmin, all }) {
  if (!env.DB) return [];
  if (Date.now() - SWEPT_AT > 3600 * 1000) { SWEPT_AT = Date.now(); try { for (const p of Object.values(await savedProjects(env))) if (p.sandbox?.expires_at && p.sandbox.expires_at < now()) await deleteSavedProject(env, p.id); } catch {} }
  const row = (p) => ({ id: p.id, ...pickPublic(p), kind: "chat", href: hrefFor(p), access: "open", listed: true, source: "sandbox", sandbox: { expires_at: p.sandbox.expires_at, source: p.sandbox.source, samples: sampleFor(p), ...(isAdmin ? { email: p.sandbox.email } : {}) } });
  if (isAdmin) return Object.values(await savedProjects(env)).filter((p) => p.sandbox).map(row);
  const email = await sandboxOwnerOf(env, request); if (!email) return [];
  return (await mine(env, email)).map(row);
}

function cleanStarters(a) { return (Array.isArray(a) ? a : []).map((x) => String(x || "").trim().slice(0, 120)).filter(Boolean).slice(0, 4); }
async function fetchLibrary(id) {
  const item = LIBRARY.find((l) => l.id === id); if (!item) return { error: "No such library prompt." };
  try {
    const r = await fetch(item.url, { signal: AbortSignal.timeout(10000), headers: { "user-agent": "bot-you-own sandbox importer" } });
    if (!r.ok) return { error: `The library answered ${r.status}. Try again in a minute.` };
    let text = (await r.text()).replace(/\r/g, "").trim().slice(0, MAX_INSTRUCTIONS);
    // fabric patterns end with an "# INPUT" section that expects the text appended; a chat bot gets it as a message instead
    text = text.replace(/\n#+\s*INPUT[\s\S]*$/i, "").trim();
    return { item, text: text + `\n\n(Prompt: "${item.name}" from ${item.source}, ${item.licence} licence.)` };
  } catch (err) { return { error: "Couldn't fetch that prompt right now: " + (err?.message || err) }; }
}

export async function handleSandbox(request, env, url, { isAdmin, allowed, settings, resolveProject, guard }) {
  if (!env.DB) return json({ error: "The sandbox needs the D1 database." }, 503);
  const m = url.pathname.match(/^\/api\/sandbox(?:\/(sb-[0-9a-f]{8}))?(?:\/(file))?$/);
  if (!m) return json({ error: "not found" }, 404);
  const [, id, sub] = m;
  const email = isAdmin ? "" : await sandboxOwnerOf(env, request);
  const guideId = String(url.searchParams.get("bot") || "").toLowerCase();

  // Building here is for anyone who signed up — the key gates the code and the deploy button, not this.
  const keyed = async () => {
    if (isAdmin) return true;
    if (email) return true;
    let guide = guideId ? await resolveProject(env, guideId) : null;
    if (!guide || !guide.tour) { const gid = Object.entries(PROJECTS).find(([, p]) => p.tour)?.[0]; guide = gid ? await resolveProject(env, gid) : null; }
    if (!guide || !guide.tour) return false;
    const t = await tourState(env, request, guide, { links: settings.links });
    return Boolean(t.deploy?.allowed);
  };

  if (!id) {
    if (request.method === "GET") {
      const ok = email || isAdmin ? await keyed() : false;
      const bots = isAdmin ? [] : email ? (await mine(env, email)).map((p) => ({ id: p.id, name: p.name, expires_at: p.sandbox.expires_at, files: Object.keys(p.files || {}).length, source: p.sandbox.source })) : [];
      // the page gets a readable source page per prompt (the raw URL stays server-side)
      return json({ allowed: ok, signedUp: Boolean(email) || isAdmin, bots, library: LIBRARY.map(({ url, ...l }) => ({ ...l, page: url.replace("https://raw.githubusercontent.com/", "https://github.com/").replace(/\/main\//, "/blob/main/") })), limits: { days: SANDBOX_DAYS, perPerson: MAX_PER_PERSON, files: MAX_FILES, fileChars: MAX_FILE_CHARS, instructions: MAX_INSTRUCTIONS } });
    }
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    if (!(await allowed(env, request))) return json({ error: "rate-limited", reason: "Slow down a little." }, 429);
    if (!email && !isAdmin) return json({ error: "sign-up", reason: "Sign up first." }, 401);
    if (!(await keyed())) return json({ error: "sign-up", reason: "Sign up first, then build here." }, 403);
    const body = (await request.json().catch(() => ({}))) || {};
    const owner = email || "admin";
    if (!isAdmin && (await mine(env, email)).length >= MAX_PER_PERSON) return json({ error: "limit", reason: `You can have ${MAX_PER_PERSON} sandbox bots at a time. Delete one to make room.` }, 400);
    let instructions = String(body.instructions || "").trim().slice(0, MAX_INSTRUCTIONS), starters = cleanStarters(body.starters), source = "pasted";
    let samples = {};
    if (body.library) { const lib = await fetchLibrary(String(body.library)); if (lib.error) return json({ error: "library", reason: lib.error }, 502); instructions = lib.text; source = lib.item.source + " · " + lib.item.name; if (!starters.length) starters = lib.item.starters || []; if (lib.item.samples) samples = lib.item.samples; }
    if (instructions.length < 20) return json({ error: "instructions", reason: "Paste the instructions (at least a sentence), or pick one from the library." }, 400);
    const bad = blocked(instructions); if (bad) return json({ error: "instructions", reason: bad }, 400);
    const bid = newId();
    const name = String(body.name || "").trim().slice(0, 60) || "My bot";
    const p = await saveProject(env, bid, {
      kind: "chat", order: -1, name, tagline: "Your sandbox bot · expires in " + SANDBOX_DAYS + " days",
      greeting: String(body.greeting || "").trim().slice(0, 400) || `Hi — I'm ${name}. What can I do for you?`,
      starters, mode: "imported", grounding: "open", instructions, files: {},
      handoffText: "", handoffContact: "", allowedLinks: [], access: "open", listed: false,
      sandbox: { email: owner, userId: "", expires_at: new Date(Date.now() + SANDBOX_DAYS * 86400 * 1000).toISOString(), source, samples },
    });
    console.log(JSON.stringify({ event: "sandbox-create", bot: bid, source }));
    return json({ ok: true, bot: { id: p.id, name: p.name, expires_at: p.sandbox.expires_at, source } });
  }

  // One bot: owner or admin only.
  const project = await resolveProject(env, id);
  if (!project || !project.sandbox || project.id !== id) return json({ error: "not found" }, 404);
  if (!isAdmin && project.sandbox.email !== email) return json({ error: "not yours" }, 403);
  if (request.method === "DELETE") { await deleteSavedProject(env, id); console.log(JSON.stringify({ event: "sandbox-delete", bot: id })); return json({ ok: true }); }
  if (!sub && request.method === "GET") return json({ bot: { id: project.id, name: project.name, greeting: project.greeting, starters: project.starters, instructions: project.instructions, files: project.files || {}, expires_at: project.sandbox.expires_at, source: project.sandbox.source } });
  if (sub === "file" && request.method === "POST") {
    if (!(await allowed(env, request))) return json({ error: "rate-limited", reason: "Slow down a little." }, 429);
    let form; try { form = await request.formData(); } catch { return json({ error: "form", reason: "Send the file as multipart/form-data in a 'file' field." }, 400); }
    const f = form.get("file"); if (!f || typeof f === "string") return json({ error: "file", reason: "No file." }, 400);
    if (Object.keys(project.files || {}).length >= MAX_FILES) return json({ error: "limit", reason: `A sandbox bot holds ${MAX_FILES} files. Remove one first.` }, 400);
    const g = fileGate(f.name, f.size); if (!g.ok) return json({ error: "file", reason: g.reason }, 400);
    let text = ""; try { text = await extractText(env, g.name, g.ext, await f.arrayBuffer()); } catch (err) { console.error("sandbox: extract failed", err?.message || err); }
    text = String(text || "").trim(); if (!text) return json({ error: "file", reason: "Couldn't read any text out of that file." }, 400);
    const bad = blocked(text); if (bad) return json({ error: "file", reason: bad }, 400);
    const fname = g.name.replace(/\.[a-z0-9]+$/i, "") .slice(0, 60) + ".md";
    const files = { ...(project.files || {}), [fname]: text.slice(0, MAX_FILE_CHARS) };
    await saveProject(env, id, { ...project, files, grounding: "open" });
    return json({ ok: true, file: fname, chars: Math.min(text.length, MAX_FILE_CHARS), cut: text.length > MAX_FILE_CHARS, files: Object.keys(files) });
  }
  if (sub === "file" && request.method === "DELETE") {
    const name = String(url.searchParams.get("name") || ""); const files = { ...(project.files || {}) }; delete files[name];
    await saveProject(env, id, { ...project, files }); return json({ ok: true, files: Object.keys(files) });
  }
  return json({ error: "method" }, 405);
}
