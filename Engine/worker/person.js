// ============================================================================
//  TALK TO A PERSON — the visitor asks for a human, in the same chat window.
//
//  A handoff line ("call the front desk") sends the visitor away. This keeps
//  them: they press "Talk to a person", the request lands in a D1 table, the
//  bot's webhook (if it has one) gets a "human-requested" ping with a link, and
//  the owner answers from under the hood → Conversations. The visitor's page
//  polls every 10 seconds and shows the owner's words as a "person" bubble;
//  whatever the visitor types meanwhile goes to the person, not the bot. When
//  the owner closes it, the bot takes over again.
//
//  Two tables (created on first use by ensureSchema in index.js):
//    handoffs          one row per request: bot, chat, visitor, the last 8 turns
//                      (redacted), status open | answered | closed
//    handoff_messages  the thread: from_role visitor | owner
//
//  The handoff id is a long random string and it IS the visitor's key: whoever
//  has it (plus the door token) can read and write that one thread. Nothing
//  here sends email. Everything fails OPEN: no database = the button says so,
//  the chat itself is untouched.
// ============================================================================

import { redact } from "./firewall.js";
import { sendWebhook, normaliseHandoffActions } from "./handoff.js";

export const PERSON_LIMITS = {
  textChars: 2000,          // one message, either side
  visitorMessages: 50,      // per handoff, visitor side (the owner is not capped)
  transcriptTurns: 8,       // what the owner sees of the chat that led here
  transcriptChars: 4000,    // per turn
};

// 48 hex characters of randomness. Unguessable; that is the whole access model.
function newId() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
export function isHandoffId(id) { return /^[0-9a-f]{48}$/.test(String(id || "")); }

const now = () => new Date().toISOString();
const clip = (t, n) => String(t || "").trim().slice(0, n);

// The visitor pressed the button. One open request per chat: a second press
// while one is open returns the existing id (the page resumes it).
export async function createHandoff(env, { bot, chatId, visitor, transcript, note }) {
  const open = await env.DB.prepare(`SELECT id FROM handoffs WHERE bot = ? AND chat_id = ? AND status != 'closed' ORDER BY created_at DESC LIMIT 1`).bind(bot, chatId).first();
  if (open) return { exists: open.id };
  const id = newId(), t = now();
  // The transcript is stored the way the audit log is: emails, phones and dates
  // inside the messages become [email] [phone] [date]. The visitor column keeps
  // the address they gave at the door — that is what the owner needs.
  const turns = (Array.isArray(transcript) ? transcript : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-PERSON_LIMITS.transcriptTurns)
    .map((m) => ({ role: m.role, content: redact(m.content).slice(0, PERSON_LIMITS.transcriptChars) }));
  const stmts = [env.DB.prepare(`INSERT INTO handoffs (id, bot, chat_id, visitor, transcript, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`).bind(id, bot, chatId, visitor || "", JSON.stringify(turns), t, t)];
  const first = clip(note, PERSON_LIMITS.textChars);
  if (first) stmts.push(env.DB.prepare(`INSERT INTO handoff_messages (handoff_id, from_role, text, created_at) VALUES (?, 'visitor', ?, ?)`).bind(id, first, t));
  await env.DB.batch(stmts);
  return { id, transcript: turns, note: first, created_at: t };
}

// What the visitor's page polls: status and the messages after ?since=<id>.
// Only what that page needs — not the transcript, not the visitor column.
export async function readHandoff(env, id, since = 0) {
  const h = await env.DB.prepare(`SELECT id, bot, status, created_at, updated_at FROM handoffs WHERE id = ?`).bind(id).first();
  if (!h) return null;
  const after = Math.max(0, parseInt(since, 10) || 0);
  const rows = (await env.DB.prepare(`SELECT id, from_role, text, created_at FROM handoff_messages WHERE handoff_id = ? AND id > ? ORDER BY id ASC LIMIT 200`).bind(id, after).all()).results || [];
  return { id: h.id, bot: h.bot, status: h.status, created_at: h.created_at, updated_at: h.updated_at, messages: rows.map(msgView) };
}
const msgView = (m) => ({ id: m.id, from: m.from_role, text: m.text, created_at: m.created_at });

// One message into the thread, from either side. The thread is NOT redacted:
// "call me on 555-0142" is the point of it. Status follows who spoke last:
// the visitor → open (waiting on the owner); the owner → answered (waiting on them).
export async function addHandoffMessage(env, id, from, text) {
  const h = await env.DB.prepare(`SELECT id, status FROM handoffs WHERE id = ?`).bind(id).first();
  if (!h) return { missing: true };
  if (h.status === "closed") return { closed: true };
  const clean = clip(text, PERSON_LIMITS.textChars);
  if (!clean) return { empty: true };
  if (from === "visitor") {
    const n = (await env.DB.prepare(`SELECT COUNT(*) n FROM handoff_messages WHERE handoff_id = ? AND from_role = 'visitor'`).bind(id).first())?.n || 0;
    if (n >= PERSON_LIMITS.visitorMessages) return { full: true };
  }
  const t = now();
  const r = await env.DB.prepare(`INSERT INTO handoff_messages (handoff_id, from_role, text, created_at) VALUES (?, ?, ?, ?)`).bind(id, from, clean, t).run();
  const status = from === "owner" ? "answered" : "open";
  await env.DB.prepare(`UPDATE handoffs SET status = ?, updated_at = ? WHERE id = ?`).bind(status, t, id).run();
  return { id: r.meta?.last_row_id, from, text: clean, created_at: t, status };
}

