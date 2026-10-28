// ============================================================================
//  LEADS — who asked, what they asked, and what that tells you
//
//  In email mode (YourBots/config.js → access.mode "email" or "key+email") a
//  visitor gives an address before they chat, and every turn is logged with
//  it. That log is a pile of discovery calls you didn't have to be on. This
//  file turns the pile into a list: one row per visitor, and on request a
//  short AI summary of what they wanted, where they seem to be, what they'd
//  object to, and what to do next — with a score and the reason for it.
//
//  Nothing here sends email. A lead can be pushed to the bot's webhook (the
//  same one handoffs use — Slack, Zapier, your CRM), by hand from the Leads
//  tab or automatically after a few turns. That's the whole loop.
//
//  Privacy, said plainly: the summary reads the SAME redacted text the audit
//  log keeps (emails, phones and dates inside messages are already replaced),
//  so a lead record can't contain a phone number the visitor typed. Names
//  are not redacted. The visitor column is the email they gave — that is the
//  point of email mode. Tell people conversations are recorded.
//
//  Fail-open, like everything else: no D1 → no leads (the chat still works);
//  a summary that can't be produced is reported as such, never invented.
// ============================================================================

import { sendWebhook } from "./handoff.js";
import { languageName, languageSettings } from "./language.js";

const FALLBACK_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const NOT_A_LEAD = new Set(["", "admin"]);

export function leadsConfig(config) {
  const l = config.leads || {};
  return {
    autoAfterTurns: Math.max(0, Math.floor(Number(l.autoAfterTurns) || 0)),   // 0 = never automatic
    notifyScore: Math.min(100, Math.max(0, Number(l.notifyScore) || 70)),
    webhook: String(l.webhook || "").trim(),
    maxTurns: Math.max(5, Math.min(80, Number(l.maxTurns) || 40)),
  };
}

// --- The list: one row per visitor, newest activity first. -------------------
// `project` = a bot's display name to filter on, or "*" for all bots.
export async function listLeads(env, { projectName = "*", limit = 100 } = {}) {
  if (!env.DB) return { enabled: false, reason: "No D1 database is bound (wrangler.jsonc → d1_databases), so there is nothing to list.", rows: [] };
  const where = projectName && projectName !== "*" ? "AND c.project = ?" : "";
  const args = where ? [projectName] : [];
  const rows = (await env.DB.prepare(
    `SELECT c.visitor, MIN(c.created_at) first_seen, MAX(c.created_at) last_seen, COUNT(*) turns, SUM(c.refused) refused,
            GROUP_CONCAT(DISTINCT c.project) bots,
            l.score, l.updated_at summarised_at, l.turns_at_summary, l.sent_at
       FROM conversations c LEFT JOIN leads l ON l.visitor = c.visitor
      WHERE c.visitor != '' AND c.visitor != 'admin' ${where}
      GROUP BY c.visitor ORDER BY last_seen DESC LIMIT ?`
  ).bind(...args, Math.min(Math.max(limit, 1), 500)).all()).results || [];
  return { enabled: true, rows: rows.map((r) => ({ ...r, bots: String(r.bots || "").split(","), stale: r.summarised_at ? (r.turns > (r.turns_at_summary || 0)) : null })) };
}

// --- One visitor: their turns and the stored summary, if any. -----------------
export async function getLead(env, config, visitor) {
  if (!env.DB) return null;
  visitor = cleanVisitor(visitor);
  if (!visitor) return null;
  const { maxTurns } = leadsConfig(config);
  const turns = (await env.DB.prepare(
    `SELECT id, project, asked, answered, refused, flags, created_at FROM conversations WHERE visitor = ? ORDER BY id DESC LIMIT ?`
  ).bind(visitor, maxTurns).all()).results || [];
  turns.reverse();
  const stored = await env.DB.prepare(`SELECT visitor, bot, summary, score, updated_at, turns_at_summary, sent_at FROM leads WHERE visitor = ?`).bind(visitor).first();
  let summary = null;
  if (stored?.summary) { try { summary = JSON.parse(stored.summary); } catch {} }
  const total = (await env.DB.prepare(`SELECT COUNT(*) n FROM conversations WHERE visitor = ?`).bind(visitor).first())?.n || 0;
  return { visitor, turns, total, bot: stored?.bot || turns.at(-1)?.project || "", summary, score: stored?.score ?? null, summarisedAt: stored?.updated_at || null, turnsAtSummary: stored?.turns_at_summary ?? null, sentAt: stored?.sent_at || null, stale: stored ? total > (stored.turns_at_summary || 0) : null };
}

