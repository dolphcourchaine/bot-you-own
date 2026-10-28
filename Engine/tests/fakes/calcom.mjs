#!/usr/bin/env node
// ============================================================================
//  A FAKE Cal.com — for testing booking mode without a Cal.com account.
//
//  NOT the real API. It serves the two endpoints Engine/worker/booking.js uses,
//  with responses shaped like the Cal.com API v2 docs, and writes every booking
//  it receives to a file so a test can check what was sent.
//
//    node Engine/tests/fakes/calcom.mjs                 # http://localhost:8781
//    PORT=8781 LOG=/tmp/calcom-fake.jsonl node Engine/tests/fakes/calcom.mjs
//
//  Point a bot at it:  project.json → "booking": { …, "baseUrl": "http://localhost:8781/v2" }
//  and put CAL_API_KEY=test-key in .dev.vars.
//
//    GET  /v2/slots?eventTypeId=&start=&end=&timeZone=   → 10:00 and 14:00 (America/New_York) on each weekday in the window
//    POST /v2/bookings                                   → 201 with a booking; appended to LOG as one JSON line
//    POST /__control  { "fail": 500 }                    → every request after this returns that status (0 = behave again)
//    POST /__control  { "reset": true }                  → forget the taken slots and the failure
//    GET  /__state                                       → what it has seen (requests, bookings, mode)
//
//  A booked slot disappears from /v2/slots and a second booking of it gets a 400,
//  like the real thing ("slot no longer available").
// ============================================================================
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const PORT = Number(process.env.PORT || 8781);
const LOG = process.env.LOG || "";
const OFFSET = "-04:00";                       // America/New_York in September (EDT). Good enough for a fake.
const state = { fail: 0, taken: new Set(), requests: [], bookings: [] };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let raw = ""; for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : {};
  const headers = { authorization: req.headers.authorization || "", "cal-api-version": req.headers["cal-api-version"] || "" };
  const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

  if (url.pathname === "/__control") { if ("fail" in body) state.fail = Number(body.fail) || 0; if (body.reset) { state.fail = 0; state.taken.clear(); state.bookings = []; state.requests = []; } return send(200, { ok: true, fail: state.fail }); }
  if (url.pathname === "/__state") return send(200, { fail: state.fail, taken: [...state.taken], requests: state.requests, bookings: state.bookings });

  state.requests.push({ method: req.method, path: url.pathname + url.search, headers, body });
  if (state.fail) return send(state.fail, { status: "error", error: { message: `fake failure ${state.fail}` } });
  if (!/^Bearer \S+$/.test(headers.authorization)) return send(401, { status: "error", error: { message: "Unauthorized" } });

  if (req.method === "GET" && url.pathname === "/v2/slots") {
    const start = new Date(url.searchParams.get("start") || Date.now());
    const end = new Date(url.searchParams.get("end") || Date.now() + 7 * 86400000);
    const data = {};
    for (let d = new Date(start.toISOString().slice(0, 10)); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const day = d.toISOString().slice(0, 10);
      if ([0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay())) continue;   // no weekends
      for (const hm of ["10:00", "14:00"]) {
        const iso = `${day}T${hm}:00.000${OFFSET}`;
        const t = new Date(iso);
        if (t < start || t > end || state.taken.has(t.toISOString())) continue;
        (data[day] ||= []).push({ start: iso });
      }
    }
    return send(200, { status: "success", data });
  }

  if (req.method === "POST" && url.pathname === "/v2/bookings") {
    const startIso = new Date(body.start || "").toISOString();
    if (state.taken.has(startIso)) return send(400, { status: "error", error: { code: "BadRequestException", message: "User either already has booking at this time or is not available" } });
    if (!body.eventTypeId || !body.attendee?.name || !body.attendee?.email) return send(400, { status: "error", error: { message: "eventTypeId, attendee.name and attendee.email are required" } });
    state.taken.add(startIso);
    const uid = "fake_" + Math.random().toString(36).slice(2, 10);
    const booking = { id: state.bookings.length + 1, uid, title: `Intro call between Owner and ${body.attendee.name}`, start: startIso, end: new Date(new Date(startIso).getTime() + 30 * 60000).toISOString(), duration: 30, status: "accepted", location: "https://meet.example.com/" + uid, eventTypeId: body.eventTypeId, attendees: [{ name: body.attendee.name, email: body.attendee.email, timeZone: body.attendee.timeZone || "UTC", language: body.attendee.language || "en" }], metadata: body.metadata || {} };
    state.bookings.push({ received: body, headers, booking });
    if (LOG) appendFileSync(LOG, JSON.stringify({ received: body, headers, booking }) + "\n");
    return send(201, { status: "success", data: booking });
  }
  send(404, { status: "error", error: { message: `fake cal.com: no route ${req.method} ${url.pathname}` } });
});
server.listen(PORT, () => console.log(`fake cal.com on http://localhost:${PORT}  (not the real API)${LOG ? ` · bookings → ${LOG}` : ""}`));
