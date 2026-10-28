// ============================================================================
//  THE LIBRARY — documents a bot can read (PDFs, Word, spreadsheets,
//  transcripts, screenshots)
//
//  knowledge/*.md is bundled straight into the prompt: right for a few pages
//  you want said word-for-word, wrong for a 60-page manual. The library is for
//  everything else. Files go into Cloudflare AI Search, which converts them
//  to text (a vision model reads images), chunks them, and hands the bot only
//  the passages relevant to each question. They land inside <files> in the
//  prompt, so strict/open grounding and every firewall rule apply unchanged.
//
//  One AI Search instance per deployment; every item is tagged with the bot
//  it belongs to, so Brightside never sees Ledgerly's files.
//
//  A bot can ALSO answer from its own website (project.json → "website").
//  That is a second, separate AI Search instance per bot, of the "web-crawler"
//  kind: Cloudflare crawls the site, converts each page to text and indexes it,
//  and re-crawls on a schedule. See "THE WEBSITE" below. Nothing is uploaded,
//  so nothing is scanned — the pages are already public.
//
//  Two ways in, same place:
//    1. Configure → Documents (drag a file in; admin code required)
//    2. Drop files in YourBots/<bot>/knowledge/ in GitHub — an Action syncs
//       anything that isn't .md/.txt/.csv (those are bundled by the build)
//
//  Every file is SCANNED before it goes in (scanText below): emails, phone
//  numbers, card numbers, API keys, "CONFIDENTIAL", contract language, and a
//  second opinion from the model. Anything found = held back with the list.
//  You can override. The point is that nothing private goes in by accident.
//  "Scan again" (rescanLibrary) re-runs the same check on everything already
//  in, and every outcome — held, override, clean upload, remove — is written
//  to the library_events table in D1 (index.js) so there's a record.
//
//  Fail-open for readers: no binding, no instance, AI Search down — the bot
//  still answers from knowledge/. It never breaks because a PDF didn't index.
// ============================================================================

// What AI Search will actually convert and index. Anything else is refused
// BEFORE upload so it never sits in the library "indexed" with zero chunks.
// Source: developers.cloudflare.com/ai-search/configuration/data-source/
export const SUPPORTED = {
  // Converted by Cloudflare's Markdown Conversion (images: object detection + a vision model)
  rich: [".pdf", ".docx", ".odt", ".xlsx", ".xlsm", ".xlsb", ".xls", ".ods", ".numbers",
         ".html", ".htm", ".xml",
         ".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg", ".bmp"],
  // Read as-is. (.md/.txt/.csv in knowledge/ are bundled into the prompt by the
  // build instead — the library is for the long ones you upload on purpose.)
  text: [".txt", ".md", ".markdown", ".csv", ".json", ".yaml", ".yml", ".rst", ".log",
         ".srt", ".vtt"],
};

// Cloudflare's limit. Bigger files are skipped by the indexer with an error.
export const MAX_BYTES = 4 * 1024 * 1024;

// Common things people WILL try that AI Search does not read.
const NOT_SUPPORTED_HINTS = {
  ".doc":   "Old Word format. Open it in Word or Google Docs and save as .docx.",
  ".pptx":  "Slides aren't supported. Export the deck to PDF and upload that.",
  ".ppt":   "Slides aren't supported. Export the deck to PDF and upload that.",
  ".key":   "Keynote isn't supported. Export to PDF and upload that.",
  ".pages": "Pages isn't supported. Export to PDF or .docx and upload that.",
  ".rtf":   "Save it as .docx or .txt first.",
  ".mp3":   "Audio isn't read. Upload the transcript as .txt instead.",
  ".mp4":   "Video isn't read. Upload the transcript as .txt instead.",
  ".m4a":   "Audio isn't read. Upload the transcript as .txt instead.",
  ".zip":   "Unzip it and upload the files inside one at a time.",
  ".heic":  "iPhone photo format. Save it as .jpg or .png first.",
};

// AI Search decides the type from the file NAME. Transcript exports get a
// name it understands; the content is unchanged.
const RENAME = { ".srt": ".txt", ".vtt": ".txt" };

export function extensionOf(name) {
  const m = String(name || "").toLowerCase().match(/\.[a-z0-9]+$/);
  return m ? m[0] : "";
}

export function allExtensions() { return [...SUPPORTED.rich, ...SUPPORTED.text]; }