// --- The summary: one model call over the visitor's turns, stored. -----------
// Cached: a second call returns the stored one unless `refresh` is set or the
// visitor has talked since. Always Workers AI, even if the bot itself uses
// OpenAI/Anthropic — this is bookkeeping, not the product.
export async function summariseLead(env, config, visitor, { refresh = false } = {}) {
  const lead = await getLead(env, config, visitor);
  if (!lead) return { error: "No database, or no such visitor." };
  if (!lead.turns.length) return { error: "That visitor has no logged turns." };
  if (lead.summary && !refresh && !lead.stale) return { ...lead, cached: true };
  if (!env.AI) return { error: "No Workers AI binding (wrangler.jsonc → ai), so nothing can summarise." };

  const model = config.provider === "workers-ai" && config.model ? config.model : FALLBACK_MODEL;
  const transcript = lead.turns.map((t, i) => `${i + 1}. [${t.project}] Visitor: ${t.asked}\n   Bot: ${t.answered}${t.refused ? "  (the bot could not answer this)" : ""}`).join("\n");
  const owner = config.owner || "the business";
  // The brief is for the OWNER, so it's in the owner's language (config.languages.owner)
  // whatever the visitor wrote in. The log itself stays as the visitor typed it.
  const briefLanguage = languageName(languageSettings(config).owner);
  const system = `You read a chat log between a visitor and ${owner}'s website assistant, and write a short brief for the person who will follow up. Be concrete and honest. Do not invent facts that are not in the log. If the log is thin, say so and keep the score low. Write the brief in ${briefLanguage}, whatever language the visitor wrote in; quote the visitor's own words as they are.
Answer ONLY with a JSON object, no prose, no code fence, with exactly these keys:
{
  "asked": ["3-6 short bullets: what they asked about, most important first"],
  "situation": "1-2 sentences: who they seem to be and where they are in deciding",
  "cares_about": ["2-4 short bullets: what matters to them, in their words where possible"],
  "objections": ["0-3 short bullets: doubts, blockers, things the bot couldn't answer that they wanted"],
  "next_step": "one sentence: the single best thing the owner should do next, and the hook to lead with",
  "score": 0-100 (100 = ready to buy now, 50 = interested but early, 10 = browsing or unclear),
  "reason": "one sentence justifying the score"
}`;
  let raw = "";
  try {
    const r = await env.AI.run(model, { messages: [{ role: "system", content: system }, { role: "user", content: `Chat log (${lead.turns.length} most recent turns of ${lead.total}):\n\n${transcript}` }], max_tokens: 900 });
    raw = String(r?.response ?? r?.choices?.[0]?.message?.content ?? "");
  } catch (err) {
    console.error("lead summary model call failed", err?.message || err);
    return { error: "The model call failed. Try again in a minute." };
  }
  const summary = parseSummary(raw);
  if (!summary) return { error: "The model didn't return a usable summary. Try Refresh.", raw: raw.slice(0, 400) };
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO leads (visitor, bot, summary, score, updated_at, turns_at_summary) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(visitor) DO UPDATE SET bot = excluded.bot, summary = excluded.summary, score = excluded.score, updated_at = excluded.updated_at, turns_at_summary = excluded.turns_at_summary`
  ).bind(visitor, lead.bot, JSON.stringify(summary), summary.score, now, lead.total).run();
  console.log(JSON.stringify({ event: "lead-summary", visitor, bot: lead.bot, score: summary.score, turns: lead.total }));
  return { ...lead, summary, score: summary.score, summarisedAt: now, turnsAtSummary: lead.total, stale: false, cached: false };
}

// --- Push a lead to the webhook. -----------------------------------------------
// Which webhook: the bot's own (project.json → handoffActions.webhook), else
// config.leads.webhook. Same signing, same 5 s timeout, same Slack-friendly
// "text" field as a handoff. Returns "lead-webhook-sent" / "-failed" / "-skipped".
export async function sendLead(env, config, lead, { project = null } = {}) {
  const webhook = String(project?.handoffActions?.webhook || leadsConfig(config).webhook || "").trim();
  if (!webhook) return "lead-webhook-skipped";
  if (!lead?.summary) return "lead-webhook-skipped";
  const s = lead.summary;
  const bot = { id: project?.id || "", name: lead.bot || project?.name || "" };
  const payload = {
    event: "lead-summary", bot, when: new Date().toISOString(),
    visitor: lead.visitor, score: s.score, turns: lead.total, refused: lead.turns.filter((t) => t.refused).length,
    firstSeen: lead.turns[0]?.created_at || "", lastSeen: lead.turns.at(-1)?.created_at || "",
    summary: s,
    text: `[${bot.name}] lead ${lead.visitor} · score ${s.score} — ${s.reason}\nSituation: ${s.situation}\nAsked: ${(s.asked || []).join("; ")}\nNext step: ${s.next_step}`,
  };
  const out = await sendWebhook(env, webhook, payload, bot);
  const ok = out === "handoff-webhook-sent";
  if (ok && env.DB) { try { await env.DB.prepare(`UPDATE leads SET sent_at = ? WHERE visitor = ?`).bind(payload.when, lead.visitor).run(); } catch {} }
  return ok ? "lead-webhook-sent" : "lead-webhook-failed";
}

// --- Automatic: after N turns from a visitor, summarise once and push it if
//     the score clears the bar. Called from afterReply (index.js), inside
//     ctx.waitUntil, so the visitor never waits. Runs exactly at turn N so a
//     chatty visitor doesn't cost a model call per message. ----------------------
export async function maybeAutoLead(env, config, project, who) {
  const visitor = cleanVisitor(who);
  const { autoAfterTurns, notifyScore } = leadsConfig(config);
  if (!env.DB || !visitor || !autoAfterTurns) return [];
  try {
    const n = (await env.DB.prepare(`SELECT COUNT(*) n FROM conversations WHERE visitor = ?`).bind(visitor).first())?.n || 0;
    if (n !== autoAfterTurns) return [];
    const lead = await summariseLead(env, config, visitor, { refresh: true });
    if (lead.error) return ["lead-summary-failed"];
    const flags = ["lead-summarised"];
    if ((lead.score ?? 0) >= notifyScore) flags.push(await sendLead(env, config, lead, { project }));
    return flags;
  } catch (err) {
    console.error("auto lead failed (continuing)", err?.message || err);
    return [];
  }
}

// --- helpers ---------------------------------------------------------------------
export function cleanVisitor(v) {
  v = String(v || "").trim().toLowerCase().slice(0, 254);
  return NOT_A_LEAD.has(v) ? "" : v;
}

function parseSummary(raw) {
  const m = String(raw).match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o;
  try { o = JSON.parse(m[0]); } catch { return null; }
  const list = (x, n) => (Array.isArray(x) ? x : x ? [String(x)] : []).map((s) => String(s).trim()).filter(Boolean).slice(0, n);
  const score = Math.max(0, Math.min(100, Math.round(Number(o.score)) || 0));
  return {
    asked: list(o.asked, 6), situation: String(o.situation || "").slice(0, 400), cares_about: list(o.cares_about, 4),
    objections: list(o.objections, 3), next_step: String(o.next_step || "").slice(0, 300), score, reason: String(o.reason || "").slice(0, 300),
  };
}
