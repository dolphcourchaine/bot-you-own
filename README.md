# The Bot You Own

A ChatGPT-style assistant that runs **on your own domain, in your own Cloudflare
account, from code you can read** — for a few dollars a month, usually zero.

Not a custom GPT. Not a $99-a-month rental. Yours.

**The workshop, recorded:** https://www.skool.com/sovereign-operator/about — 7 days free, then $47 a year.
Join, then open Classroom → **🤖 Build the Chatbot That Answers Your Customers**. The whole build is yours the
minute you join: your custom GPT out of ChatGPT and running on your own domain in about twenty minutes, every
step on screen. Live workshops (a new AI hire every third Friday) are the Premium tier.
**Licence:** PolyForm Shield — deploy it for your own business and clients and earn with it;
don't set it up for other businesses or resell it. Plain English in `NOTICE.md`.

**Do you need to buy anything? No.** The code is free to deploy and run for your
own business (that's the licence). The **recording** is the walkthrough: from the
button to a bot on your own domain with the sign-up funnel switched on, plus the
parts that need a human (the domain, the spend cap, the secrets, the texting
number), with the people who've done it. Take it if you want to be walked through
it; skip it if you'd rather read the docs.

**You will not open a terminal. You will not install anything.** If you can use
a browser and edit a document, you can do this.

It is built from three layers, and the workshop teaches them in this order:

| Layer | Where | What it is |
|---|---|---|
| **1. The Prompt** | `YourBots/_prompt/*.md` | A ChatGPT-grade system prompt in plain Markdown: identity, date, tone, formatting, honesty, boundaries, the jobs. Your project's instructions sit on top. `Engine/worker/prompt.js` only stitches the files together. |
| **2. The Data** | `YourBots/` | **Projects** — the same shape as a ChatGPT Project or a custom GPT: `instructions.md` + `knowledge/` files + starter prompts. Four samples ship so you can test before you type. |
| **3. The Firewall + Gateway** | `Engine/worker/firewall.js` · `Engine/worker/gateway.js` | What stops it doing what it shouldn't. Enforced in code (link allowlist, injection screen, leak detection, rate limit) and at the edge (AI Gateway: dollar spend cap, logs, Guardrails). |

---

## Two folders
| | What's in it | Who touches it |
|---|---|---|
| **`YourBots/`** | one folder per bot (`project.json` + `instructions.md` + `knowledge/` + optional `prompt/`), plus `_prompt/` — the voice, rules and jobs every bot shares, in plain Markdown — and `_template/` to copy | you |
| **`Engine/`** | `worker/` (the code), `public/` (the page), `scripts/` (the build), `tests/` (the break-it set) | nobody, unless you want to |

`YourBots/config.js` is the deployment (model, who can use it, firewall switches, GitHub
target). The guides live in `docs/`. At the root: only this README and the files
Cloudflare and npm need (`wrangler.jsonc`, `package.json`).

**One rule to remember:** a file in `YourBots/_prompt/` is every bot's; the same
file inside a bot's own `prompt/` folder is that bot's, and wins.

## Deploy it (three minutes, no card)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/JimTyrrell/bot-you-own)

Click it. You need two free accounts — **GitHub** (where your copy of this code
lives) and **Cloudflare** (where it runs). Cloudflare copies this project into
your GitHub, builds it, and puts it on the internet.

You will also want **a domain on Cloudflare** before you put a bot in front of
customers: either register a new one there (Domain Registration → Register, at
cost price) or transfer one you already own (Domain Registration → Transfer, or
just point its nameservers at Cloudflare). The workers.dev address works for
testing, but sign-in passkeys are bound to the hostname, so moving to your own
domain later means everyone sets their passkey up again. Get the domain first.
`docs/OWNER-CHECKLIST.md` §0 walks through it.

You'll get a URL like `bot-you-own.your-name.workers.dev`. Open it. You'll see a
ChatGPT-style page with four projects in the sidebar. Try each one. Then try to
break them — that's the point of the samples.

---

## First run: your admin code (two minutes)

Nothing ships with a key. Until you set one, the site runs but the **⚙ Under the
hood** button does not exist and every admin route answers 404. To switch it on:

1. Cloudflare dashboard → **Workers & Pages** → your worker → **Settings** →
   **Variables and Secrets** → **Add**.
2. Type **Secret**. Name `ADMIN_PASSPHRASE`. Value: a passphrase you choose.
   Save, then **Deploy** (the button at the top of that page).
3. Reload your site. The **⚙ Under the hood** button appears; your passphrase opens it.

Or from a terminal in your copy of the repo:

```bash
printf 'your passphrase' | npx wrangler secret put ADMIN_PASSPHRASE
```

**Forgot it?** Do the same step with a new value. The old one is gone; nobody
can recover it, including us. **Second factor:** add `ADMIN_TOTP_SECRET` (a base32
secret from your authenticator app) and the admin code also asks for six digits
— do this before the sign-up gate collects real people's numbers.
`docs/OWNER-CHECKLIST.md` §1b has all three first-day secrets.

## Staying up to date

Your copy is yours: the button makes a new repo, not a link. Two ways to keep
getting improvements to the engine without losing your own bots:

- **Automatic (already in your copy).** `.github/workflows/update-from-upstream.yml`
  runs every Monday and pulls the latest from the original project. A clean
  merge is pushed and your site rebuilds; if the same lines changed on both
  sides, it opens a pull request called "Update from upstream" for you to look
  at. Run it any time from the **Actions** tab → "Run workflow". Delete the file
  to opt out. (GitHub pauses scheduled runs on a repo with no activity for 60
  days; the Actions tab shows a button to re-enable.)
- **Fork, if you're comfortable with GitHub.** Fork the original instead of
  using the button, deploy the fork with the same button, and GitHub's own
  **Sync fork** button pulls updates in one click.

Both work because of the two-folder rule: your edits live in `YourBots/` and
the engine lives in `Engine/`. Keep it that way and updates never fight you.

## Make it yours — four steps

### 1. Make a project · `YourBots/`
Copy `YourBots/_template/` to `YourBots/my-business/`. Fill in three things:
- `project.json` — name, greeting, starter prompts, which job it does (`mode`), the
  links it's allowed to share, and where to send people when it can't help.
- `instructions.md` — what you'd have typed into ChatGPT's Instructions box. Paste it raw.
- `knowledge/` — what you'd have uploaded as files. Markdown or plain text.

Then set `defaultProject: "my-business"` in `YourBots/config.js`. Nothing to register: the
build finds every folder in `YourBots/`. **Read `YourBots/README.md`.**

> **The single highest-value hour you will spend on this:** go into your sent
> folder and find the emails where you answered the same question for the tenth
> time. Paste those in. Your words, already tested on real customers.

### 2. Pick the job · `project.json` → `mode`
`assistant` · `answer` ⭐ · `intake` · `booking` · `concierge` · `internal` · `imported`.
**Read `docs/MODES.md`, then start with `answer`.** One project = one job. Want two
jobs? Make two projects; the sidebar shows both.

### 3. Pick how much it's allowed to know · `project.json` → `grounding`
- `"strict"` — it answers **only** from your files and hands off otherwise. For anything customer-facing.
- `"open"` — it behaves like ChatGPT, using your files first when they apply. For yourself and your team.

**Bonus, for coaches: a photo food log.** `YourBots/plate/` is a bot of kind
`food`: a camera-first food log your clients use on their phones at `/apps/plate` —
snap the plate, fix the portion, see the day as a ring and three bars; barcodes,
labels, receipts, weigh-ins, a shared household. The day is a conversation: every
meal is a turn with a one-line reaction, you can ask the coach bot "what should
dinner be to hit protein?", and Day / Week tabs carry a written review and a
seven-day look-back. The things you eat every day are one-tap chips ("same as
yesterday", "log my work lunch"). You see every client at
`/apps/plate/coach`. Sign-in is passkeys, Google/Microsoft/Apple, an authenticator
code or email + device — never an email sent (`docs/IDENTITY.md`). Copy the folder
for a second, separate log. `docs/FOOD-LOG.md` has the whole thing.

### 4. Put it on your website · `Engine/public/widget.js`
One script tag. Inline or bubble. See `https://YOUR-BOT-URL/embed-example`.
```html
<div data-mybot style="height:640px"></div>
<script src="https://YOUR-BOT-URL/widget.js" async data-project="my-business"></script>
```
The widget is the same page in an iframe, so everything the page can do the
widget can do: the 📎 paperclip (a visitor attaches one file for that chat), the
🎤 mic (talk instead of type — Whisper on Workers AI writes the words into the
box, the visitor checks them, then sends) and the 🔊 speaker under each reply.
Each appears only when it's switched on in `YourBots/config.js` (`attachments`,
`voice`). `docs/CUSTOMIZE.md` → "Voice in and out".

---

## Building a bot the ChatGPT way (no files at all)
With the admin code, **✎ Configure** opens the same screen ChatGPT's GPT builder
has: Name, Description, Instructions, Conversation starters, Knowledge (Upload
files), Capabilities — with a live **Preview** chat on the right that talks to
your unsaved draft. **Save** stores it in your bot's database and it is live at
once. **Commit to GitHub** writes the bot's folder into your repo for you (one secret to
set up, `docs/DEPLOY.md` §B5); **Export files** shows the same files if you'd rather
paste. A saved copy overrides the folder with the same
name; remove it and the folder is live again. **✎ New bot** in the sidebar starts
a blank one.

