// ============================================================================
//  HANDOFF ACTIONS — when the bot hands off, tell someone.
//
//  A handoff that only prints a phone number is a handoff the owner never
//  hears about. This file turns it into an action: a webhook (Zapier, Make,
//  n8n, a Slack incoming webhook) and/or an email, configured per bot in
//  project.json → "handoffActions", run AFTER the reply has gone out.
//
//    "handoffActions": { "webhook": "", "email": "", "on": ["handoff", "intake-complete"] }
//
//  Three things can trigger it ("on"):
//    handoff          the reply was a real decline: the firewall had to append the
//                     contact (flag handoff-appended) or the reply contains the
//                     bot's handoffText. Injection / rate-limit / model-error turns
//                     are NOT handoffs — those are the firewall doing its job.
//    intake-complete  an intake bot collected everything. The job prompt tells the
//                     model to end its summary with the line "[INTAKE COMPLETE]";
//                     the code detects that line, strips it, and fires.
//    booking          a booking bot put a call on the calendar (Engine/worker/booking.js).
//                     The payload carries the booking: when, name, email, uid.
//    every-turn       every turn, blocked ones included. Off by default: noisy.
//
//  Everything here fails OPEN and never touches the reply: the visitor got their
//  answer before any of this runs. A webhook that is down costs the owner one
//  notification and one line in the logs, nothing else.
// ============================================================================

import { redact } from "./firewall.js";

export const HANDOFF_EVENTS = ["handoff", "intake-complete", "booking", "every-turn"];
const DEFAULT_ON = ["handoff", "intake-complete", "booking"];
const EMAIL_SHAPE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const TIMEOUT_MS = 5000;

// The marker the intake job prompt asks for. Meant to be on a line of its own, but a
// model will glue it to the end of a sentence ("…confirm on?[INTAKE COMPLETE]"), so it
// is matched ANYWHERE and never reaches a visitor. Tolerant of spacing, case, an
// underscore, stray asterisks.
const INTAKE_MARKER = /[ \t]*[*_]*\[\s*INTAKE[\s_-]*COMPLETE\s*\][*_]*[ \t]*/gi;
// The summary is only "done" when it has no unanswered slots and isn't still asking.
const UNANSWERED = /\((awaiting|pending|not (yet )?provided|to be confirmed|tbd|none|unknown|—|-)\)|awaiting response|not provided yet/i;

// The shape every project carries, whatever was (or wasn't) in project.json.
export function normaliseHandoffActions(a) {
  a = a && typeof a === "object" ? a : {};
  const webhook = String(a.webhook || "").trim();
  const email = String(a.email || "").trim().toLowerCase();
  return {
    webhook: /^https?:\/\/\S+$/.test(webhook) ? webhook.slice(0, 600) : "",
    email: EMAIL_SHAPE.test(email) ? email.slice(0, 254) : "",
    on: Array.isArray(a.on) ? a.on.map(String).filter((e) => HANDOFF_EVENTS.includes(e)) : [...DEFAULT_ON],
  };
}

// The heading the intake prompt asks for on the finished summary. Both the
// heading AND the marker have to be there before we tell anyone: a model that
// slips the marker into an ordinary question turn (it happens) fires nothing.
const INTAKE_SUMMARY = /pass on/i;

// Strip the "[INTAKE COMPLETE]" line the intake prompt asks for. Returns the
// clean text, whether the marker was there, and whether this really is the
// finished summary (`done`). Runs on every reply so the marker can never reach
// a visitor or the audit log, whatever mode the bot is in.
export function stripIntakeMarker(text) {
  const found = INTAKE_MARKER.test(String(text || ""));
  INTAKE_MARKER.lastIndex = 0;
  if (!found) return { text, found: false, done: false };
  const clean = String(text).replace(INTAKE_MARKER, "").replace(/\n{3,}/g, "\n\n").trim();
  INTAKE_MARKER.lastIndex = 0;
  const asksMore = /\?\s*$/.test(clean) || (clean.match(/\?/g) || []).length >= 2;
  return { text: clean, found: true, done: INTAKE_SUMMARY.test(clean) && !UNANSWERED.test(clean) && !asksMore };
}

// An intake bot is told ONE question per message. When the model dumps three anyway,
// keep the text up to and including the first question and drop the rest — the
// visitor answers one thing, the bot asks the next. A finished summary is left alone.
export function oneQuestion(text) {
  const t = String(text || "");
  if (INTAKE_SUMMARY.test(t)) return { text: t, trimmed: false };
  const qs = [...t.matchAll(/\?/g)].map((m) => m.index);
  if (qs.length < 2) return { text: t, trimmed: false };
  // cut after the first question mark, at the end of that line/sentence
  let cut = qs[0] + 1;
  const rest = t.slice(cut);
  const nl = rest.search(/\n/); if (nl >= 0 && nl <= 2) cut += nl;
  return { text: t.slice(0, cut).trim(), trimmed: true };
}

// Which ONE event this turn is, if any, given what the bot is listening for.
// Most specific wins: an intake summary is not also "a handoff"; a handoff on a
// bot that only listens for every-turn still fires as every-turn.
export function handoffEvent(project, reply, flags) {
  const on = normaliseHandoffActions(project.handoffActions).on;
  if (!on.length) return "";
  const firewallTurn = flags.some((f) => /blocked|error|rate-limited/.test(f));
  const declined = !firewallTurn && (flags.includes("handoff-appended") || (project.handoffText && String(reply).includes(project.handoffText)));
  const candidates = [
    flags.includes("intake-complete") && "intake-complete",
    flags.includes("booking-created") && "booking",
    declined && "handoff",
    "every-turn",
  ].filter(Boolean);
  return candidates.find((e) => on.includes(e)) || "";
}

