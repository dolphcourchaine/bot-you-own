// ============================================================================
//  THIS IS THE ONLY FILE MOST PEOPLE NEED TO CHANGE.
//  Edit it right here in GitHub (click the pencil icon), then click
//  "Commit changes". Your bot updates itself in about a minute.
//
//  Everything about WHAT the bot knows and HOW it behaves for one job lives in
//  YourBots/<name>/  (instructions.md + knowledge/ + project.json).
//  This file is the things that are true for ALL projects.
// ============================================================================

export const CONFIG = {
  // ---- 1. WHO OWNS THIS -----------------------------------------------------
  owner: "Example Co",                 // shown in the UI footer and in the prompt as "run by …"
  siteName: "The Bot You Own",         // browser tab title

  // The "Create your own" line under the chat — the same trick the survey and
  // funnel tools use: every bot you deploy quietly advertises the workshop.
  // It shows on the page and inside the embedded widget. Turn it off with
  // show:false, or point it wherever your own workshop lives.
  createYourOwn: { show: true, text: "Create your own — free @ Sovereign Operator", url: "https://www.skool.com/sovereign-operator/about" },

  // ---- 1b. THE COMMUNITY ---------------------------------------------------------
  // Where the tour sends people at the end, and where "deploy your own" points them
  // when they aren't on the list yet. Mine out of the box; make it yours. Used by
  // the tour strip above the chat (YourBots/tour) and appended as the last "next
  // step" of any bot whose project.json says "communityStep": true.
  community: {
    show: true,
    name: "Sovereign Operator", url: "https://www.skool.com/sovereign-operator/about",
    pitch: "The people doing this, and the answers. Free to join.",
    // The membership. Same page out of the box (the walkthrough lives in that group's classroom); point it at your trial or sales page when you have one.
    workshopName: "the membership", workshopUrl: "https://www.skool.com/sovereign-operator/about",
    workshopPitch: "The deploy walkthrough, the recordings, and the people who have done it: from the button to a bot on your own domain with the sign-up funnel on.",
    // The human path: joined, no key in hand → message this person. A Skool profile link works.
    dmName: "Jim", dmUrl: "https://www.skool.com/@jim-tyrrell-8465?g=sovereign-operator",
  },

  // ---- 2. WHICH PROJECT OPENS FIRST ------------------------------------------
  // Every folder in YourBots/ that is listed in YourBots/index.js is available in
  // the sidebar. This one is selected when someone opens the page.
  // Ship ONE project to customers. The samples exist so you can test the machine
  // before you feed it your own material — delete them from YourBots/index.js
  // when you go live (see YourBots/README.md).
  defaultProject: "tour",

  // Hide the sidebar and show only the default project (for a customer-facing
  // deploy). The embed widget always behaves this way regardless.
  singleProject: false,

  // ---- 3. THE MODEL ----------------------------------------------------------
  // "workers-ai" needs NO API key — it's included with Cloudflare. Start here.
  // "openai" or "anthropic" need a secret (see docs/DEPLOY.md) and go through AI Gateway.
  provider: "workers-ai",
  model: "@cf/meta/llama-4-scout-17b-16e-instruct",
  // model: "@cf/openai/gpt-oss-120b",                    // reasoning model: thinks inside max_tokens, so a long
  //                                                      // input can eat the whole budget and answer nothing.
  // model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",   // an older default; passes the same set, pricier output
  // model: "gpt-4.1-mini",                    // provider: "openai"
  // model: "claude-opus-5",                   // provider: "anthropic"
  maxTokens: 900,

  // ---- 4. THE GATEWAY (on by default — the dollar ceiling) --------------------
  // Every model call goes through Cloudflare AI Gateway named below. You get
  // logs, caching, a per-minute rate limit and a DOLLAR SPEND LIMIT, all from the
  // dashboard, none of it in code. The gateway has to EXIST on your account
  // first: dashboard → AI → AI Gateway → Create Gateway, name it "bot-you-own"
  // (or the curl in docs/DEPLOY.md §D). Until it does, the bot notices, logs one
  // warning and talks to the model directly — a missing gateway never breaks a
  // chat. Under the hood → Gateway & model shows which way the last call went.
  gateway: {
    id: "bot-you-own",      // "" = talk to the model directly, no gateway
    accountId: "",          // only needed for provider "openai" / "anthropic"
    cacheTtl: 0,            // seconds; 0 = don't cache answers
  },

  // ---- 4a. CHEAP TURNS: "hi", "thanks", "ok" don't need a 120B model ----------
  // Engine/worker/router.js looks at the visitor's last message in plain code —
  // no model call — and if EVERY word is small talk (greeting, thanks, ok, bye,
  // an emoji) it answers with the small model below, same system prompt, 200
  // tokens. Anything with a question mark (strict bots), a number, an unknown
  // word or more than six words goes to the main model as always. When it
  // isn't sure, it's a real turn. Under the hood → Gateway & model shows the split.
  routing: {
    smallTurns: true,
    smallModel: "@cf/meta/llama-3.1-8b-instruct-fast",   // Workers AI catalogue: developers.cloudflare.com/workers-ai/models
    smallMaxTokens: 200,
  },

  // ---- 5. WHO CAN USE IT -----------------------------------------------------
  // Each bot can say for itself in its project.json → "access". This is what a
  // bot gets when it doesn't say (default), and the most OPEN any bot may be (floor).
  // The modes, most open first:
  // "open"      — anyone with the link. For a public website bot.
  // "email"     — visitors type an email address once; that browser is remembered
  //               (Engine/identity/). Identification, not authentication: nobody checks it.
  // "allow"     — email, AND the address must be on the allowlist: this bot's own
  //               list or the one for every bot (Under the hood → Settings → Allowlist).
  //               Invited people only. Needs the ALLOWLIST_KEY secret (docs/DEPLOY.md → B2c).
  // "key"       — a shared passphrase (the ACCESS_PASSPHRASE secret). Demos, internal bots.
  // "key+email" — both: the passphrase to get in, then an email so you know who asked.
  // "admin"     — only the admin code opens it. Bots only you should talk to.
  // "draft"     — nobody but the Configure preview. Publish to open it.
  // floor: a bot is never more open than this. "open" = no floor. Set it to "key"
  // and EVERY bot needs the passphrase, whatever its file says — the panic switch.
  // If a bot wants a key but no ACCESS_PASSPHRASE secret exists, it runs open and
  // says so in the logs. The admin code (ADMIN_PASSPHRASE) is separate.
  // Under the hood → Settings changes both without a commit (the saved copy wins,
  // then YourBots/settings.json, then this). docs/CUSTOMIZE.md → "Who can use it".
  access: { default: "email", floor: "open" },

  // ---- 4b. DEMO MODE ---------------------------------------------------------
  // What ships in the box so a fresh deploy has something to click, and what a new
  // owner turns off once it is their site. Two switches because they go stale at
  // different times: the tour teaches YOUR site and sells the workshop it came from,
  // while the sample bots are just examples to copy. Someone may want the tour gone on
  // day one and keep Example Co as a reference, or exactly the other way round.
  // Both are presentation, not security — flip them live, no redeploy: the last pill in the
  // tour strip ("Turn off demo mode", the owner's five-step walkthrough, also at ?panel=owner)
  // or Under the hood → Security → Demo, which is also where they are switched back on.
  //   tour  false → no stop strip, no pointing finger, no $ badges, no intro modal.
  //                 The guide bot (YourBots/tour) stays; it just becomes a normal bot.
  //   bots  false → the sample bots (marked "demo": true) leave the sidebar. Nothing is
  //                 deleted: the folders stay, the owner can still open one by its link,
  //                 and switching this back brings them all straight back.
  demo: { tour: true, bots: true },

  // ---- 5. THE SIGN-UP GATE (what "email" mode asks for) --------------------------
  // Out of the box a visitor meets a welcome page: email, a mobile number, and two
  // opt-in boxes. Everything here can be changed live in Under the hood → Settings
  // (the saved copy wins). "required" | "optional" | "off" for the two fields.
  // The number is for texting them; turn it off and nobody is asked. The boxes are
  // never pre-ticked unless you say so — that is what makes the consent real.
  // Every sign-up is stored on the person's row (name, phone, what they ticked and
  // when, the exact words they ticked) and POSTed to signup.webhook if you set one,
  // so your list tool gets it live. Under the hood → Sign-ups shows them all, with
  // the abuse marks (same device or address handing out many emails, throwaway
  // domains) and a CSV. docs/CUSTOMIZE.md → "The sign-up gate".
  signup: {
    title: "Try it, free",
    blurb: "A ChatGPT-style assistant that runs on infrastructure the owner controls. Have a go, then see how it's made.",
    askName: "optional",           // "required" | "optional" | "off"
    askPhone: "required",          // "required" | "optional" | "off"   — the texting number
    marketing: { show: true, required: false, checked: false, text: "Email me the newsletter, workshop dates and the occasional offer. Unsubscribe any time." },
    sms: { show: true, required: false, checked: false, text: "Text me about this. Message rates may apply; reply STOP to end." },
    privacyLine: "We keep your email, your number if you give it, and a hashed record of your device and connection to spot abuse. Shared only with the tools we use to email or text you. Delete it any time.",   // the page adds Privacy · Terms links after it
    webhook: "",                   // POST every sign-up here (Zapier, Make, your CRM). Empty = off.
  },

  // ---- 5a. IDENTITY: the return window ----------------------------------------
  // A visitor in email/allow mode is remembered per browser (a device key). A
  // SECOND browser typing the same email normally waits for the owner to link it.
  // The return window is the exception: if that email was active within the last
  // graceMinutes, the new browser is trusted at once and their conversation
  // history follows them (it is kept on the server for identified visitors —
  // docs/IDENTITY.md → "History on any computer"). Closing the laptop and opening
  // the phone just works. The trade-off, said plainly: inside the window, anyone
  // who knows the email can pick up that person's recent conversation from their
  // own computer. 0 = off (every new browser waits for a link). A bot can set its
  // own in project.json → "identity": { "graceMinutes": 15 }. Passkeys and
  // Google/Microsoft/Apple sign-in are trusted on any device regardless.
  // Under the hood → Settings edits this without a commit, like access above.
  identity: { graceMinutes: -1 },   // -1 = never block a second device (the demo's choice); 0 = always wait for the owner; N = minutes

  // ---- 5b. WHEN ACCESS RUNS OUT -----------------------------------------------
  // An email, an invitation or a passphrase can have an END DATE. Nothing does by
  // default: leave this alone and every window is unlimited, exactly as before.
  // THREE things can carry a date, because they're three different promises:
  //   the PERSON      "Amy's twelve weeks end on the 3rd."  Under the hood →
  //                   Settings → When access runs out. Works wherever the visitor
  //                   is identified: email, allow, key+email, and Plate.
  //   the INVITATION  "this cohort is on the list until the course finishes."
  //                   Set it when you add them to the allowlist. Only bites in "allow".
  //   the PASSPHRASE  "the demo key dies on Friday." One date per ACCESS_PASSPHRASE*
  //                   secret. Handy for a client deploy you've been paid for once.
  // When more than one applies THE EARLIEST WINS, and the owner's screen says which.
  // Extending is the same screen: type a later date, or clear it for unlimited.
  // Every change is written to the admin record with the person's address on it, so
  // Settings → Access over time shows one person's whole history in order.
  expiry: {
    // What lapsing DOES. The whole point of it being a setting: a members' bot and a
    // coaching log want different things.
    //   "tell"     locked out, told the date it ended and pointed at your handoff contact
    //   "readonly" they can still READ their own history — the composer is off. Kindest
    //              when a coaching block ends: their food log doesn't vanish
    //   "silent"   refused as if they'd never been on the list. Gives nothing away
    onLapse: "tell",
    graceDays: 0,      // days past the end date before any of that bites. 3 = a long weekend to renew
    warnDays: 7,       // the visitor sees a countdown for this many days first. 0 = no warning
    // Give every NEW person this many days from the day they join. 0 = unlimited,
    // which is the old behaviour. 84 = a twelve-week block, and you never type a date.
    // It's a policy, not a stored date: change the number and everyone without a date
    // of their own moves with it. Giving one person an explicit date always wins.
    defaultDays: 0,
  },
  // A single bot can override any of the four in its project.json → "expiry", the
  // same way it overrides "access". docs/CUSTOMIZE.md → "When access runs out".

  // ---- 6. THE FIREWALL ---------------------------------------------------------
  // All enforced in code (Engine/worker/firewall.js). Each one fails OPEN: if it can't run,
  // the bot still answers. Read the file — you don't have to change it, you have
  // to know it's there.
  firewall: {
    blockInjections: true,   // "ignore your instructions…" never reaches the model
    stripLinks: true,        // only project.allowedLinks survive, enforced after the model answers
    blockPromptLeaks: true,  // an answer that quotes the rules is replaced with a refusal
    llamaGuard: false,       // extra Workers AI safety model on every turn (doubles cost). See docs/CUSTOMIZE.md
    maxTurns: 12,            // how much history the model sees
    maxChars: 4000,          // per message
  },

  // ---- 6a. THE LIBRARY: PDFs, Word docs, spreadsheets, transcripts, images ----
  // knowledge/*.md is bundled into the prompt — a few pages, word-for-word.
  // The library is for everything else: files go into Cloudflare AI Search and
  // the bot gets the relevant passages per question. Each bot only sees its own.
  // Two ways in: Configure → Documents, or drop files into YourBots/<bot>/knowledge/
  // and let the GitHub Action sync them. docs/CUSTOMIZE.md → "Give it documents".
  // Answers that used the library cite it: a 📄 chip per document under the reply
  // (names only — visitors never get the files).
  // A bot can also answer from its own WEBSITE: project.json → "website": { "url": … }.
  // Cloudflare crawls it into a second instance ("<name>-web-<bot>") and re-crawls
  // on the schedule below. Free plan: 500 pages a day. "Or point it at your website" in the docs.
  library: {
    name: "bot-you-own-library",   // the AI Search instance; created on first upload
    maxPassages: 6,                // excerpts per question, documents and web pages together. 4–8. More is not smarter.
    matchThreshold: 0.4,           // 0–1. Raise to 0.5 if it quotes unrelated documents.
    contextTurns: 2,               // earlier visitor messages added to the search, so "and on Thursdays?" finds the page. 0 = latest message only.
    scan: true,                    // scan every upload for emails, cards, keys, "CONFIDENTIAL"… before it goes in
    scanWithModel: true,           // …and ask the model "would a business put this on its website?" (one small call)
    crawlIntervalHours: 24,        // how often a bot's website is re-crawled. 1, 2, 4, 6, 12 or 24 (the values Cloudflare offers)
    crawlMaxPages: 200,            // pages per crawl. Keep it under the free plan's 500 a day; raise it on a paid plan
  },

  // ---- 6a-0. MORE THAN ONE LANGUAGE ---------------------------------------------
  // The model already speaks dozens of languages; nothing is translated. A visitor
  // who writes in Spanish gets a Spanish answer built from your English files.
  // The code guesses the visitor's language from their own words (no model call:
  // Engine/worker/language.js), tells the model, and keeps the guardrails working.
  // Detected: English, Spanish, French, German, Portuguese, Italian, Dutch, and
  // by script Chinese, Japanese, Korean, Arabic, Russian/Ukrainian, Hindi. Anything
  // else is treated as English. Your handoff contact line is never translated.
  // docs/CUSTOMIZE.md → "More than one language".
  languages: {
    mode: "visitor",             // "visitor" = reply in the visitor's language; "owner" = always in yours
    owner: "en",                 // the language your files and handoff line are written in (ISO code)
    allowed: [],                 // only these, e.g. ["en", "es"]. Empty = any. Others get a polite "I can help in…"
  },

  // ---- 6a'. VISITOR ATTACHMENTS: "here's my invoice, what does it say?" --------
  // The paperclip next to the send button. A visitor attaches ONE file (PDF,
  // Word, spreadsheet, text or an image) and the bot reads it for THAT
  // conversation only. Nothing is stored on the server: the text is read out,
  // checked, handed back to the visitor's browser and re-sent with each message
  // while the chat lasts — exactly like the chat history. It never goes into
  // the library and never becomes a fact about your business (strict grounding
  // still refuses anything about you that isn't in your own files).
  // Every attachment is screened: "ignore your instructions" inside a PDF is
  // refused, and so is anything that looks like a card number or a key.
  attachments: {
    enabled: true,               // false hides the paperclip and switches the route off
    max: 1,                      // files per conversation
    maxBytes: 4 * 1024 * 1024,   // 4 MB, Cloudflare's converter limit
    maxChars: 20000,             // the text is cut here (about 8 pages); the bot is told it was cut
    retentionDays: 30,           // an attached file's text is dropped from server-side chat copies after this many days
  },

  // ---- 6a-i. VOICE IN AND OUT: talk to it, and hear it back --------------------
  // The microphone next to the paperclip, and a small speaker on every reply.
  // IN:  press the mic, talk, press again (or wait for maxSeconds). The browser's
  //      own recorder sends the clip to /api/transcribe; Workers AI (Whisper)
  //      turns it into text; the text lands in the input box for the visitor
  //      to check and send. Nothing goes to Google or Apple — it's your Worker.
  // OUT: the speaker under a reply reads it aloud (/api/speak → a Deepgram Aura
  //      voice on Workers AI). Auto-speak in the header reads every reply; off
  //      by default and remembered per browser.
  // Every clip and every read-out is a normal Workers AI call on your account,
  // through the same door and rate limit as the chat. Nothing is stored.
  // What it costs (developers.cloudflare.com/workers-ai/platform/pricing, Sept 2026):
  //   whisper-large-v3-turbo  $0.0005 per audio MINUTE  (46.63 neurons/min)
  //   aura-1                  $0.015 per 1,000 CHARACTERS spoken (1,363.64 neurons/1k)
  //   aura-2-en               $0.030 per 1,000 characters — the newer voice, twice the price
  //   10,000 neurons a day are free. A 30-second question is a quarter of a cent;
  //   a 400-character answer read aloud is six-tenths of a cent.
  // Model ids and voice names are on developers.cloudflare.com/workers-ai/models/.
  voice: {
    enabled: true,                                 // false hides the mic and the speakers and switches both routes off
    sttModel: "@cf/openai/whisper-large-v3-turbo", // speech → text. Also on the catalogue: @cf/openai/whisper (older, same shape)
    ttsModel: "@cf/deepgram/aura-1",               // text → speech. @cf/deepgram/aura-2-en for the newer voice
    ttsVoice: "asteria",                           // aura-1 voices: angus (default), asteria, arcas, orion, orpheus, athena, luna, zeus, perseus, helios, hera, stella
    maxSeconds: 60,                                // the mic stops itself here
    maxChars: 1500,                                // a reply longer than this is read up to here (about 90 seconds of speech)
  },

  // ---- 6a-ii. WHEN IT HANDS OFF, TELL SOMEONE ----------------------------------
  // Each bot chooses a webhook and/or an email in its project.json → "handoffActions"
  // (Configure → "When it hands off, tell someone"). Email needs the send_email
  // binding in wrangler.jsonc AND a "from" address on a domain you've onboarded to
  // Cloudflare Email Sending. Empty = emails are skipped (webhooks still work).
  // docs/CUSTOMIZE.md → "When it hands off, tell someone".
  handoffEmailFrom: "",            // e.g. "bot@yourdomain.com"

  // ---- 6a-iii. LEADS: who asked, and what they want ----------------------------
  // Needs email mode (access.mode "email" or "key+email") so visitors leave an
  // address. Under the hood → Leads lists every visitor with their turns and
  // refusals, and can write an AI brief per lead: what they asked, their
  // situation, what they care about, objections, the next step, a 0–100 score
  // with the reason. Stored in D1, refreshed on demand. No email is sent from
  // here — a lead is pushed to the bot's webhook (project.json → handoffActions
  // .webhook, or the one below) as event "lead-summary". docs/CUSTOMIZE.md → "Leads".
  leads: {
    autoAfterTurns: 4,             // summarise automatically at a visitor's 4th turn; 0 = only by hand
    notifyScore: 70,               // push to the webhook automatically when the score is at least this
    webhook: "",                   // fallback webhook for leads when the bot has none of its own
    maxTurns: 40,                  // how many of the visitor's most recent turns the summary reads
  },

  // ---- 6b. GITHUB (for "Commit to GitHub" on the Configure screen) --------------
  // The repo this bot deploys from. With the GITHUB_TOKEN secret set (a fine-grained
  // token with Contents: read & write on ONLY this repo), the Configure screen can
  // write a bot's folder straight into the repo. If the repo is connected to
  // Cloudflare Workers Builds, that commit redeploys the bot: the round trip.
  // Left EMPTY on purpose: the repo name is not in this file or in the page. Set the
  // GITHUB_REPO secret instead (printf 'you/your-repo' | npx wrangler secret put GITHUB_REPO).
  github: { repo: "", branch: "main" },

  // ---- 6d. LINKS THE APP HANDS OUT, KEPT OUT OF THE REPO ------------------------
  // The code, the owner walkthrough and the prompt library. Not here, not in the page:
  // set them live in Under the hood → Settings → Links. The page asks the Worker for
  // them (/api/tour) and gets the code and prompts once someone has signed up, the
  // walkthrough and the deploy button only if they may deploy. A grep of the app
  // finds nothing; a bot reading the page finds nothing.
  links: { code: "", checklist: "", prompts: "" },

  // ---- 6e. WORKSHOP KEYS: PREFIX-1234-5678. Make yours in Under the hood → Sign-ups. ------
  keys: { prefix: "SO" },   // letters only, up to 6 — the prefix says whose key it is

  // ---- 6c. THE FOOD LOG: /food — snap a plate, get the numbers ----------------
  // A photo food log a coach deploys for their clients. Not a chat bot: a page
  // with a camera button. People type their email once and are remembered on
  // that browser forever (a random device key, no password). Photos are read
  // by the vision model below and thrown away; only a 256 px thumbnail and
  // the numbers are kept. Barcodes (Open Food Facts), nutrition labels,
  // receipts, weigh-ins and a shared household for a spouse are all in.
  // The coach's view is /food/coach (the admin code). docs/FOOD-LOG.md.
  // Secrets: FOODLOG_PEPPER (required for real use: npx wrangler secret put
  // FOODLOG_PEPPER), and GOOGLE_CLIENT_ID / MICROSOFT_CLIENT_ID / APPLE_CLIENT_ID
  // if you want "Sign in with …" to link a second device (optional).
  // What it costs (developers.cloudflare.com/workers-ai/platform/pricing, Sept 2026):
  //   gemma-4-26b-a4b-it  $0.10 per M input tokens, $0.30 per M output tokens.
  //   A plate photo is about 400 input + 150 output tokens ≈ 10 neurons ≈ $0.0001
  //   — a hundredth of a cent. The free 10,000 neurons a day cover ~1,000 photos.
  // foodLog: DEPRECATED here since v3.7. The food log is a bot folder now —
  // YourBots/plate/project.json with "kind": "food" and a "food": { … } block
  // (docs/FOOD-LOG.md). A foodLog block left here still works, with a warning
  // in the logs, until the next release.

  // ---- 7. LOOKS --------------------------------------------------------------
  accent: "#10a37f",

  // What the page says while it waits for the first word of an answer (usually
  // one to three seconds). One is picked at random, then they rotate. Any number
  // of words; a project can bring its own list in project.json → "thinkingWords".
  thinkingWords: [
    "Thinking", "Pondering", "Mulling it over", "Checking the files", "Rummaging",
    "Cogitating", "Noodling", "Consulting the notes", "Brewing", "Percolating",
    "Weighing it up", "Reading that back", "Sifting", "Deliberating", "Ruminating",
    "Chewing on it", "Looking that up", "Marshalling the facts", "Considering", "Composing",
  ],
};
