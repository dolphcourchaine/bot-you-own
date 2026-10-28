// ============================================================================
//  BOOKING AS AN ACTION — the bot puts the call on your calendar itself.
//
//  Booking mode used to end with a link: "here's the calendar, go pick a time".
//  With a provider configured, the bot offers real free times and books the
//  one the visitor picks. Configured per bot in project.json:
//
//    "booking": { "provider": "cal.com", "eventTypeId": 123, "timezone": "America/New_York", "durationNote": "a 20-minute intro call" }
//
//  plus ONE secret, CAL_API_KEY (Cloudflare → Worker → Settings → Variables &
//  Secrets; `.dev.vars` locally). No provider, no id, or no key = exactly the
//  old behaviour: the bot hands over `bookingUrl`. Nothing else changes.
//
//  HOW IT WORKS — a two-step conversation the model drives with two markers,
//  the same trick the intake job uses with "[INTAKE COMPLETE]":
//
//    1. The model decides the person fits and wants a call. It ends its reply
//       with a line "[BOOKING: OFFER]". This code takes the line out, asks the
//       calendar for the next free times (7 days, at most 6) and appends them
//       in plain English, with a request for name + email.      → booking-slots-offered
//    2. The visitor picks one and gives a name and an email. The model ends
//       with "[BOOKING: CONFIRM 2026-09-09T10:00 | Sam Jones | sam@x.com]".
//       This code checks that time is STILL free (the model can't invent one:
//       the time must match a slot the calendar returns right now), books it,
//       and swaps the line for a confirmation.                   → booking-created
//       Gone in the meantime → says so and offers fresh times.  → booking-failed
//       Calendar unreachable → falls back to the link.          → booking-provider-failed
//
//  The markers never reach the visitor, the audit log, or the streaming
//  "final" event: finish() in index.js runs stripBookingMarkers() on every
//  reply in booking mode. Everything here fails OPEN: any error means the
//  visitor gets the link (or the handoff contact), never a broken reply.
//
//  Cal.com is the first provider (public API v2, one API key). The calls are
//  the two small functions at the bottom; a second provider (Calendly) is
//  another pair of functions with the same shape, picked by `provider`.
// ============================================================================

const DEFAULT_BASE_URL = "https://api.cal.com/v2";   // project.json → booking.baseUrl overrides (tests point it at a fake)
const PROVIDERS = ["cal.com"];
const DAYS_AHEAD = 7;
const MAX_SLOTS = 6;
const TIMEOUT_MS = 8000;
// The "cal-api-version" header each endpoint wants, as the docs listed them on
// 2026-09-04 (https://cal.com/docs/api-reference/v2). If Cal.com ever rejects
// one, the status and message land in Workers Logs as {"event":"booking",…}.
const SLOTS_API_VERSION = "2024-09-04";
const BOOKINGS_API_VERSION = "2026-02-25";

// --- The markers the job prompt asks for (YourBots/_prompt/jobs/booking.md). ---
//     Tolerant of the ways a model mangles them: spacing, case, stray asterisks.
const OFFER_MARKER = /^[ \t]*[*_`]*\[\s*BOOKING\s*:\s*OFFER\s*\][*_`]*[ \t]*$/gim;
const CONFIRM_MARKER = /^[ \t]*[*_`]*\[\s*BOOKING\s*:\s*CONFIRM\s+([^\]|]+?)\s*\|\s*([^\]|]*?)\s*\|\s*([^\]|]*?)\s*\][*_`]*[ \t]*$/gim;
const ANY_MARKER = /^[ \t]*[*_`]*\[\s*BOOKING\s*:[^\]]*\][*_`]*[ \t]*$/gim;   // anything else that looks like one: removed, ignored
const EMAIL_SHAPE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

