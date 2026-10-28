import { CONFIG } from "../../YourBots/config.js";
// ============================================================================
//  CHAT HISTORY ON THE SERVER — so an identified visitor's conversations follow
//  them to any computer (with the return window in Engine/identity/devices.js).
//
//  In plain English:
//   · A visitor who has joined a bot with their email (modes email / allow /
//     key+email) gets their chats mirrored here: every thread, every turn, the
//     FULL text. Anonymous visitors and open bots stay in the browser only —
//     there is no identity to key on, and nothing to fetch on another machine.
//   · Two tables, and why they are NOT the audit table:
//       conversations   (index.js → logTurn)  every turn, REDACTED — emails,
//                       phones, card-like numbers replaced — for the owner's
//                       Audit / Leads / Gaps views. Write-once, never shown back
//                       to a visitor. That is the project's default posture.
//       chat_threads +  THIS file. The visitor's own resumable history, raw text,
//       chat_messages   readable only with their identity (the device key) — and
//                       by the admin, read-only, for support ("see what they see").
//     Keeping both is deliberate: the audit stays redacted whatever happens
//     here, and the history stays exact because a redacted transcript would be
//     useless to resume. Say it in the docs: this is raw conversation text on
//     the server, which the redaction default was there to avoid. "History
//     anywhere" needs it; delete the thread and it is gone (DELETE below).
//   · Who: the row belongs to (bot, user_id). user_id is the identity hash, so
//     the same email on two bots is two separate histories, as everywhere else.
//   · Routes (visitor, x-device-key + the bot's own door):
//       GET    /api/chats?bot=<id>            all threads, with messages, newest first
//       PUT    /api/chats/<id>  {bot, title, messages, meta}   create or replace one thread
//       PATCH  /api/chats/<id>  {bot, title}  rename
//       DELETE /api/chats/<id>?bot=<id>       remove it (messages too)
//     Admin, read-only:
//       GET    /api/admin/chats/users?bot=<id>          who has history here
//       GET    /api/admin/chats?bot=<id>&email=<email>  that person's threads
//   · Limits: 50 threads a person a bot, 200 messages a thread, 8 KB a message,
//     256 KB a request (readJson). The page trims the same way it does locally.
//   · Fails closed on identity (no user → 401). Fails OPEN as a feature: if the
//     database is down the page keeps its local copy and carries on.
// ============================================================================

const MAX_THREADS = 50, MAX_MESSAGES = 200, MAX_CONTENT = 8000, MAX_TITLE = 120, MAX_META = 64 * 1024;
const nowIso = () => new Date().toISOString();