// What the Configure screen and the sync script need to explain themselves.
export function libraryMeta(env, config) {
  return { enabled: libraryEnabled(env, config), extensions: allExtensions(), maxBytes: MAX_BYTES, scan: config.library?.scan !== false, scanWithModel: Boolean(config.library?.scanWithModel), contextTurns: config.library?.contextTurns ?? 2 };
}

// Returns { ok: true, name, ext } or { ok: false, reason }.
export function gate(name, size) {
  const ext = extensionOf(name);
  if (!ext) return { ok: false, reason: "The file needs an extension (like .pdf) so we know what it is." };
  if (size > MAX_BYTES) return { ok: false, reason: `That file is ${(size / 1048576).toFixed(1)} MB. The limit is 4 MB. Split it, compress it, or export a smaller version.` };
  if (size === 0) return { ok: false, reason: "That file is empty." };
  if (SUPPORTED.rich.includes(ext) || SUPPORTED.text.includes(ext)) {
    return { ok: true, name: safeName(name).replace(/\.[a-z0-9]+$/i, RENAME[ext] || ext), ext };
  }
  return { ok: false, reason: NOT_SUPPORTED_HINTS[ext] || `We don't read ${ext} files. Supported: ${allExtensions().join(" ")}` };
}

// The filename is what shows up as the source in the prompt. Readable but safe.
export function safeName(name) {
  return String(name).replace(/\\/g, "/").split("/").filter((p) => p && p !== "." && p !== "..")
    .map((p) => p.replace(/[^\w.\- ()]+/g, "_").trim()).join("/").slice(0, 160);
}