// The shape every project carries, whatever was (or wasn't) in project.json.
export function normaliseBooking(b) {
  b = b && typeof b === "object" ? b : {};
  const provider = String(b.provider || "").trim().toLowerCase();
  const baseUrl = String(b.baseUrl || "").trim().replace(/\/$/, "");
  const timezone = String(b.timezone || "").trim().slice(0, 64);
  return {
    provider: PROVIDERS.includes(provider) ? provider : "",
    eventTypeId: Math.max(0, Math.floor(Number(b.eventTypeId) || 0)),
    timezone: validTimezone(timezone) ? timezone : "America/New_York",
    durationNote: String(b.durationNote || "").trim().slice(0, 120),
    ...(baseUrl && /^https?:\/\/\S+$/.test(baseUrl) && baseUrl !== DEFAULT_BASE_URL ? { baseUrl: baseUrl.slice(0, 200) } : {}),
  };
}
function validTimezone(tz) {
  if (!tz) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

// "Live" = the bot can actually book: a provider, an event type, and the key.
export function bookingLive(env, project) {
  const b = normaliseBooking(project?.booking);
  return project?.mode === "booking" && b.provider === "cal.com" && b.eventTypeId > 0 && Boolean(env?.CAL_API_KEY);
}

// Take every booking marker out of a reply. Returns the clean text plus what
// the model asked for: `offer` (true/false) and `confirm` ({ start, name, email } or null).
export function stripBookingMarkers(text) {
  let s = String(text || "");
  const offer = OFFER_MARKER.test(s); OFFER_MARKER.lastIndex = 0;
  let confirm = null;
  const m = CONFIRM_MARKER.exec(s); CONFIRM_MARKER.lastIndex = 0;
  if (m) confirm = { start: m[1].trim(), name: m[2].trim().slice(0, 120), email: m[3].trim().toLowerCase().slice(0, 254) };
  const found = offer || Boolean(confirm) || ANY_MARKER.test(s); ANY_MARKER.lastIndex = 0;
  if (!found) return { text: s, found: false, offer: false, confirm: null };
  s = s.replace(OFFER_MARKER, "").replace(CONFIRM_MARKER, "").replace(ANY_MARKER, "").replace(/\n{3,}/g, "\n\n").trim();
  OFFER_MARKER.lastIndex = CONFIRM_MARKER.lastIndex = ANY_MARKER.lastIndex = 0;
  return { text: s, found: true, offer, confirm };
}

// --- THE STEP. Runs in finish() (index.js) on every reply in booking mode. ------
//     Takes the reply as the firewall left it; returns the reply the visitor
//     sees, the flags to add, and (when a booking was made) the booking for
//     the webhook. `who` is the visitor's email in email mode — used when the
//     model leaves the email out of the CONFIRM line.
export async function bookingStep(env, project, reply, { who = "", history = [] } = {}) {
  const out = { reply, flags: [], booking: null };
  const m = stripBookingMarkers(reply);
  if (!m.found) return out;
  out.reply = m.text;
  const live = bookingLive(env, project);
  // No provider: the marker is simply gone. The prompt never asks for it in
  // that case, but a model that emits one anyway must not break the reply.
  if (!live) return out;
  const b = normaliseBooking(project.booking);

  try {
    if (m.confirm) {
      const want = parseLocalStamp(m.confirm.start);
      const name = m.confirm.name;
      const email = EMAIL_SHAPE.test(m.confirm.email) ? m.confirm.email : (EMAIL_SHAPE.test(who) ? who : "");
      if (!want || !name || !email) {
        // The model jumped the gun. Ask for what's missing instead of guessing.
        out.flags.push("booking-incomplete");
        out.reply = join(out.reply, `Before I book it I need ${[!want && "the time you'd like (one of the ones offered)", !name && "your name", !email && "your email address"].filter(Boolean).join(", ")}.`);
        return out;
      }
      // Never invent a slot: the time must match one the calendar returns NOW.
      const slots = await listSlots(env, b, { from: want.dayStart, days: 2, max: 500 });
      const slot = slots.find((s) => localStamp(s.start, b.timezone) === want.stamp);
      if (!slot) return await reoffer(env, project, b, out, "That time isn't free any more.");
      const r = await createBooking(env, b, { start: slot.start, name, email, bot: project.id || "" });
      if (r.ok) {
        out.flags.push("booking-created");
        out.booking = { provider: b.provider, uid: r.uid, start: r.start || slot.start, end: r.end || "", when: formatSlot(r.start || slot.start, b.timezone), timezone: b.timezone, eventTypeId: b.eventTypeId, name, email };
        out.reply = join(out.reply, `Booked: ${out.booking.when} (${b.timezone}). You'll get an email from the calendar with the details${r.location ? ` and the link` : ""}.`);
        return out;
      }
      if (r.gone) return await reoffer(env, project, b, out, "That slot just went.");
      throw new Error(`create failed: ${r.status}`);
    }

    if (m.offer) {
      const slots = await listSlots(env, b, { from: new Date(), days: DAYS_AHEAD });
      if (!slots.length) {
        out.flags.push("booking-no-slots");
        out.reply = join(out.reply, `Nothing is free in the next ${DAYS_AHEAD} days.` + linkFallback(project));
        return out;
      }
      out.flags.push("booking-slots-offered");
      out.reply = join(out.reply, offerText(slots, b, { knowsEmail: EMAIL_SHAPE.test(who) || historyHasEmail(history) }));
    }
  } catch (err) {
    // The calendar is down, the key is wrong, the network hiccupped: say so
    // honestly with the link, and leave a line in the logs for the owner.
    console.error(JSON.stringify({ event: "booking", ok: false, provider: b.provider, bot: project.name, error: String(err?.message || err).slice(0, 200) }));
    out.flags = out.flags.filter((f) => f !== "booking-slots-offered");
    out.flags.push("booking-provider-failed");
    out.reply = join(out.reply, "I can't reach the calendar right now." + linkFallback(project));
  }
  return out;
}

// "That slot just went — here are the next ones." Fresh times, or the link if even that fails.
async function reoffer(env, project, b, out, why) {
  out.flags.push("booking-failed");
  const slots = await listSlots(env, b, { from: new Date(), days: DAYS_AHEAD });
  if (!slots.length) { out.flags.push("booking-no-slots"); out.reply = join(out.reply, `${why} Nothing else is free in the next ${DAYS_AHEAD} days.` + linkFallback(project)); return out; }
  out.flags.push("booking-slots-offered");
  out.reply = join(out.reply, `${why} ${offerText(slots, b, { knowsEmail: true, again: true })}`);
  return out;
}

function offerText(slots, b, { knowsEmail = false, again = false } = {}) {
  const list = slots.map((s) => `- ${formatSlot(s.start, b.timezone)}`).join("\n");
  const intro = again ? "Here are the next ones" : "I can do";
  const tail = again ? "Which of these works?" : (knowsEmail ? "Which works for you? And what name should I put on it?" : "Which works for you? I'll need a name and an email address to book it.");
  return `${intro} (${b.timezone}${b.durationNote ? `, ${b.durationNote}` : ""}):\n${list}\n\n${tail}`;
}
function linkFallback(project) {
  if (project.bookingUrl) return ` You can pick a time here: ${project.bookingUrl}`;
  if (project.handoffContact) return ` ${project.handoffContact}`;
  return "";
}
function join(a, b) { return [String(a || "").trim(), b].filter(Boolean).join("\n\n"); }
function historyHasEmail(history) {
  return (Array.isArray(history) ? history : []).some((m) => m.role === "user" && /[^\s@]+@[^\s@]+\.[^\s@]{2,}/.test(String(m.content || "")));
}

// --- Times, in the owner's timezone, without a library. ----------------------
// "Tue 9 Sep 2026, 10:00" — the year is there on purpose so the model can
// write the CONFIRM line (YYYY-MM-DDTHH:MM) without guessing.
export function formatSlot(iso, timezone) {
  const p = parts(iso, timezone);
  if (!p) return String(iso);
  return `${p.weekday} ${Number(p.day)} ${p.month} ${p.year}, ${p.hour}:${p.minute}`;
}
// The same instant as "YYYY-MM-DDTHH:MM" on the owner's clock — the key the
// visitor's choice is matched on, so the model's timezone maths never matters.
export function localStamp(iso, timezone) {
  const p = parts(iso, timezone);
  return p ? `${p.year}-${p.mon}-${p.day}T${p.hour}:${p.minute}` : "";
}
function parts(iso, timezone) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    const f = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const o = Object.fromEntries(f.formatToParts(d).filter((x) => x.type !== "literal").map((x) => [x.type, x.value]));
    const mon = String(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(o.month) + 1).padStart(2, "0");
    return { ...o, mon, hour: o.hour === "24" ? "00" : o.hour };
  } catch { return null; }
}
// What the model wrote after CONFIRM: "2026-09-09T10:00", with or without
// seconds / an offset / a space instead of the T. Only the wall-clock part counts.
function parseLocalStamp(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(s || "").trim());
  if (!m) return null;
  const stamp = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
  // A day either side, so the calendar window covers the slot whatever the offset.
  const dayStart = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`); dayStart.setUTCDate(dayStart.getUTCDate() - 1);
  return Number.isNaN(dayStart.getTime()) ? null : { stamp, dayStart };
}

// --- The provider calls. Cal.com API v2 — https://cal.com/docs/api-reference/v2 ----
//     Both throw on a network error / 5xx (the caller falls back to the link)
//     and return normally on a 4xx that means "no", so the caller can say why.
async function calFetch(env, b, path, init = {}, apiVersion) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${b.baseUrl || DEFAULT_BASE_URL}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${env.CAL_API_KEY}`, "cal-api-version": apiVersion, "content-type": "application/json", "user-agent": "bot-you-own", ...(init.headers || {}) },
      signal: ctl.signal,
    });
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body };
  } catch (err) {
    throw new Error(err?.name === "AbortError" ? `timeout after ${TIMEOUT_MS}ms` : String(err?.message || err));
  } finally { clearTimeout(timer); }
}

