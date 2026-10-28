// ============================================================================
//  THE JOBS (modes) — loader
//
//  Each job is a plain Markdown file in prompt/jobs/<mode>.md with three
//  headings: "# Role", "# What a good answer looks like", "# Done when".
//  A project picks one with "mode" in its project.json. One project = one job.
//  Want two jobs? Make two projects.
//
//  Adding a job: add a file to prompt/jobs/. That's it — scripts/discover.mjs
//  registers it at build. Mode-specific extras (intake questions, booking rules,
//  next steps) come from the project's project.json.
// ============================================================================

import { JOB_FILES } from "./jobs.generated.js";
import { CONFIG } from "../../YourBots/config.js";

const BLURBS = {
  assistant: "The ChatGPT-style clone. Helps with anything; uses the files first when they apply.",
  answer: "Answers the question you get eleven times a week. Start here.",
  intake: "Asks the questions you always ask before you can quote, then hands you a clean summary.",
  booking: "Works out whether a call makes sense, then sends the right people to your calendar.",
  concierge: "Answers the question, then points at the right next thing you offer.",
  internal: "Answers for your TEAM, not your customers. Policies, SOPs, how we do things here.",
  imported: "You had a custom GPT or a Project. Now it's yours, on your own infrastructure.",
};

export const MODES = Object.fromEntries(
  Object.entries(JOB_FILES).map(([id, md]) => [id, { id, label: id, blurb: BLURBS[id] || "", file: `YourBots/_prompt/jobs/${id}.md`, ...parseJob(md) }])
);

// withExtras=false gives just the role and shape — the part the leak check
// protects. The extras (intake questions, booking rules, next steps) are the
// owner's own words and the bot is MEANT to say them out loud, so they are not.
export function modeBlock(project, { withExtras = true, bookingLive = false } = {}) {
  const base = MODES[project.mode] || MODES.answer;
  const own = project.prompt?.[`jobs/${project.mode}.md`];   // YourBots/<name>/prompt/jobs/<mode>.md
  const mode = own ? { ...base, ...parseJob(own) } : base;
  const extras = [];
  if (!withExtras) return `${mode.role}\n\nWhat a good answer looks like:\n${mode.shape}`;
  if (project.mode === "intake" && project.intakeQuestions?.length) {
    extras.push(`What to collect, in this order, one at a time:\n` + project.intakeQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n"));
  }
  if (project.mode === "booking") {
    if (project.bookingFitRules) extras.push(`Who a call is for:\n${project.bookingFitRules}`);
    // A calendar is wired up (Engine/worker/booking.js): the bot books the call itself
    // with two marker lines, instead of handing over the link.
    if (bookingLive) extras.push(BOOKING_LIVE);
    else if (project.bookingUrl) extras.push(`The booking link: ${project.bookingUrl}`);
    if (project.booking?.durationNote) extras.push(`The call is ${project.booking.durationNote}.`);
  }
  if (project.mode === "concierge") {
    // The community (YourBots/config.js → community) rides along as the last step of a
    // bot that asks for it, so an attendee changes ONE line and every guide follows.
    const steps = [...(project.nextSteps || [])];
    const c = CONFIG.community;
    if (project.communityStep && c && c.show !== false && c.url && !steps.some((s) => s.link === c.url)) steps.push({ name: `Join ${c.name || "the community"}`, who: c.pitch || "anyone who wants help and the people doing this", link: c.url });
    if (steps.length) extras.push(`What you may point people at:\n` + steps.map((s) => `- ${s.name} — for ${s.who}. ${s.link || "(no link)"}`).join("\n"));
  }
  return `${mode.role}\n\nWhat a good answer looks like:\n${mode.shape}${extras.length ? "\n\n" + extras.join("\n\n") : ""}`;
}

// What a booking bot is told when a calendar is connected. The exact marker
// format is documented in YourBots/_prompt/jobs/booking.md; the code that acts
// on it is Engine/worker/booking.js. Kept here (not in the .md) so it only
// appears when it is true — without a calendar the bot must NOT write these lines.
const BOOKING_LIVE = `You can book the call yourself — an exception to "text only". There is no link to hand over; the system talks to the calendar for you when you write one of two lines, alone, as the very last line of a reply:
1. [BOOKING: OFFER] — write this as soon as you have decided the person fits and they want a call. The system replaces it with the next free times and asks for their name and email — so do NOT ask for a name or an email before this line, and do NOT list or suggest times yourself: you don't know them. Never mention a calendar link; there isn't one.
2. [BOOKING: CONFIRM <time> | <name> | <email>] — write this only when they have picked ONE of the offered times AND you have their name AND their email. <time> is that offered time as YYYY-MM-DDTHH:MM in 24-hour clock, e.g. an offered "Tue 9 Sep 2026, 14:00" becomes [BOOKING: CONFIRM 2026-09-09T14:00 | Sam Jones | sam@example.com]. The system checks the time is still free, books it, and replaces the line with the confirmation — so never say "booked" yourself.
Never write either line in any other situation, never invent a time, and never write the lines for someone who doesn't fit.`;

// "# Role" / "# What a good answer looks like" / "# Done when" → { role, shape, done }
function parseJob(md) {
  const out = { role: "", shape: "", done: "" };
  const parts = String(md || "").replace(/<!--[\s\S]*?-->/g, "").split(/^#\s+/m).map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    const nl = part.indexOf("\n");
    const heading = (nl < 0 ? part : part.slice(0, nl)).trim().toLowerCase();
    const body = nl < 0 ? "" : part.slice(nl + 1).trim();
    if (heading.startsWith("role")) out.role = body;
    else if (heading.startsWith("what a good answer")) out.shape = body;
    else if (heading.startsWith("done")) out.done = body;
  }
  return out;
}
