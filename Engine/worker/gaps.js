// ============================================================================
//  GAPS — the refusals become a task list, and the task list becomes pages
//
//  The audit log already knows what the bot could NOT answer. This file closes
//  the loop:
//    1. Group the refused questions for one bot (30 days) into a list, one row
//       per question, with how often it was asked and when it was last seen.
//       Each row remembers a STATE — open, drafted, accepted, dismissed — in
//       its own D1 table (`gaps`), so the list is a to-do list, not a report.
//    2. "Draft an answer": one model call writes a FAQ entry for the question in
//       the owner's voice, using ONLY the bot's instructions and knowledge files.
//       If the files don't hold the answer, the model says so and writes a
//       template with blanks — "[fill in: your turnaround time]" — instead of
//       inventing something. The owner edits the draft in the page.
//    3. "Add to faq.md": the (edited) entry is appended to a knowledge file on
//       the bot's SAVED copy — the same thing Configure → Save produces — so the
//       bot answers the question from the very next turn. Commit to GitHub
//       makes the folder the source, as with any Configure change.
//
//  Fail-open, like everything else: no D1 → no gaps (the chat still works); a
//  draft that can't be produced is reported as such, never invented.
//
//  Only the routes live in index.js (handleGaps); the reading, grouping, model
//  call and parsing are here.
// ============================================================================

const FALLBACK_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const GAP_STATES = ["open", "drafted", "accepted", "dismissed"];

// The firewall's catches are not gaps: no page fixes "ignore your instructions".
// A refusal that carries one of these flags is left out of the list. What is
// left is the honest kind — a real question the files didn't answer.
const NOT_A_GAP = /blocked|error|rate-limited/;

// Two phrasings of the same question count as one. Light on purpose: lowercase,
// no punctuation, one space between words. "How fast are you?" and "how fast
// are you" are the same key; "how quick are you" is not — the owner sees both
// and answers once (the second one becomes "dismiss").
export function questionKey(q) {
  return String(q || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

// --- The list. Reads the refusals for one bot, refreshes the counts on the
//     gaps table (upsert: a row's state and draft are never touched), and
//     returns the rows. `projectName` is the bot's display name (that is what
//     the conversations table stores); `bot` is the id (that is what the
//     gaps table stores, so a rename doesn't lose the list). ------------------
export async function listGaps(env, { bot, projectName, days = 30, limit = 20 } = {}) {
  if (!env.DB) return { enabled: false, reason: "No D1 database is bound (wrangler.jsonc → d1_databases), so there is nothing to list.", rows: [] };
  days = Math.min(Math.max(Math.floor(Number(days)) || 30, 1), 365);
  limit = Math.min(Math.max(Math.floor(Number(limit)) || 20, 1), 100);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = (await env.DB.prepare(
    `SELECT asked, flags, created_at FROM conversations WHERE project = ? AND refused = 1 AND created_at >= ? ORDER BY id DESC LIMIT 2000`
  ).bind(projectName, since).all()).results || [];

  // group by the normalised question; keep the newest wording and date
  const groups = new Map();
  for (const r of rows) {
    if (NOT_A_GAP.test(String(r.flags || ""))) continue;
    const key = questionKey(r.asked);
    if (!key) continue;
    const g = groups.get(key) || { key, question: String(r.asked || "").trim().slice(0, 500), count: 0, lastSeen: r.created_at };
    g.count += 1;
    if (r.created_at > g.lastSeen) { g.lastSeen = r.created_at; g.question = String(r.asked || "").trim().slice(0, 500); }
    groups.set(key, g);
  }

  // upsert the counts. State, draft and file survive; only the numbers move.
  const now = new Date().toISOString();
  const stmts = [...groups.values()].slice(0, 500).map((g) => env.DB.prepare(
    `INSERT INTO gaps (bot, question_key, question, count_seen, last_seen, state, updated_at) VALUES (?, ?, ?, ?, ?, 'open', ?)
     ON CONFLICT(bot, question_key) DO UPDATE SET count_seen = excluded.count_seen, last_seen = excluded.last_seen, question = excluded.question`
  ).bind(bot, g.key, g.question, g.count, g.lastSeen, now));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));

  // open work first, most-asked first; then what's been dealt with
  const out = (await env.DB.prepare(
    `SELECT id, question, count_seen, last_seen, state, draft, grounded, missing, file, updated_at FROM gaps WHERE bot = ?
     ORDER BY CASE state WHEN 'open' THEN 0 WHEN 'drafted' THEN 1 WHEN 'accepted' THEN 2 ELSE 3 END, count_seen DESC, last_seen DESC LIMIT ?`
  ).bind(bot, limit).all()).results || [];
  return { enabled: true, since, days, rows: out.map(shape) };
}