// GET /v2/slots → the next free start times, soonest first, at most MAX_SLOTS,
// never earlier than an hour from now. [{ start: "2026-09-09T10:00:00.000-04:00" }]
export async function listSlots(env, b, { from = new Date(), days = DAYS_AHEAD, max = MAX_SLOTS } = {}) {
  if (b.provider !== "cal.com") return [];
  const start = new Date(from); const end = new Date(start.getTime() + days * 86400000);
  const q = new URLSearchParams({ eventTypeId: String(b.eventTypeId), start: start.toISOString(), end: end.toISOString(), timeZone: b.timezone });
  const r = await calFetch(env, b, `/slots?${q}`, { method: "GET" }, SLOTS_API_VERSION);
  if (!r.ok) throw new Error(`slots ${r.status} ${String(r.body?.error?.message || r.body?.message || "").slice(0, 120)}`);
  const days_ = r.body?.data && typeof r.body.data === "object" ? Object.values(r.body.data) : [];
  const soon = Date.now() + 3600000;
  return days_.flat()
    .map((s) => ({ start: String(s?.start || s || "") }))
    .filter((s) => !Number.isNaN(new Date(s.start).getTime()) && new Date(s.start).getTime() > soon)
    .sort((x, y) => new Date(x.start) - new Date(y.start))
    .slice(0, max);
}