export async function closeHandoff(env, id) {
  const r = await env.DB.prepare(`UPDATE handoffs SET status = 'closed', updated_at = ? WHERE id = ? AND status != 'closed'`).bind(now(), id).run();
  return (r.meta?.changes || 0) > 0;
}

// Under the hood → Conversations: the list. status "open" = waiting on the
// owner, "waiting" = open + answered (anything not closed), "all" = everything.
// Each row carries the visitor's latest line, so the list reads at a glance.
export async function listHandoffs(env, { bot = "*", status = "waiting", limit = 100 } = {}) {
  const where = [], args = [];
  if (bot && bot !== "*") { where.push("h.bot = ?"); args.push(bot); }
  if (status === "open") where.push("h.status = 'open'");
  else if (status === "waiting") where.push("h.status != 'closed'");
  else if (status === "closed") where.push("h.status = 'closed'");
  const W = where.length ? "WHERE " + where.join(" AND ") : "";
  const sql = `SELECT h.id, h.bot, h.visitor, h.status, h.transcript, h.created_at, h.updated_at,
      (SELECT text FROM handoff_messages m WHERE m.handoff_id = h.id AND m.from_role = 'visitor' ORDER BY m.id DESC LIMIT 1) last_visitor,
      (SELECT COUNT(*) FROM handoff_messages m WHERE m.handoff_id = h.id) messages
    FROM handoffs h ${W} ORDER BY h.updated_at DESC LIMIT ?`;
  const rows = (await env.DB.prepare(sql).bind(...args, Math.min(Math.max(limit, 1), 500)).all()).results || [];
  const openCount = (await env.DB.prepare(`SELECT COUNT(*) n FROM handoffs WHERE status = 'open'`).first())?.n || 0;
  return {
    rows: rows.map((r) => {
      let last = r.last_visitor || "";
      if (!last) { try { last = [...JSON.parse(r.transcript || "[]")].reverse().find((m) => m.role === "user")?.content || ""; } catch {} }
      return { id: r.id, bot: r.bot, visitor: r.visitor, status: r.status, created_at: r.created_at, updated_at: r.updated_at, messages: r.messages, lastVisitor: String(last).slice(0, 200) };
    }),
    openCount,
  };
}

// One request in full, for the owner: the transcript and the whole thread.
export async function getHandoff(env, id) {
  const h = await env.DB.prepare(`SELECT id, bot, chat_id, visitor, transcript, status, created_at, updated_at FROM handoffs WHERE id = ?`).bind(id).first();
  if (!h) return null;
  let transcript = []; try { transcript = JSON.parse(h.transcript || "[]"); } catch {}
  const rows = (await env.DB.prepare(`SELECT id, from_role, text, created_at FROM handoff_messages WHERE handoff_id = ? ORDER BY id ASC LIMIT 500`).bind(id).all()).results || [];
  return { id: h.id, bot: h.bot, chatId: h.chat_id, visitor: h.visitor, status: h.status, created_at: h.created_at, updated_at: h.updated_at, transcript, messages: rows.map(msgView) };
}

// Tell the owner. Same webhook as the handoff actions (project.json →
// handoffActions.webhook), event "human-requested", and `text` carries the
// link straight to the request under the hood. No webhook = nothing to do.
export async function notifyHumanRequested(env, project, { id, visitor, transcript, note, url }) {
  const webhook = normaliseHandoffActions(project.handoffActions).webhook;
  if (!webhook) return "";
  const bot = { id: project.id || "", name: project.name || "" };
  const lastAsked = [...(transcript || [])].reverse().find((m) => m.role === "user")?.content || "";
  const payload = {
    event: "human-requested", bot, when: now(), visitor: visitor || "", handoffId: id,
    note: note || "", transcript, url,
    text: `[${bot.name}] a visitor wants to talk to a person${visitor ? ` · ${visitor}` : ""}\n${note ? `They said: ${note}\n` : ""}${lastAsked ? `Last asked: ${lastAsked}\n` : ""}Reply here: ${url}`,
  };
  try { return await sendWebhook(env, webhook, payload, bot); }
  catch (err) { console.error("human-requested webhook failed (continuing)", err?.message || err); return "handoff-webhook-failed"; }
}