// Run the configured actions for one turn. Returns the outcome flags to add to
// the audit row: handoff-webhook-sent / -failed, handoff-email-sent / -failed / -skipped.
export async function runHandoffActions(env, config, { project, event, question, reply, history, flags, who, url, booking = null }) {
  const actions = normaliseHandoffActions(project.handoffActions);
  if (!actions.webhook && !actions.email) return [];
  const bot = { id: project.id || "", name: project.name || "" };
  const transcript = (Array.isArray(history) ? history : []).slice(-8).map((m) => ({ role: m.role, content: redact(m.content) }));
  const q = redact(question), a = redact(reply);
  const payload = {
    event, bot, when: new Date().toISOString(),
    visitor: who || "",                      // the email in email mode, "admin" for admin test turns, else ""
    question: q, reply: a, transcript, flags, url,
    // Slack incoming webhooks render "text" as the message; Zapier/Make/n8n see every field.
    text: `[${bot.name}] ${event}${who ? ` · ${who}` : ""}\nAsked: ${q}\nBot: ${a}`,
    // event "booking": what was booked — name and email are kept on purpose, like `visitor`.
    ...(booking ? { booking, text: `[${bot.name}] booking · ${booking.name} <${booking.email}> · ${booking.when} (${booking.timezone})` } : {}),
  };
  const out = [];
  if (actions.webhook) out.push(await sendWebhook(env, actions.webhook, payload, bot));
  if (actions.email) out.push(await sendEmail(env, config, actions.email, payload, bot));
  return out.filter(Boolean);
}

export async function sendWebhook(env, webhook, payload, bot) {
  let host = "";
  try { host = new URL(webhook).host; } catch {}
  const body = JSON.stringify(payload);
  const headers = { "content-type": "application/json", "user-agent": "bot-you-own", "x-handoff-event": payload.event };
  // Optional: sign the raw body so the receiver can prove it came from this bot.
  if (env.HANDOFF_WEBHOOK_SECRET) headers["x-handoff-signature"] = await hmacHex(env.HANDOFF_WEBHOOK_SECRET, body);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(webhook, { method: "POST", headers, body, signal: ctl.signal });
    const ok = r.ok;
    console[ok ? "log" : "error"](JSON.stringify({ event: "handoff-action", ok, kind: "webhook", bot: bot.name, trigger: payload.event, host, status: r.status }));
    return ok ? "handoff-webhook-sent" : "handoff-webhook-failed";
  } catch (err) {
    console.error(JSON.stringify({ event: "handoff-action", ok: false, kind: "webhook", bot: bot.name, trigger: payload.event, host, error: String(err?.name === "AbortError" ? `timeout after ${TIMEOUT_MS}ms` : err?.message || err).slice(0, 200) }));
    return "handoff-webhook-failed";
  } finally { clearTimeout(timer); }
}

// Email goes through Cloudflare's Email Sending binding (wrangler.jsonc → send_email,
// commented out by default: it needs a domain you've onboarded to Email Sending).
// No binding, or no verified "from" address → skipped, one warning, nothing else.
async function sendEmail(env, config, to, payload, bot) {
  const from = String(config?.handoffEmailFrom || "").trim();
  if (!env.SEND_EMAIL || !from) {
    console.warn(JSON.stringify({ event: "handoff-action", ok: false, kind: "email", bot: bot.name, trigger: payload.event, skipped: !env.SEND_EMAIL ? "no SEND_EMAIL binding (wrangler.jsonc → send_email)" : "no handoffEmailFrom in YourBots/config.js" }));
    return "handoff-email-skipped";
  }
  try {
    const lines = payload.transcript.map((m) => `${m.role === "user" ? "Visitor" : "Bot"}: ${m.content}`).join("\n\n");
    await env.SEND_EMAIL.send({
      to, from: { email: from, name: bot.name || "Your bot" },
      subject: `[${bot.name}] ${payload.event}${payload.visitor ? ` from ${payload.visitor}` : ""}`,
      text: `${payload.text}\n\nLast turns:\n\n${lines}\n\n${payload.url}`,
    });
    console.log(JSON.stringify({ event: "handoff-action", ok: true, kind: "email", bot: bot.name, trigger: payload.event }));
    return "handoff-email-sent";
  } catch (err) {
    console.error(JSON.stringify({ event: "handoff-action", ok: false, kind: "email", bot: bot.name, trigger: payload.event, error: String(err?.message || err).slice(0, 200) }));
    return "handoff-email-failed";
  }
}

// hex(HMAC-SHA256(secret, body)) — what goes in x-handoff-signature.
async function hmacHex(secret, body) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// What "Under the hood" shows: enough to check the setup, never the full URL.
export function handoffActionsView(env, config, project) {
  const a = normaliseHandoffActions(project.handoffActions);
  let host = "";
  try { host = a.webhook ? new URL(a.webhook).host : ""; } catch {}
  return {
    webhookHost: host || "(none)",
    email: a.email || "(none)",
    on: a.on,
    secret: env.HANDOFF_WEBHOOK_SECRET ? "set (x-handoff-signature is sent)" : "not set (no signature header)",
    emailBinding: env.SEND_EMAIL ? "bound (wrangler.jsonc → send_email)" : "not bound — emails are skipped (wrangler.jsonc → send_email is commented out)",
    emailFrom: String(config?.handoffEmailFrom || "") || "(empty — set YourBots/config.js → handoffEmailFrom)",
  };
}