// ---------------------------------------------------------------------------
//  THE SCAN. Pattern-based: fast, free, explainable — you're told exactly what
//  was found. Runs on the converted TEXT, so PDFs, sheets and screenshots all
//  get the same treatment.
//
//  ⚠️ KNOWN GAP, same as the log redaction: this does NOT catch names, or
//  "the Henderson deal is falling apart." Nothing pattern-based does. The
//  model check below catches some of that. Neither replaces reading the file.
// ---------------------------------------------------------------------------
const CHECKS = [
  { id: "email",    label: "email addresses",             re: /[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/gi, max: 2 },
  { id: "phone",    label: "phone numbers",               re: /(?:^|[^\d])(\+?\d[\d\s().-]{8,}\d)(?=$|[^\d])/g, max: 2 },
  { id: "card",     label: "card numbers",                re: /\b(?:\d[ -]?){13,19}\b/g, max: 0, test: luhn },
  { id: "ssn",      label: "US social security numbers",  re: /\b\d{3}-\d{2}-\d{4}\b/g, max: 0 },
  { id: "iban",     label: "bank account numbers (IBAN)", re: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, max: 0 },
  { id: "secret",   label: "API keys or tokens",          re: /\b(?:sk-[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})\b/g, max: 0 },
  { id: "password", label: "passwords written down",      re: /\b(?:password|passwd|pwd|passcode)\s*[:=]\s*\S{4,}/gi, max: 0 },
  { id: "privkey",  label: "private keys",                re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g, max: 0 },
  { id: "marking",  label: "confidentiality markings",    re: /\b(?:confidential|do not distribute|not for distribution|internal (?:use )?only|privileged|attorney[- ]client|under nda|non-disclosure)\b/gi, max: 0 },
  { id: "contract", label: "contract language",           re: /\b(?:this agreement is (?:made|entered)|hereinafter|the parties agree|indemnif(?:y|ication)|governing law|witness whereof)\b/gi, max: 1 },
  { id: "salary",   label: "salary or payroll data",      re: /\b(?:salary|payroll|gross pay|net pay|annual compensation)\b/gi, max: 1 },
];

function luhn(s) {
  const d = s.replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0, alt = false;
  for (let i = d.length - 1; i >= 0; i--) { let n = +d[i]; if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; }
  return sum % 10 === 0;
}

// [] if clean, else [{ id, label, count, sample }]
export function scanText(text) {
  const t = String(text || "").slice(0, 400_000);
  const flags = [];
  for (const c of CHECKS) {
    const hits = [];
    for (const m of t.matchAll(c.re)) { const v = (m[1] ?? m[0]).trim(); if (c.test && !c.test(v)) continue; hits.push(v); }
    // A public FAQ legitimately has ONE email and ONE phone number in it — the
    // company's. Forty is a customer list. Hence `max`.
    const distinct = [...new Set(hits.map((h) => h.toLowerCase()))];
    if (distinct.length > c.max) flags.push({ id: c.id, label: c.label, count: distinct.length, sample: mask(distinct[0]) });
  }
  return flags;
}

function mask(s) { s = String(s); return s.length <= 6 ? s : s.slice(0, 3) + "…" + s.slice(-2); }

// Get the text out so we can scan it. Text types are decoded; everything else
// goes through Workers AI's converter — the same conversion AI Search does on
// its side, so what we scan is what the bot will see. (Also used by
// /api/attach: a visitor's file is read the same way, then thrown away.)
export async function extractText(env, name, ext, bytes) {
  if (SUPPORTED.text.includes(ext)) return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (!env.AI?.toMarkdown) return "";
  try {
    // The converter wants a typed blob; the extension picks the parser.
    const r = await env.AI.toMarkdown({ name: name.split("/").pop(), blob: new Blob([bytes], { type: mimeFor(ext) }) });
    return typeof r?.data === "string" ? r.data : "";
  } catch (err) { console.error("toMarkdown failed for scan", err?.message || err); return ""; }
}
const MIME = { ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xls": "application/vnd.ms-excel", ".odt": "application/vnd.oasis.opendocument.text", ".ods": "application/vnd.oasis.opendocument.spreadsheet", ".html": "text/html", ".htm": "text/html", ".xml": "application/xml", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml", ".bmp": "image/bmp" };
const mimeFor = (ext) => MIME[ext] || "application/octet-stream";

// Second opinion from the model (config.library.scanWithModel). Catches what
// patterns can't: "this is clearly a client's invoice." One short call.
// Always Workers AI, even if the bot itself talks to OpenAI/Anthropic.
const SCAN_FALLBACK_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
async function modelOpinion(env, config, name, text) {
  if (!config.library?.scanWithModel || !text || !env.AI) return null;
  const model = config.provider === "workers-ai" && config.model ? config.model : SCAN_FALLBACK_MODEL;
  try {
    const result = await env.AI.run(model, {
      messages: [
        { role: "system", content: `You review documents before they are added to a PUBLIC customer-facing chatbot's knowledge. Anyone on the internet will be able to ask the bot about the contents.
Answer with exactly one line:
PUBLIC — if this is the kind of thing a business would put on its website (FAQ, product info, manual, policy, marketing, general how-to).
PRIVATE: <reason in under 15 words> — if it contains information about specific customers, employees, deals, finances, legal matters, credentials, or is marked confidential.
When unsure, say PUBLIC. Do not explain.` },
        { role: "user", content: `Filename: ${name}\n\n${text.slice(0, 6000)}` },
      ],
      // Reasoning models (gpt-oss) spend tokens thinking before the one line; leave room.
      max_tokens: 400,
    });
    const line = String(result?.response ?? result?.choices?.[0]?.message?.content ?? "").replace(/\s+/g, " ").trim();
    const m = line.match(/PRIVATE\s*[:—-]\s*(.+)/i);
    return m ? m[1].trim().slice(0, 140) : null;
  } catch (err) { console.error("model scan failed (ignoring)", err?.message || err); return null; }
}

// The whole scan in one place — extract, pattern checks, model's opinion — so
// an upload and a "Scan again" of something already in are checked the SAME
// way. Returns [] when clean, else the list the admin is shown.
async function runScan(env, config, name, ext, bytes) {
  const text = await extractText(env, name, ext, bytes);
  const flagged = scanText(text);
  const opinion = await modelOpinion(env, config, name, text);
  if (opinion) flagged.push({ id: "model", label: "looks private", count: 1, sample: opinion });
  if (!text && !SUPPORTED.text.includes(ext)) flagged.push({ id: "unscanned", label: "couldn't read it to check", count: 1, sample: "Conversion failed, so the scan didn't run." });
  return flagged;
}

// ---------------------------------------------------------------------------
//  The instance. One per deployment, created on first upload. Nothing to click.
// ---------------------------------------------------------------------------
export function libraryEnabled(env, config) { return Boolean(env.AI_SEARCH && config.library?.name); }
const handle = (env, config) => env.AI_SEARCH.get(config.library.name);
const keyFor = (bot, name) => `${bot}/${name}`;

// The two metadata fields every item carries. AI Search only lets you filter
// on fields declared on the instance, so they're declared at create (and
// re-asserted on an existing instance once per isolate — idempotent).
// `approved` records that the scan was overridden, so Commit to GitHub can
// carry the approval into knowledge/APPROVED.txt and the sync action won't
// hold the same file back again.
const CUSTOM_METADATA = [{ field_name: "bot", data_type: "text" }, { field_name: "source", data_type: "text" }, { field_name: "approved", data_type: "text" }];
let ENSURED = false;
export async function ensureLibrary(env, config) {
  const id = config.library.name;
  if (ENSURED) return handle(env, config);
  let exists = false;
  try {
    const { result } = await env.AI_SEARCH.list({ search: id, per_page: 50 });
    exists = Array.isArray(result) && result.some((i) => i.id === id);
  } catch (err) { console.error("library list failed (will try create)", err?.message || err); }
  try {
    if (exists) await handle(env, config).update({ custom_metadata: CUSTOM_METADATA });
    else await env.AI_SEARCH.create({ id, custom_metadata: CUSTOM_METADATA });
    ENSURED = true;
  } catch (err) { console.error(`library ${exists ? "update" : "create"} returned`, err?.message || err); } // race, or already right — carry on
  return handle(env, config);
}

// ---------------------------------------------------------------------------
//  Retrieval — every chat turn. Returns { passages, sources }:
//    passages — the excerpts, ready for the prompt ("" if nothing was found)
//    sources  — the names of the documents they came from, each listed once,
//               so the page can show "📄 depot-notes.pdf" under the answer.
//               Names only: no ids, no links. The files themselves stay
//               admin-only.
//
//  `userTurns` is what the visitor has said so far, most recent last. The
//  search uses the latest message PLUS a couple before it (config.library
//  .contextTurns), because "and on Thursdays?" means nothing on its own — the
//  depot it's asking about was named in the previous message. The whole chat
//  is never sent; a few hundred characters is plenty for a search.
//
//  Nothing found, or nothing working → { passages: "", sources: [] } and the
//  bot answers from knowledge/ as if the library didn't exist.
// ---------------------------------------------------------------------------
const QUERY_MAX_CHARS = 600;

// Builds the search text from the visitor's messages. contextTurns = how many
// EARLIER messages to include (0 = the latest message only, the old behaviour).
export function searchQuery(userTurns, contextTurns = 2) {
  const turns = (Array.isArray(userTurns) ? userTurns : [userTurns]).map((t) => String(t || "").trim()).filter(Boolean);
  if (!turns.length) return "";
  const earlier = Math.max(0, Math.floor(Number(contextTurns) || 0));
  const q = turns.slice(-(earlier + 1)).join("\n");
  // Over the cap → keep the END. The oldest context is what gets trimmed; the
  // question being asked right now always survives.
  return q.length > QUERY_MAX_CHARS ? q.slice(-QUERY_MAX_CHARS) : q;
}

//  THE WEBSITE. One extra instance per bot that has project.json → website.url,
//  named "<library.name>-web-<bot>". Cloudflare does the crawling (its own
//  "CloudflareAISearch" crawler, from the site's sitemap or by following links),
//  keeps the pages in the instance, and re-crawls every `crawlIntervalHours`.
//  Created the first time someone clicks "Crawl now" — never during a chat.
//  If the URL changes we delete the instance and create a fresh one: the old
//  pages would otherwise sit in the index answering questions about a site
//  the bot no longer points at, and AI Search has no "forget that site" call.
// ---------------------------------------------------------------------------
export function websiteOf(project) {
  const w = project?.website;
  const url = String(w?.url || "").trim();
  const sitemap = String(w?.sitemap || "").trim();
  return /^https?:\/\/\S+$/i.test(url) ? { url, include: listOf(w?.include), exclude: listOf(w?.exclude), sitemap: /^https?:\/\/\S+$/i.test(sitemap) ? sitemap : "" } : null;
}
const listOf = (v) => (Array.isArray(v) ? v : String(v || "").split(/[\n,]/)).map((x) => String(x).trim()).filter(Boolean).slice(0, 10);

// Instance ids: lowercase letters, digits, _ and single dashes, 32 chars max.
// A long library name + a long bot id can overflow, so the tail becomes a
// short hash of the full name — still deterministic, still unique per bot.
export function websiteInstanceName(config, bot) {
  const full = `${config.library.name}-web-${bot}`.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (full.length <= 32) return full;
  let h = 2166136261;                                             // FNV-1a, plenty for a name
  for (let i = 0; i < full.length; i++) { h ^= full.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return full.slice(0, 25).replace(/-$/, "") + "-" + h.toString(16).slice(0, 6);
}

const SYNC_INTERVALS = [3600, 7200, 14400, 21600, 43200, 86400];   // the only values AI Search accepts
function syncInterval(config) {
  const want = Math.round((Number(config.library?.crawlIntervalHours) || 24) * 3600);
  return SYNC_INTERVALS.reduce((best, v) => (Math.abs(v - want) < Math.abs(best - want) ? v : best), 86400);
}

// What we ask Cloudflare to create. Two ways to find pages:
//   "discover" — start at the URL, follow links AND read the sitemap. Works for
//                a site with no sitemap, but only for a domain that is on THIS
//                Cloudflare account (a "verified zone"). Tried first.
//   "sitemap"  — read sitemap.xml only. The fallback when the domain lives
//                elsewhere; a site with no sitemap then yields no pages.
// Depth 5 and `crawlMaxPages` keep a big site from eating the free plan's 500 pages a day.
function websiteConfig(config, bot, site, parseType = "discover") {
  if (site.sitemap) parseType = "sitemap";                        // a named sitemap means: read that, exactly
  return {
    id: websiteInstanceName(config, bot),
    type: "web-crawler",
    source: site.url,
    source_params: {
      ...(site.include.length ? { include_items: site.include } : {}),
      ...(site.exclude.length ? { exclude_items: site.exclude } : {}),
      web_crawler: {
        parse_type: parseType,
        ...(parseType === "discover" ? { discover_options: { depth: 5, limit: Math.max(1, Math.min(100000, Number(config.library?.crawlMaxPages) || 200)), source: "all", include_subdomains: false, include_external_links: false } } : {}),
        parse_options: { use_browser_rendering: false, include_images: false, ...(site.sitemap ? { specific_sitemaps: [site.sitemap] } : {}) },
      },
    },
    sync_interval: syncInterval(config),
  };
}
const needsOwnZone = (err) => /verified_zone|verified zone/i.test(String(err?.message || err));

async function findInstance(env, id) {
  try {
    const { result } = await env.AI_SEARCH.list({ search: id, per_page: 50 });
    return (Array.isArray(result) ? result : []).find((i) => i.id === id) || null;
  } catch (err) { console.error("instance list failed", err?.message || err); return null; }
}

// Make sure the bot's website instance exists and points at the right URL.
// Returns { name, created, recreated, updated } or throws (admin routes only).
export async function ensureWebsite(env, config, bot, site) {
  if (!libraryEnabled(env, config)) throw new Error("the library isn't switched on");
  if (!site?.url) throw new Error("no website URL");
  const want = websiteConfig(config, bot, site);
  const have = await findInstance(env, want.id);
  const out = { name: want.id, created: false, recreated: false, updated: false, parseType: "discover" };
  if (have && String(have.source || "").replace(/\/$/, "") !== want.source.replace(/\/$/, "")) {
    // The URL changed: start over (see the note at the top of this section).
    await env.AI_SEARCH.delete(want.id);
    out.recreated = true;
  } else if (have) {
    // Same site — keep the pages, but refresh the filters and the schedule in
    // case they were edited in project.json. Cheap, and idempotent. The way
    // pages are found (discover / sitemap) stays whatever it was created with.
    out.parseType = have.source_params?.web_crawler?.parse_type || out.parseType;
    const keep = websiteConfig(config, bot, site, out.parseType);
    try { await env.AI_SEARCH.get(want.id).update({ source_params: keep.source_params, sync_interval: keep.sync_interval }); out.updated = true; }
    catch (err) { console.warn("website instance update failed (keeping it as is)", err?.message || err); }
    return out;
  }
  try { await env.AI_SEARCH.create(want); }
  catch (err) {
    if (!needsOwnZone(err)) throw err;
    // The domain isn't on this account, so link-following is off the table.
    // Sitemap-only still works — if the site publishes one.
    console.warn(`website ${site.url} is not a zone on this account; crawling from its sitemap only`);
    await env.AI_SEARCH.create(websiteConfig(config, bot, site, "sitemap"));
    out.parseType = "sitemap";
  }
  out.created = !out.recreated;
  return out;
}

// "Crawl now": create if needed, then kick off a crawl job.
export async function crawlWebsite(env, config, bot, site) {
  const ensured = await ensureWebsite(env, config, bot, site);
  let job = null;
  try { job = await env.AI_SEARCH.get(ensured.name).jobs.create({ description: "Crawl now (from Configure)" }); }
  catch (err) {
    // A brand-new instance starts its own first crawl; asking for another one
    // while it runs is refused. That's fine — it's crawling.
    if (!ensured.created && !ensured.recreated) throw err;
    console.warn("job create refused right after create (the first crawl is already running)", err?.message || err);
  }
  return { ...ensured, job };
}

// What the Configure screen shows: does the instance exist, how many pages,
// what the last crawl did. Never throws — a missing instance is a state, not an error.
export async function websiteStatus(env, config, bot, site) {
  const name = websiteInstanceName(config, bot);
  const out = { enabled: libraryEnabled(env, config), name, url: site?.url || "", exists: false, source: "", pages: 0, indexing: 0, errors: 0, lastActivity: null, lastJob: null, syncIntervalHours: syncInterval(config) / 3600, status: "" };
  if (!out.enabled) return out;
  const inst = env.AI_SEARCH.get(name);
  let info;
  try { info = await inst.info(); } catch (err) { out.status = "not created yet"; return out; }
  out.exists = true; out.source = String(info?.source || ""); out.status = String(info?.status || "");
  out.parseType = info?.source_params?.web_crawler?.parse_type || "";
  out.mismatch = Boolean(site?.url && out.source && out.source.replace(/\/$/, "") !== site.url.replace(/\/$/, ""));
  try {
    const s = await inst.stats();
    out.pages = s?.completed ?? 0; out.indexing = (s?.queued ?? 0) + (s?.running ?? 0); out.errors = s?.error ?? 0; out.lastActivity = s?.last_activity || null;
  } catch (err) { console.warn("website stats failed", err?.message || err); }
  try {
    const { result } = await inst.jobs.list({ page: 1, per_page: 1 });
    const j = Array.isArray(result) && result[0];
    if (j) out.lastJob = { id: j.id, source: j.source, startedAt: j.started_at || null, endedAt: j.ended_at || null, endReason: j.end_reason || null, running: !j.ended_at, notes: [] };
    // The crawler's own last words — "Invalid sitemap …", "got 12 pages" — are
    // the difference between "0 pages" and knowing why.
    if (j) {
      try {
        const { result } = await inst.jobs.get(j.id).logs({ page: 1, per_page: 40 });
        out.lastJob.notes = (Array.isArray(result) ? result : []).map((l) => String(l.message || "")).filter((m) => /pages|sitemap|invalid|error|failed|blocked|robots|limit|skipp/i.test(m) && !/not authoritative/i.test(m)).slice(0, 6);
      } catch (err) { console.warn("website job logs failed", err?.message || err); }
    }
  } catch (err) { console.warn("website jobs list failed", err?.message || err); }
  return out;
}

// Remove the bot's website instance and every crawled page with it.
export async function deleteWebsite(env, config, bot) {
  if (!libraryEnabled(env, config)) return false;
  const name = websiteInstanceName(config, bot);
  if (!(await findInstance(env, name))) return false;
  await env.AI_SEARCH.delete(name);
  return true;
}

// ---------------------------------------------------------------------------
//  Retrieval — every chat turn. Returns { text, library, website }: the excerpt
//  block for the prompt ("" if nothing), and which sources were actually used.
//  The document library and the website are searched side by side, the best
//  `maxPassages` by score win, and each excerpt says where it came from — a
//  filename, or the page's URL.
// ---------------------------------------------------------------------------
export async function retrieve(env, config, bot, userTurns, { website = null } = {}) {
  // What comes back, always (fail-open means every path returns this shape):
  //   text     — the excerpts, ready for the prompt ("" if nothing was found)
  //   sources  — document names and page URLs, each once, for the 📄/🌐 chips
  //   library  — true if a document excerpt was used
  //   website  — true if a crawled page was used
  const none = { text: "", passages: "", sources: [], library: false, website: false };
  if (!libraryEnabled(env, config) || !bot) return none;
  const q = searchQuery(userTurns, config.library.contextTurns ?? 2);
  if (!q) return none;
  const max = config.library.maxPassages ?? 6;
  const options = (extra) => ({
    query: q,
    ai_search_options: {
      retrieval: { max_num_results: max, match_threshold: config.library.matchThreshold ?? 0.4, context_expansion: 1, ...extra },
      query_rewrite: { enabled: true },
    },
  });

  // The library, filtered to this bot. Belt and braces: the filter is the
  // wall; the key prefix is the second wall.
  const fromLibrary = async () => {
    try {
      const search = (withFilter) => handle(env, config).search(options(withFilter ? { filters: { bot: { $eq: bot } } } : {}));
      let r;
      try { r = await search(true); }
      catch (err) { if (!/undeclared metadata/i.test(String(err?.message || err))) throw err; r = await search(false); }
      return (Array.isArray(r?.chunks) ? r.chunks : [])
        .filter((c) => String(c.item?.key || "").startsWith(bot + "/"))
        .map((c) => ({ score: Number(c.score) || 0, from: String(c.item?.key || "document").slice(bot.length + 1), text: String(c.text || "").trim(), web: false }));
    } catch (err) {
      // No instance yet, still indexing, or AI Search hiccup. Bot still works.
      console.error("library search failed (continuing without it)", err?.message || err);
      return [];
    }
  };

  // The website, only for a bot that has one. Its own instance, so no filter.
  // Not crawled yet, deleted, or down → same as having no website.
  const fromWebsite = async () => {
    if (!website?.url) return [];
    try {
      const r = await env.AI_SEARCH.get(websiteInstanceName(config, bot)).search(options({}));
      return (Array.isArray(r?.chunks) ? r.chunks : [])
        .map((c) => ({ score: Number(c.score) || 0, from: pageUrl(c.item, website.url), text: String(c.text || "").trim(), web: true }));
    } catch (err) {
      console.error("website search failed (continuing without it)", err?.message || err);
      return [];
    }
  };

  const [lib, web] = await Promise.all([fromLibrary(), fromWebsite()]);
  const picked = [...lib, ...web].filter((c) => c.text).sort((a, b) => b.score - a.score).slice(0, max);
  if (!picked.length) return none;
  const text = picked.map((c) => `<excerpt from="${c.from.replace(/"/g, "")}">\n${c.text}\n</excerpt>`).join("\n\n");
  return {
    text,
    passages: text,
    sources: [...new Set(picked.map((c) => c.from))],
    library: picked.some((c) => !c.web),
    website: picked.some((c) => c.web),
  };
}

function pageUrl(item, siteUrl) {
  const m = item?.metadata || {};
  const cand = [m.url, m.source_url, m.page_url, item?.key].map((v) => String(v || "").trim()).find(Boolean) || "";
  if (/^https?:\/\//i.test(cand)) return cand;
  try { return new URL(cand.replace(/^\/+/, "/"), siteUrl).href; } catch { return siteUrl; }
}

// ---------------------------------------------------------------------------
//  Upload / list / delete — admin only (see index.js). Returns one of:
//    { ok: true,  name, id, status, chunks }
//    { ok: false, name, reason }                              — refused outright
//    { ok: false, name, flagged: [...], needsOverride: true } — the scan found things
// ---------------------------------------------------------------------------
export async function uploadFile(env, config, bot, name, bytes, { override = false, source = "upload" } = {}) {
  const g = gate(name, bytes.byteLength);
  if (!g.ok) return { ok: false, name, reason: g.reason };

  if (config.library?.scan !== false && !override) {
    const flagged = await runScan(env, config, g.name, g.ext, bytes);
    if (flagged.length) return { ok: false, name: g.name, flagged, needsOverride: true };
  }

  const lib = await ensureLibrary(env, config);
  try {
    // Upsert: same name replaces and re-indexes.
    // metadata.source tells the GitHub sync which items it owns ("github") and
    // which were dropped in by hand ("upload") — it only ever removes its own.
    const opts = { metadata: { bot, source: source === "github" ? "github" : "upload", approved: override ? "yes" : "no" }, waitMs: 5000 };
    const item = await uploadBytes(lib, keyFor(bot, g.name), bytes, g.ext, opts);
    if (item?.status === "error" || item?.status === "skipped") return { ok: false, name: g.name, reason: `Cloudflare couldn't read that file (status: ${item.status}${item.error ? ": " + String(item.error).slice(0, 120) : ""}). Try exporting it again, or as PDF.` };
    const indexed = item?.status === "completed";
    return { ok: true, name: g.name, id: item?.id, status: indexed ? "completed" : "indexing", chunks: item?.chunks_count ?? null };
  } catch (err) {
    const msg = String(err?.message || err);
    console.error("upload failed", msg);
    return { ok: false, name: g.name, reason: "Upload failed: " + msg.slice(0, 120) };
  }
}

// The binding's RPC is picky about what carries bytes (Blob and ArrayBuffer
// don't survive it in every runtime). Try the shapes in order; the first one
// the runtime accepts wins. Text types can always fall back to a string.
async function uploadBytes(lib, key, bytes, ext, opts) {
  const shapes = [
    ["stream", () => new Blob([bytes]).stream()],
    ["bytes", () => new Uint8Array(bytes)],
    ...(SUPPORTED.text.includes(ext) ? [["string", () => new TextDecoder().decode(bytes)]] : []),
  ];
  let last, item;
  for (const [label, make] of shapes) {
    try { item = await lib.items.upload(key, make(), { metadata: opts.metadata }); break; }
    catch (err) { last = err; if (!/serializ/i.test(String(err?.message || err))) throw err; console.warn(`upload as ${label} not accepted, trying the next shape`); }
  }
  if (!item) throw last;
  // Small files index in a few seconds; big PDFs take a minute. Wait a little
  // so the common case comes back "ready", then report whatever status it has.
  // (The binding's own uploadAndPoll waits the full timeout — too slow for a form.)
  // Only "completed" means searchable. Chunks appear a while before that and
  // a search in between finds nothing, so we don't call it ready early.
  const ready = (it) => ["completed", "error", "skipped"].includes(it?.status);
  const deadline = Date.now() + (opts.waitMs ?? 5000);
  while (Date.now() < deadline && !ready(item)) {
    await new Promise((r) => setTimeout(r, 1200));
    try { item = { ...item, ...(await lib.items.get(item.id).info()) }; } catch (err) { console.warn("poll failed (reporting last known status)", err?.message || err); break; }
  }
  return item;
}

export async function listFiles(env, config, bot) {
  if (!libraryEnabled(env, config)) return [];
  const lib = await ensureLibrary(env, config);
  const out = [];
  let page = 1;
  while (page <= 20) {
    // Key-name search, not the metadata filter: metadata only becomes
    // filterable once an item is indexed, and a file that's still queued
    // must still show up in the list. The startsWith below is the real gate.
    const { result, result_info } = await lib.items.list({ page, per_page: 50, search: bot + "/" });
    for (const it of result || []) {
      if (!String(it.key || "").startsWith(bot + "/")) continue;
      out.push({ id: it.id, name: String(it.key).slice(bot.length + 1), status: it.status, chunks: it.chunks_count ?? null, size: it.file_size ?? null, source: it.metadata?.source === "github" ? "github" : "upload", approved: it.metadata?.approved === "yes", updated: it.last_seen_at || it.created_at || null });
    }
    const total = result_info?.total_count ?? 0;
    if (!result || result.length < 50 || (total && page * 50 >= total)) break;
    page += 1;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// The original bytes of one of this bot's documents — for Commit to GitHub,
// so the repo folder ends up holding the same files the library does.
export async function downloadFile(env, config, bot, id) {
  const lib = await ensureLibrary(env, config);
  const mine = await listFiles(env, config, bot);
  const f = mine.find((x) => x.id === id);
  if (!f) return null;
  const { bytes, contentType } = await downloadBytes(lib, id);
  return { ...f, bytes, contentType };
}
async function downloadBytes(lib, id) {
  const r = await lib.items.get(id).download();
  const body = r?.body ?? r;                       // { body, contentType, filename, size } or a bare stream
  const bytes = body instanceof ArrayBuffer ? body : await new Response(body).arrayBuffer();
  return { bytes, contentType: r?.contentType || "" };
}

// "Scan again": rules change, and what went in last month should be checkable
// against this month's list. Every document of this bot is pulled back out and
// run through the same scan as an upload. READ-ONLY — nothing in the library is
// changed, moved or re-approved; the admin decides what to do with the list.
// Capped at `limit` files per call (each is a download + conversion, plus one
// model call when scanWithModel is on); `truncated` says there were more.
export const RESCAN_LIMIT = 25;
export async function rescanLibrary(env, config, bot, { limit = RESCAN_LIMIT } = {}) {
  const lib = await ensureLibrary(env, config);
  const mine = await listFiles(env, config, bot);
  const batch = mine.slice(0, limit);
  const results = [];
  for (const f of batch) {
    const ext = extensionOf(f.name);
    try {
      const { bytes } = await downloadBytes(lib, f.id);
      const flagged = await runScan(env, config, f.name, ext, bytes);
      results.push({ name: f.name, id: f.id, approved: f.approved, flagged });
    } catch (err) {
      // One bad download doesn't sink the batch — it's reported as a flag of its own.
      console.error("rescan failed for", f.name, err?.message || err);
      results.push({ name: f.name, id: f.id, approved: f.approved, flagged: [{ id: "unscanned", label: "couldn't read it to check", count: 1, sample: String(err?.message || err).slice(0, 120) }] });
    }
  }
  return { results, scanned: batch.length, total: mine.length, truncated: mine.length > batch.length };
}

// Returns the removed file's record (name, id…) or false if it wasn't this bot's.
export async function deleteFile(env, config, bot, id) {
  const lib = await ensureLibrary(env, config);
  // Only this bot's items. A wrong id for another bot is a 404, not a deletion.
  const mine = await listFiles(env, config, bot);
  const f = mine.find((x) => x.id === id);
  if (!f) return false;
  await lib.items.delete(id);
  return f;
}