// POST /v2/bookings → { ok, uid, start, end, location } · a 4xx = { ok:false, gone:true }
export async function createBooking(env, b, { start, name, email, bot }) {
  if (b.provider !== "cal.com") return { ok: false, status: 0 };
  const body = {
    start: new Date(start).toISOString(),                    // Cal.com wants UTC
    eventTypeId: b.eventTypeId,
    attendee: { name, email, timeZone: b.timezone, language: "en" },
    metadata: { source: "bot-you-own", bot: String(bot || "").slice(0, 40) },
  };
  const r = await calFetch(env, b, "/bookings", { method: "POST", body: JSON.stringify(body) }, BOOKINGS_API_VERSION);
  console[r.ok ? "log" : "error"](JSON.stringify({ event: "booking", ok: r.ok, provider: "cal.com", status: r.status, start: body.start, uid: r.body?.data?.uid || "" }));
  if (r.ok) { const d = r.body?.data || {}; return { ok: true, uid: String(d.uid || d.id || ""), start: d.start || "", end: d.end || "", location: d.location || "" }; }
  if (r.status >= 500) throw new Error(`bookings ${r.status}`);
  return { ok: false, status: r.status, gone: true, error: String(r.body?.error?.message || r.body?.message || "").slice(0, 200) };
}

// What "Under the hood" shows: enough to check the setup, never the key.
export function bookingView(env, project) {
  const b = normaliseBooking(project?.booking);
  const live = bookingLive(env, project);
  return {
    provider: b.provider || "(none — the bot hands over bookingUrl)",
    eventTypeId: b.eventTypeId || "(not set)",
    timezone: b.timezone,
    durationNote: b.durationNote || "(empty)",
    baseUrl: b.baseUrl || DEFAULT_BASE_URL,
    apiKey: env?.CAL_API_KEY ? "CAL_API_KEY is set" : "CAL_API_KEY is not set (npx wrangler secret put CAL_API_KEY)",
    bookingUrl: project?.bookingUrl || "(empty)",
    status: project?.mode !== "booking" ? "not a booking bot (mode ≠ booking)" : live ? "live — the bot offers times and books them" : "link only — " + (!b.provider ? "no provider" : !b.eventTypeId ? "no eventTypeId" : "no CAL_API_KEY"),
  };
}