export async function getGap(env, id) {
  if (!env.DB) return null;
  const r = await env.DB.prepare(`SELECT id, bot, question_key, question, count_seen, last_seen, state, draft, grounded, missing, file, updated_at FROM gaps WHERE id = ?`).bind(Number(id) || 0).first();
  return r ? { ...shape(r), bot: r.bot, question_key: r.question_key } : null;
}

export async function setGapState(env, id, state, { draft = null, grounded = null, missing = null, file = null } = {}) {
  if (!GAP_STATES.includes(state)) throw new Error("bad state");
  await env.DB.prepare(
    `UPDATE gaps SET state = ?, draft = COALESCE(?, draft), grounded = COALESCE(?, grounded), missing = COALESCE(?, missing), file = COALESCE(?, file), updated_at = ? WHERE id = ?`
  ).bind(state, draft, grounded == null ? null : (grounded ? 1 : 0), missing == null ? null : JSON.stringify(missing), file, new Date().toISOString(), Number(id) || 0).run();
  return getGap(env, id);
}

// --- The draft: one model call, grounded in the bot's own files. ---------------
// Always Workers AI, even if the bot itself uses OpenAI/Anthropic — this is
// bookkeeping, not the product. The files go in whole (they are the same text
// the bot answers from), capped so a huge knowledge folder can't blow the call.
export async function draftGap(env, config, project, gap) {
  if (!env.AI) return { error: "No Workers AI binding (wrangler.jsonc → ai), so nothing can draft." };
  const model = config.provider === "workers-ai" && config.model ? config.model : FALLBACK_MODEL;
  const owner = project.name || config.owner || "the business";
  const budget = 60000;                                   // characters of files the model gets to see
  let files = "";
  for (const [n, t] of Object.entries(project.files || {})) {
    if (files.length >= budget) break;
    files += `\n\n=== knowledge/${n} ===\n${String(t || "").slice(0, budget - files.length)}`;
  }
  const system = `You write FAQ entries for ${owner}'s website, in ${owner}'s own voice. The owner's assistant could not answer a visitor's question. Your job is to write the entry that would have answered it — using ONLY the owner's instructions and knowledge files below. Match their tone and wording. Never invent a fact, a number, a time, a price, a policy or a name that is not in the files.

Rules:
- If the files contain the answer (fully, or nearly), write it: "grounded": true, "missing": [].
- If the files do NOT contain the answer, or only part of it, write a TEMPLATE the owner can complete: put every unknown fact in square brackets as "[fill in: what goes here]" (e.g. "[fill in: your turnaround time]"). Set "grounded": false and list each unknown in "missing", one short phrase each. Do not guess.
- Say only what the files say — don't round up, soften, extend or imply more than is written.
- The entry is Markdown: a "## " heading that is the question the way a customer would ask it, then a short answer (under 120 words). No preamble, no sign-off.

Answer ONLY with a JSON object, no prose, no code fence, with exactly these keys:
{ "grounded": true or false, "missing": ["…"], "entry": "## Question\\nAnswer" }`;
  const user = `Question a visitor asked (the assistant refused it, ${gap.count} time${gap.count === 1 ? "" : "s"}):\n${gap.question}\n\n=== instructions.md ===\n${String(project.instructions || "(none)").slice(0, 8000)}${files || "\n\n(no knowledge files)"}`;
  let raw = "";
  try {
    const r = await env.AI.run(model, { messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: 900 });
    raw = String(r?.response ?? r?.choices?.[0]?.message?.content ?? "");
  } catch (err) {
    console.error("gap draft model call failed", err?.message || err);
    return { error: "The model call failed. Try again in a minute." };
  }
  const d = parseDraft(raw);
  if (!d) return { error: "The model didn't return a usable draft. Try again.", raw: raw.slice(0, 400) };
  return d;
}

// The model's JSON, checked. A blank left in the text counts as "not grounded"
// whatever the flag says — the text is what the owner will read.
export function parseDraft(raw) {
  const m = String(raw).match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o;
  try { o = JSON.parse(m[0]); } catch { return null; }
  const entry = String(o.entry || "").trim().slice(0, 4000);
  if (!entry) return null;
  const missing = (Array.isArray(o.missing) ? o.missing : o.missing ? [String(o.missing)] : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 12);
  const blanks = [...entry.matchAll(/\[fill in:\s*([^\]]+)\]/gi)].map((x) => x[1].trim());
  for (const b of blanks) if (!missing.some((s) => s.toLowerCase() === b.toLowerCase())) missing.push(b);
  const grounded = o.grounded === true && blanks.length === 0 && missing.length === 0;
  return { draft: entry, grounded, missing: grounded ? [] : missing.slice(0, 12) };
}

function shape(r) {
  let missing = []; try { missing = r.missing ? JSON.parse(r.missing) : []; } catch { missing = []; }
  return { id: r.id, question: r.question, count: r.count_seen, lastSeen: r.last_seen, state: r.state, draft: r.draft || "", grounded: r.grounded == null ? null : Boolean(r.grounded), missing, file: r.file || "", updatedAt: r.updated_at };
}