| ChatGPT's builder | Here |
|---|---|
| Name · Description · Instructions · Conversation starters | the same fields |
| Knowledge → Upload files | Upload files (text: .md .txt .csv) or write one in place |
| Recommended model | one model for the deployment, in `YourBots/config.js` |
| Capabilities: web search, images, code interpreter | not in this bot — shown unticked so nobody has to guess |
| Actions | not in this bot |
| Create tab (describe it and the builder writes it) | not yet |
| Preview | the right-hand pane |
| — | Job, strict/open grounding, the handoff line, allowed links, thinking words: the things ChatGPT doesn't let you set |

## Coming from ChatGPT?
**Read `docs/MIGRATE.md`.** A custom GPT or a Project moves across in about twenty minutes:
paste Instructions into one file, files into a folder, flip one switch.

---

## The part nobody else teaches: it has to be able to say no

Open `Engine/worker/firewall.js` and read it. You don't have to change it — you have to
know it's there. Every check is tagged with the OWASP LLM Top 10 risk it covers.

- **Before the model:** hidden characters stripped; "ignore your instructions"-style
  attempts never reach the model at all; rate limit per visitor.
- **Inside the model:** the prompt's `<boundaries>` — the two rules that matter most,
  from OpenAI's own Model Spec: *ignore untrusted data by default* and *do not
  reveal privileged information.*
