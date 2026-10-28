# Deploying — the button, the terminal, and the gateway

## A. The button (attendees)

A note on the database: `wrangler.jsonc` names the D1 database (`bot-you-own-logs`)
but pins no id on purpose. On the first deploy wrangler creates that database in
*your* account; on every deploy after, it keeps using it. If a build ever fails with
"D1 binding 'DB' references database … which was not found", the config being built
still has an id in it: pull the latest `main`.

Public GitHub repo → README button → Cloudflare copies it into your account,
builds, deploys. Requirements (from Cloudflare's docs): the repo is **public**, on
github.com or gitlab.com, and `wrangler.jsonc` has defaults for every binding.
That's why the optional bindings in this repo are commented out.

Every later change = edit a file in GitHub → Commit. Cloudflare rebuilds in about a minute.

## B. The terminal (Jim)
```bash
npm install
npx wrangler login              # once
npx wrangler dev                # http://localhost:8787
node Engine/tests/break-it.mjs         # in a second terminal — the break-it set
npx wrangler deploy             # → https://bot-you-own.<subdomain>.workers.dev
```

## B2. Lock it (recommended for the demo)
```bash
printf 'your passphrase here' | npx wrangler secret put ACCESS_PASSPHRASE
```
Local dev reads it from `.dev.vars` (`ACCESS_PASSPHRASE=…`). The test runner takes
`--passphrase "…"` or the `BYO_PASSPHRASE` env var. Delete the secret to reopen the bot.
What it is: `POST /api/unlock { passphrase, project }` turns the passphrase into an
HMAC token for that bot's key; `/api/chat`, the paperclip, the mic, the speaker,
Talk to a person and `/api/config` all check it (`x-access-token`). It is a gate
against strangers and scripts, not user accounts — everyone shares one phrase.
The passphrase screens allow ten tries a minute per visitor (`UNLOCK_LIMITER` in
`wrangler.jsonc`), on top of the 30-a-minute chat limit.

## B2b. Who can use it: a default, a floor, and each bot's own say
Every bot can say in its `project.json → "access"` how it opens; the deployment
sets what a bot gets when it doesn't say (**default**) and the most open any bot
may be (**floor**). Most open first: `open < email < allow < key < key+email < admin < draft`.
A bot's effective mode is the stricter of (its own mode, or the default) and the floor.

Three places set the default and the floor — later wins:
1. `YourBots/config.js → access: { default: "key", floor: "open" }` (the old `mode` still reads as `default`).
2. `YourBots/settings.json` — what under the hood → **Settings → Commit to GitHub** writes.
3. The saved row from **Settings → Save** — live within seconds, no deploy.

`key` needs the secret from B2 (without it the bot runs open and logs a warning).
`email` needs nothing; the runner takes `--email you@example.com`. A bot can have
its **own** key: `"accessKey": "ACCESS_PASSPHRASE_CLIENTX"` names a second secret
(`printf '…' | npx wrangler secret put ACCESS_PASSPHRASE_CLIENTX`); only names of the
shape `ACCESS_PASSPHRASE_…` are honoured, and a token minted for one key never
opens another. The floor is the panic switch: `floor: "key"` and every bot needs
the passphrase whatever its file says. The full story, modes table and what none
of it is (sign-in): `docs/CUSTOMIZE.md → Who can use it`.

**Prove it:** `node Engine/tests/access-check.mjs --url http://localhost:8797 --passphrase "…" --admin "…" [--unlock "…"]`
saves eight test bots (open, draft, admin-only, own key, unlisted, email, the return
window, allow), proves each door with curl-style calls — no model calls, so no cost —
checks the floor, history on any computer, the allowlist, the admin events, the body
caps and (with `--unlock`) the break-glass key, then deletes them. For the own-key
check put `ACCESS_PASSPHRASE_CLIENTX=clientx-secret` in `.dev.vars` (or pass `--clientx`).
It uses five of the ten passphrase tries a minute and pauses twice for the visitor
rate limit, so it takes about four minutes; wait a minute between runs.

## B2c. The allowlist key (access mode `allow`)
A bot in `allow` mode lets in only the emails the owner listed (Settings → The
allowlist; per bot, or for every bot). The list is encrypted at rest and needs one
secret — 32 random bytes, base64:
```bash
printf "$(openssl rand -base64 32)" | npx wrangler secret put ALLOWLIST_KEY
```
Local: `ALLOWLIST_KEY=…` in `.dev.vars`. Both the hash key (to check one address)
and the cipher key (so you can read the list) derive from it. **Without it, allow
mode refuses everyone** and the log says so once. Rotating it empties the list
the same way (the old hashes no longer match) — add people again afterwards.

## B2d. The return window
`YourBots/config.js → identity.graceMinutes` (default 60; Settings edits it live;
a bot can set its own in `project.json → identity`). A visitor in email / allow
mode who types their email on a *new* computer within that many minutes of their
last activity is trusted at once and their chats follow them. Set `0` to make every
new computer wait for your link. The trade-off is spelled out in `docs/IDENTITY.md`.
If you created the D1 tables before v2.2, add the column: `ALTER TABLE conversations ADD COLUMN visitor TEXT;`

## B3. The admin code (Under the hood)
```bash
printf 'your admin code' | npx wrangler secret put ADMIN_PASSPHRASE
```
Local: add `ADMIN_PASSPHRASE=…` to `.dev.vars`. An admin token also unlocks chat,
so you don't need both codes. Endpoints: `POST /api/admin/unlock`,
`GET /api/admin/engine?project=…`, `GET /api/admin/source?name=Engine/worker/prompt.js`,
`GET/PUT /api/admin/settings`, `GET /api/admin/events`. Without the secret, every
`/api/admin/*` and `/engine/*` path answers 404 — there is nothing to find.

**Log every admin out:** the admin token carries a version. Set a second secret
`ADMIN_TOKEN_VERSION` to any new value (`printf '2' | npx wrangler secret put ADMIN_TOKEN_VERSION`)
and every stored admin token stops working; people enter the admin code again. No
code change, no redeploy. Under the hood → Settings shows the current version.

**What changed, and when:** every write the admin makes (a bot saved or removed, a
commit, settings, a document put in or taken out, a reply to a visitor, a lead
sent) lands in the D1 table `admin_events` with a SHA-256 of the caller's IP —
never the IP. Under the hood → Settings lists the last 50; `GET /api/admin/events?limit=100`.
Admin writes take JSON only (`content-type: application/json`) and at most 256 KB a
request; uploads keep their own 4 MB cap.
The source snapshot in `Engine/public/engine/` is produced by `Engine/scripts/snapshot-src.mjs`
before every dev/deploy (`build.command` in `wrangler.jsonc`) and is git-ignored;
`run_worker_first` keeps `/engine/*` behind the gate.

## B3d. The break-glass key (get back in when the authenticator is lost)
Set a second, long, random secret:
```bash
printf "$(openssl rand -base64 24)" | npx wrangler secret put ADMIN_UNLOCK_KEY
```
Typed where the admin code goes (leave the authenticator field empty), it opens
"Under the hood" on its own: no passphrase check, no six digits — even when
`ADMIN_TOTP_SECRET` is set, lost or wrong. Every use lands in `admin_events` as
`admin-break-glass`, and the page sends you straight to Settings with the commands
to re-set `ADMIN_TOTP_SECRET` and bump `ADMIN_TOKEN_VERSION`. It is a recovery
credential, not a login: keep it somewhere the authenticator isn't, use it once,
then set a new one. Shorter than 16 characters and it is ignored (the log says so).
Owner checklist item 7.

## B3b. Handoff webhook signature (optional)
`printf 'a long random string' | npx wrangler secret put HANDOFF_WEBHOOK_SECRET` — every handoff
webhook then carries `x-handoff-signature` (hex HMAC-SHA256 of the body). Local: `.dev.vars`.
Setup and verification: `docs/CUSTOMIZE.md → When it hands off, tell someone`.

## B3c. Booking as an action (optional)
`printf 'cal_live_…' | npx wrangler secret put CAL_API_KEY` — a booking bot with `project.json → booking`
set then offers free times and books the call through Cal.com. Local: `.dev.vars`. Setup: `docs/CUSTOMIZE.md → Booking as an action (Cal.com)`.

## B4. Versioning
Bump `"version"` in `package.json`, commit, deploy. `public/version.json` is generated at build with
`{version, builtAt, commit}`; `/health` returns `ok 2.1.0 <commit> <builtAt>`.

## B5. Commit to GitHub from the Configure screen (the round trip)
1. `YourBots/config.js` → `github: { repo: "you/your-repo", branch: "main" }`.
2. GitHub → Settings → Developer settings → Fine-grained tokens → one token, **only
   this repo**, permission **Contents: Read and write**. Then:
   ```bash
   printf 'github_pat_…' | npx wrangler secret put GITHUB_TOKEN
   ```
3. Connect the repo to Cloudflare Workers Builds (the Deploy button does this;
   otherwise Worker → Settings → Builds → connect). Now: Configure → Save (live at
   once from the database) → **Commit to GitHub** (the bot's folder lands in the
   repo) → Workers Builds redeploys → the folder is the deployed version. Remove
   the saved copy afterwards so the folder is the single source. The commit includes
   the bot's library documents (PDFs etc. under `knowledge/`) and its `APPROVED.txt`.

## B6. The library (documents in AI Search)
Nothing to create: `wrangler.jsonc` binds the `default` AI Search namespace and the
Worker makes its own instance (`YourBots/config.js` → `library.name`) on the first
upload. Uploads use the admin code from B3 — Configure → Documents. For the GitHub
route (files in `YourBots/<bot>/knowledge/` synced by `.github/workflows/sync-library.yml`),
add two **repository** secrets in GitHub: `BOT_URL` and `ADMIN_PASSPHRASE`. Check it's
alive: under the hood → Files lists the bot's documents; Configure → Documents
uploads. Details and the scan: `docs/CUSTOMIZE.md → Give it documents`.

## C. Your own domain
Dashboard → Workers & Pages → the Worker → Settings → Domains & Routes → Add →
Custom Domain → `chat.yourdomain.com`. The domain has to be on Cloudflare. Pick
a hostname that doesn't already have a record.

## D. The gateway (the dollar ceiling) — on by default, one thing left to click
`YourBots/config.js` ships with `gateway: { id: "bot-you-own" }`, so every model call
already *tries* to go through Cloudflare AI Gateway. The gateway just has to exist
on your account. Until it does, the Worker notices (Workers AI answers
`2001: Please configure AI Gateway in the Cloudflare dashboard`), logs **one**
warning per isolate — *AI Gateway "bot-you-own" doesn't exist on this account yet — calls
are going direct…* — and answers from the model directly. Those turns carry the
`gateway-direct` flag in the Audit tab, and Under the hood → Gateway & model says
`lastCall: direct (gateway missing)`. A missing gateway never breaks a chat; it just
means no logs and no spend limit yet.

**1. Create it (dashboard, 30 seconds).** Dashboard → **AI → AI Gateway → Create Gateway**.
Name: `bot-you-own`. Leave the rest default. That's it — the next model call goes through
it and the Gateway tab flips to `via gateway`.

Or with the API — needs an API token with **AI Gateway: Read + Edit** (My Profile →
API Tokens → Create Token → Custom; the wrangler login token does *not* have this
permission, so `wrangler` can't do it for you):
```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai-gateway/gateways" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "content-type: application/json" \
  --data '{ "id": "bot-you-own", "cache_invalidate_on_update": true, "cache_ttl": 0, "collect_logs": true,
            "rate_limiting_interval": 60, "rate_limiting_limit": 120, "rate_limiting_technique": "sliding" }'
```
(120 requests a minute across the whole gateway; the Worker's own per-visitor limit
in `wrangler.jsonc` is 30 a minute.)

**2. Set the spend limit (dashboard).** AI → AI Gateway → `bot-you-own` → **Settings →
Spend limits → Add rule**: limit type *cost*, e.g. **$5 per day** (generous for an FAQ
bot), technique *sliding*. Past the limit, requests are *blocked* — the chat shows the
handoff text and the Audit tab shows `model-error`. Budget *alerts* are not caps: use
limits for the ceiling, alerts for the warning. The API can set it too, but only as an
update after the gateway exists (`PUT …/ai-gateway/gateways/bot-you-own` with
`spend_limits: { enabled: true, rules: [{ limitType: "cost", limit: 5, window: 86400, technique: "sliding" }] }`) —
not in the create call.

**3. Optional, same Settings page:**
   - **Guardrails** — Cloudflare runs Llama Guard on prompts and responses at the edge. Set categories to Flag (log) or Block. A blocked request shows in the chat as "blocked at the gateway".
   - **Logs** — on already (`collect_logs`): every request, with tokens and cost. Also `GET …/ai-gateway/gateways/bot-you-own/logs` with the same token.
   - **Caching** (optional) — set `cacheTtl` in `YourBots/config.js` to cache identical questions.

Nothing in the code changes when you flip these. That's the point of a gateway.
To switch the gateway off, set `gateway.id` to `""`.

## E. Other models (optional)
Workers AI needs no key and is the default. To use OpenAI or Anthropic instead:
```bash
npx wrangler secret put OPENAI_API_KEY      # or ANTHROPIC_API_KEY
```
then in `YourBots/config.js`: `provider: "openai", model: "gpt-4.1-mini"` or
`provider: "anthropic", model: "claude-opus-5"`. Set `gateway.accountId` too if you
want those calls to go through AI Gateway (recommended: the spend cap applies).

## F. The audit log (on by default)
`wrangler.jsonc` binds a D1 database called `bot-you-own-logs`. The Deploy button
creates one in the attendee's account; from the terminal, `npx wrangler d1 create
bot-you-own-logs` once and paste the id. No schema step: the Worker runs
`CREATE TABLE IF NOT EXISTS` on first use. Read it under the hood → Audit, or with
the queries in `docs/CUSTOMIZE.md`. Personal info is stripped before storage (emails,
phones, dates — not names). Remove the binding to log only to Workers Logs.