let SCHEMA_OK = false;
export async function ensureChatSchema(env) {
  if (SCHEMA_OK || !env.DB) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS chat_threads (id INTEGER PRIMARY KEY AUTOINCREMENT, bot TEXT NOT NULL, user_id TEXT NOT NULL, client_id TEXT NOT NULL, title TEXT, meta TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_threads_owner ON chat_threads(bot, user_id, client_id)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, meta TEXT, created_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id, id)`),
  ]);
  SCHEMA_OK = true;
}

const cleanClientId = (id) => { const s = String(id || "").trim(); return /^[a-z0-9_-]{1,40}$/i.test(s) ? s : ""; };
const cleanTitle = (t) => String(t || "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
// A message as the page keeps it: role + content, plus the small extras it draws
// (flags, sources, note, talk, toPerson). Anything else is dropped.
function cleanMessage(m) {
  if (!m || typeof m !== "object") return null;
  const role = ["user", "assistant", "person"].includes(m.role) ? m.role : "";
  if (!role || typeof m.content !== "string") return null;
  const meta = {};
  if (Array.isArray(m.flags) && m.flags.length) meta.flags = m.flags.map((f) => String(f).slice(0, 60)).slice(0, 20);
  if (Array.isArray(m.sources) && m.sources.length) meta.sources = m.sources.map((f) => String(f).slice(0, 200)).slice(0, 20);
  if (m.note) meta.note = true;
  if (m.talk) meta.talk = true;
  if (m.toPerson) meta.toPerson = true;
  // /chat: which model wrote an answer, and which column (lane) of a comparison it sits in.
  if (typeof m.model === "string" && /^@cf\/[\w.\-]+\/[\w.\-]+$/.test(m.model)) meta.model = m.model.slice(0, 120);
  if (Number.isInteger(m.lane) && m.lane >= 0 && m.lane < 12) meta.lane = m.lane;
  // /chat: small thumbnails of the pictures sent with a message (the full pictures are never kept).
  if (Array.isArray(m.thumbs) && m.thumbs.length) { const t = m.thumbs.filter((u) => typeof u === "string" && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(u) && u.length <= 12000).slice(0, 4); if (t.length) meta.thumbs = t; }
  if (m.blind) meta.blind = true;
  return { role, content: m.content.slice(0, MAX_CONTENT), meta };
}
// The thread's own extras: the handoff (so "talk to a person" resumes anywhere) and attachments.
function cleanMeta(meta) {
  if (!meta || typeof meta !== "object") return null;
  const out = {};
  if (meta.handoff && typeof meta.handoff === "object") out.handoff = { id: String(meta.handoff.id || "").slice(0, 64), status: String(meta.handoff.status || "").slice(0, 20), since: Number(meta.handoff.since) || 0 };
  if (Array.isArray(meta.attachments) && meta.attachments.length) out.attachments = meta.attachments.slice(0, 3).map((a) => ({ name: String(a?.name || "").slice(0, 200), chars: Number(a?.chars) || 0, text: String(a?.text || "").slice(0, 20000) }));
  // /chat: the comparison's columns — the model in each, and whether it was stopped (at which row).
  if (Array.isArray(meta.lanes) && meta.lanes.length) out.lanes = meta.lanes.slice(0, 12).map((l) => ({ model: String(l?.model || "").slice(0, 120), stoppedAt: Number.isInteger(l?.stoppedAt) ? l.stoppedAt : null, from: Number(l?.from) || 0 }));
  const s = JSON.stringify(out);
  return s.length > MAX_META || s === "{}" ? null : s;
}
const parse = (s, dflt) => { try { return s ? JSON.parse(s) : dflt; } catch { return dflt; } };

// Every thread for one person on one bot, messages included, newest first.
// An attached file's text lives in a thread's meta. After attachments.retentionDays it is
// dropped from the server copy (the chat itself stays). Runs at most once an hour per isolate,
// on the way through a list — no cron to set up.
let SWEPT_AT = 0;
async function sweepAttachments(env) {
  const days = Number(CONFIG.attachments?.retentionDays);
  if (!(days > 0) || Date.now() - SWEPT_AT < 3600 * 1000) return;
  SWEPT_AT = Date.now();
  try {
    const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();
    const r = await env.DB.prepare(`UPDATE chat_threads SET meta = json_remove(meta, '$.attachments') WHERE updated_at < ? AND meta LIKE '%"attachments"%'`).bind(cutoff).run();
    if (r?.meta?.changes) console.log(JSON.stringify({ event: "attachments-swept", threads: r.meta.changes, olderThanDays: days }));
  } catch (err) { console.warn("attachment sweep failed", err?.message || err); }
}
export async function listThreads(env, bot, userId) {
  await ensureChatSchema(env);
  sweepAttachments(env);
  const threads = (await env.DB.prepare(`SELECT id, client_id, title, meta, created_at, updated_at FROM chat_threads WHERE bot = ? AND user_id = ? ORDER BY updated_at DESC LIMIT ?`).bind(bot, userId, MAX_THREADS).all()).results || [];
  if (!threads.length) return [];
  const ids = threads.map((t) => t.id);
  const msgs = (await env.DB.prepare(`SELECT thread_id, role, content, meta, created_at FROM chat_messages WHERE thread_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`).bind(...ids).all()).results || [];
  const by = {}; for (const m of msgs) (by[m.thread_id] ||= []).push({ role: m.role, content: m.content, ...parse(m.meta, {}) });
  return threads.map((t) => ({ id: t.client_id, title: t.title || "", ...(parse(t.meta, null) || {}), messages: by[t.id] || [], created_at: t.created_at, updated_at: t.updated_at }));
}

// Create or replace one thread: the page sends the whole chat each time (they are small).
export async function putThread(env, bot, userId, clientId, body) {
  await ensureChatSchema(env);
  clientId = cleanClientId(clientId);
  if (!clientId) return { ok: false, status: 400, error: "bad thread id" };
  const messages = (Array.isArray(body?.messages) ? body.messages : []).map(cleanMessage).filter(Boolean).slice(-MAX_MESSAGES);
  const title = cleanTitle(body?.title) || cleanTitle(messages.find((m) => m.role === "user")?.content).slice(0, 40);
  const meta = cleanMeta(body?.meta);
  const now = nowIso();
  const existing = await env.DB.prepare(`SELECT id FROM chat_threads WHERE bot = ? AND user_id = ? AND client_id = ?`).bind(bot, userId, clientId).first();
  let id = existing?.id;
  if (id) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE chat_threads SET title = ?, meta = ?, updated_at = ? WHERE id = ?`).bind(title, meta, now, id),
      env.DB.prepare(`DELETE FROM chat_messages WHERE thread_id = ?`).bind(id),
    ]);
  } else {
    const n = (await env.DB.prepare(`SELECT COUNT(*) n FROM chat_threads WHERE bot = ? AND user_id = ?`).bind(bot, userId).first())?.n || 0;
    if (n >= MAX_THREADS) {
      // Room for one more: the oldest goes, like the page's own 50-chat cap.
      const old = await env.DB.prepare(`SELECT id FROM chat_threads WHERE bot = ? AND user_id = ? ORDER BY updated_at ASC LIMIT 1`).bind(bot, userId).first();
      if (old) await env.DB.batch([env.DB.prepare(`DELETE FROM chat_messages WHERE thread_id = ?`).bind(old.id), env.DB.prepare(`DELETE FROM chat_threads WHERE id = ?`).bind(old.id)]);
    }
    const r = await env.DB.prepare(`INSERT INTO chat_threads (bot, user_id, client_id, title, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(bot, userId, clientId, title, meta, now, now).run();
    id = r.meta?.last_row_id;
    if (!id) id = (await env.DB.prepare(`SELECT id FROM chat_threads WHERE bot = ? AND user_id = ? AND client_id = ?`).bind(bot, userId, clientId).first())?.id;
  }
  if (messages.length) {
    const stmt = env.DB.prepare(`INSERT INTO chat_messages (thread_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?)`);
    // D1 batches are transactional; 200 statements at most.
    await env.DB.batch(messages.map((m) => stmt.bind(id, m.role, m.content, Object.keys(m.meta).length ? JSON.stringify(m.meta) : null, now)));
  }
  return { ok: true, id: clientId, title, messages: messages.length, updated_at: now };
}

export async function renameThread(env, bot, userId, clientId, title) {
  await ensureChatSchema(env);
  clientId = cleanClientId(clientId); title = cleanTitle(title);
  if (!clientId) return { ok: false, status: 400, error: "bad thread id" };
  const r = await env.DB.prepare(`UPDATE chat_threads SET title = ?, updated_at = ? WHERE bot = ? AND user_id = ? AND client_id = ?`).bind(title, nowIso(), bot, userId, clientId).run();
  return Number(r?.meta?.changes || 0) ? { ok: true, id: clientId, title } : { ok: false, status: 404, error: "no such thread" };
}

export async function deleteThread(env, bot, userId, clientId) {
  await ensureChatSchema(env);
  clientId = cleanClientId(clientId);
  if (!clientId) return { ok: false, status: 400, error: "bad thread id" };
  const row = await env.DB.prepare(`SELECT id FROM chat_threads WHERE bot = ? AND user_id = ? AND client_id = ?`).bind(bot, userId, clientId).first();
  if (!row) return { ok: true, id: clientId, removed: 0 };
  await env.DB.batch([env.DB.prepare(`DELETE FROM chat_messages WHERE thread_id = ?`).bind(row.id), env.DB.prepare(`DELETE FROM chat_threads WHERE id = ?`).bind(row.id)]);
  return { ok: true, id: clientId, removed: 1 };
}

// Admin: who has history on this bot (email, threads, last activity). Read-only.
export async function usersWithHistory(env, bot) {
  await ensureChatSchema(env);
  const rows = (await env.DB.prepare(`SELECT u.email, u.last_seen, COUNT(t.id) threads, MAX(t.updated_at) last_chat FROM id_users u LEFT JOIN chat_threads t ON t.user_id = u.id AND t.bot = u.bot WHERE u.bot = ? GROUP BY u.id ORDER BY COALESCE(MAX(t.updated_at), u.last_seen) DESC LIMIT 500`).bind(bot).all()).results || [];
  return rows.map((r) => ({ email: r.email, threads: Number(r.threads) || 0, last_seen: r.last_seen, last_chat: r.last_chat }));
}