- **After the model:** links not on your allowlist are removed in code; an answer
  that quotes the rules is withheld; optional Llama Guard on both sides.
- **At the edge (optional):** AI Gateway — a dollar spend cap, logs, caching, and
  Cloudflare's own Guardrails. See `docs/DEPLOY.md`.

The page shows a small chip under any answer the firewall touched, so you can
watch it work. **Test it by trying to break it** — `Engine/tests/break-it.mjs` is the
set we run, in plain rules you can read.

---

## Who can use it · `project.json` → `access` (per bot) · `YourBots/config.js` → `access.default` / `floor`
| Mode | What a visitor sees | Use it for |
|---|---|---|
| `open` | nothing, just the chat | a public website bot (rely on the rate limit and a spend cap) |
| `email` | "enter your email to start" | a members' or clients' bot where you want to know who asked; their chats follow them to any computer |
| `allow` | the email screen, then "invited people only" unless the address is on the list | a named group — clients, members, a cohort (Settings → The allowlist, encrypted at rest) |
| `key` ⭐ default | a passphrase screen | demos, internal bots, anything without a spend cap yet |
| `key+email` | both | a private bot with a record of who used it |
| `admin` | "owner only" | a bot only you should talk to |
| `draft` | "this bot is a draft" | a bot you're still building — only the Configure preview answers |

Each bot says its own in `project.json`; leave it out and it gets the deployment
default. The **floor** (`access.floor`) is the most open any bot may be — set it to
`key` and every bot locks at once, the panic switch. `"listed": false` hides a bot
from the sidebar (it still works by link and in the widget). A bot can name its
own passphrase secret (`accessKey`). Under the hood → **Settings** shows what applies
to every bot and why. `docs/CUSTOMIZE.md → Who can use it`.

`email` is **identification, not authentication**: nobody verifies the address.
It is stored in the visitor's browser, sent with every message, and logged with
each turn (Workers Logs, and the D1 table's `visitor` column if logging is on).
Questions and answers are still redacted; the email is kept on purpose. Say so in
your privacy note. A **Sign out** button in the sidebar clears the key, the email,
and the admin code.

### The key
Set one secret and the bot asks for a passphrase before it will talk:
```bash
npx wrangler secret put ACCESS_PASSPHRASE      # or: dashboard → Worker → Settings → Variables & Secrets
```
Locally, put `ACCESS_PASSPHRASE=…` in a `.dev.vars` file (already git-ignored).
The page shows an unlock screen; the passphrase is never stored in the browser — a
token derived from it is, so it also works inside the embed iframe. Wrong guesses
share the same per-visitor rate limit as chat. Remove the secret and the bot is
public again. **Use this for demos, internal bots and anything you haven't put a
spend cap on yet.** A public website bot stays open and relies on the rate limit
plus an AI Gateway spend limit.

## Look under the hood (admin code)
Set a second secret, `ADMIN_PASSPHRASE`, and a **⚙ Under the hood** button appears
in the header. Enter the admin code and you get, for the project you're looking at:
the exact system prompt being sent to the model (with a token count), every file
it was given, the firewall switches and the injection patterns, what each chip
means, the model and gateway settings, the version stamp, and the engine's source
files themselves. Visitors with the ordinary passphrase never see any of it.
This is the workshop's "open the bonnet" moment: nothing is hidden from the owner.

## The audit log (what people actually asked)
Every turn is written to a small database in your account: time, project, who
(in email mode), the question, the answer, whether it was refused, and what the
firewall did. The Worker creates the table itself; the Deploy button provisions
the database. Read it under the hood → **Audit** (filters: refused, flagged, this
project / all) or with the SQL in `docs/CUSTOMIZE.md`. Emails, phone numbers and dates
inside questions and answers are redacted before storage; names are not. The
most-refused questions are the pages your business hasn't written yet.

## Version
`package.json` → `"version"` holds the number you bump. Every dev run and deploy stamps
`version.json` with that number, the build time and the git commit; it shows in the
page footer, at `/health`, and under the hood. When someone asks "which version is
live?", the answer is in the footer.

## What it costs
- **Nothing to start.** Free tier: 100,000 requests a day, 10,000 AI neurons a day. The free tier is a hard ceiling with no surprise bill.
- **$5/month** for the Workers paid plan when you outgrow it, plus metered AI usage — small. Put an AI Gateway spend limit on it the day you go paid.
- No per-message plan. No per-seat pricing. No badge to pay to remove.

## Where this stops being enough (honest version)
- **Documents are fine now, up to a point.** Text files are bundled into the prompt; PDFs, Word, sheets, transcripts and screenshots go into the library (Cloudflare **AI Search**, wired in, scanned before they go in) — `docs/CUSTOMIZE.md → Give it documents`. Two hundred PDFs is fine. A website crawl or multi-tenant search is a different build.
- **Browsing, image generation, code execution.** Not included. `docs/MIGRATE.md` says exactly what doesn't come across. (A visitor *can* attach one file to a conversation — read for that chat, screened, never stored — `docs/CUSTOMIZE.md → Let visitors attach a file`.)
- **Sign-in / private bots.** Rate limiting is what a public bot needs; access control is a different build.
- **Regulated data.** Health, financial, legal — the requirements are paperwork, not code. Know that before you point a bot at them.

---
*Built as part of **The Bot You Own** — Designatic. thedesignatic.com*
