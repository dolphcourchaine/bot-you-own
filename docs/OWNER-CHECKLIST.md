# Owner checklist — the things only you can do

Everything in this file needs your own login somewhere (Cloudflare, GitHub,
Google) or a secret only you should hold. The Worker runs fine without any of it:
each item switches on one more capability, and the code notices it's missing and
carries on. Do them in any order. Each says exactly what to click and how to
check it worked.

The account: this Worker is on **your own Cloudflare account**. If that login
has more than one account, every `wrangler` command below needs
`CLOUDFLARE_ACCOUNT_ID=<your-account-id>` in front of it (Cloudflare dashboard →
any site → **Overview**, right-hand column → **Account ID**). Run them from the
repo folder. Your live URL is `https://bot-you-own.<your-subdomain>.workers.dev`
until you attach a custom domain (DEPLOY.md §C).

A note on `wrangler secret put`: it reads the value from your terminal. The
`printf '…' | npx wrangler secret put NAME` form types it in one line without a
prompt. The value is never printed back and never enters git.

**The short way through this file:** the last pill in the strip along the top of
your site, **🔧 Turn off demo mode**, opens a five-step walkthrough (also at
`https://your-site/?panel=owner`): claim it, sign in as the owner, set up your
stack, lock it down, turn off demo mode. Each step ticks itself from what the
Worker reports, and each amber line says what to click. It covers items 0, 1, 1b,
5 and 7 below. The pill shows to everyone until the deployment is claimed (an
`ADMIN_PASSPHRASE` exists), and only to the signed-in owner after that. Demo mode
(the tour, the sample bots, the guide bot) comes back from **Under the hood →
Security → Demo**; nothing is ever deleted.

---

## 0. A domain on Cloudflare (do this first)

Why: the Worker runs on a `*.workers.dev` address out of the box, and that is fine
for testing. It is not fine for customers: the address advertises the account,
it can't be branded, and every passkey a person sets up is bound to the hostname,
so moving later means they all set up again. You need a domain **on Cloudflare**,
meaning Cloudflare runs its DNS. Three ways to get there, cheapest first:

1. **Register a new one.** Dashboard → **Domain Registration → Register Domains**.
   Cloudflare sells at cost (no markup, no upsell). It is on Cloudflare the moment
   it's bought.
2. **Transfer one you own.** Dashboard → **Domain Registration → Transfer Domains**.
   Unlock it at the current registrar, get the auth code, paste it here. Takes up
   to five days; the site keeps working throughout.
3. **Keep it where it is, move the DNS.** Dashboard → **Add a domain** (top of the
   account home) → type the domain → Free plan → change the nameservers at your
   registrar to the two Cloudflare gives you. Live within an hour, usually.

Then attach it to the Worker: **Workers & Pages → bot-you-own → Settings →
Domains & Routes → Add → Custom Domain** → a hostname that has no DNS record yet
(`chat.yourdomain.com`, say). Cloudflare makes the record and the certificate.

Check: open `https://chat.yourdomain.com`. The bot is there, with a padlock. Keep
the workers.dev address **out** of anything you give people.

---

## 1. The AI Gateway (the dollar ceiling)

**How you know it's not done yet:** under every reply on the live bot there's a
chip that says **"☁ Cloudflare setup to do: create the AI Gateway (spend cap +
logs) — how ↗"**. Clicking it opens this section. The bot works fine without the
gateway; what you're missing is a hard cap on what the model can cost you, plus
logs, caching and a rate limit. Ten minutes, no code, no terminal.

Why: every model call already *tries* to route through a Cloudflare AI Gateway
named `bot-you-own` (it's set in `YourBots/config.js` → `gateway: { id: "bot-you-own" }`).
Until a gateway with that exact name exists, Cloudflare answers "2001: please
configure AI Gateway" and the Worker falls back to calling the model directly.
Create it and the very next call goes through it.

### Step 1 — Open AI Gateway

1. Log in at <https://dash.cloudflare.com>.
2. In the left sidebar click **AI**, then **AI Gateway**.
   (On a narrow window the sidebar is behind the ☰ menu, top left.)

![Cloudflare sidebar: AI → AI Gateway](images/ai-gateway-1-sidebar.png)

### Step 2 — Create the gateway

1. Click **Create Gateway** (top right on a fresh account; the button reads
   **+ Create** if you already have one).
2. **Gateway name:** type `bot-you-own` — all lower-case, hyphens, no spaces.
   The name has to match the config exactly or the Worker won't find it.
3. Leave everything else at its default. Click **Create**.

![Create Gateway dialog with the name bot-you-own](images/ai-gateway-2-create.png)

### Step 3 — Set the spend limit

1. Open the new gateway (click its name in the list).
2. Click the **Settings** tab.
3. Find **Spend limit** (it may be under "Rate limiting & budgets" depending on
   the dashboard version). Switch it **on**.
4. Put in a monthly dollar figure. **$5** is plenty to start; raise it any time.
   When the cap is hit the gateway refuses further calls and the bot shows its
   handoff message instead of an answer, so nobody can run up your bill.
5. **Save.**

![Settings tab: spend limit switched on, $5 per month](images/ai-gateway-3-spend-limit.png)

Optional, same tab: **Rate limiting** (e.g. 100 requests per minute) and
**Cache** (repeat questions answered from cache, free). Both are safe defaults.

### Step 4 — Check it worked

1. Send any message on the live bot.
2. The chip under the reply is gone. That's the whole check.
3. For the long version: open **Under the hood → Gateway & model**. `lastCall`
   reads **"via gateway"**, not "direct (gateway missing)".
4. Back in the dashboard, **AI Gateway → bot-you-own → Logs** now shows one row
   per model call: the model, the tokens, the cost, how long it took.

![Gateway Logs tab showing the first calls](images/ai-gateway-4-logs.png)

**If the chip is still there** after a minute: the name doesn't match. Check for
a capital letter, a space, or a trailing character in the gateway name, then
compare it to `gateway.id` in `YourBots/config.js`. If you'd rather rename in
the config than in the dashboard, edit that one line and commit.

You never touch the Worker for any of this. Screenshots are in `docs/images/`;
if the dashboard has moved a button since they were taken, the labels above are
what to search for.

---

## 1b. Three secrets before the gate goes public

```bash
# the pepper behind every hash (device keys, connection, browser): random, never printed
printf "$(openssl rand -base64 32)" | npx wrangler secret put FOODLOG_PEPPER
# the admin second factor: a base32 secret you add to your authenticator app first
printf 'YOURBASE32SECRET' | npx wrangler secret put ADMIN_TOTP_SECRET
# the repo the deploy button and Commit to GitHub use — not in any file
printf 'you/your-repo' | npx wrangler secret put GITHUB_REPO
```

Check: Under the hood → Settings shows "Admin second factor: ON" and the repo
source as "GITHUB_REPO secret".

---

## 2. The GitHub token (Commit to GitHub from the Configure screen)

Why: with this token, the Configure screen's **Commit to GitHub** button writes a
bot's folder straight into the repo, which (with Workers Builds connected)
redeploys it. Without it, that button is disabled and you Export the files by hand.

1. GitHub → your avatar → **Settings → Developer settings → Fine-grained tokens →
   Generate new token**.
2. **Repository access → Only select repositories →** `JimTyrrell/bot-you-own`.
3. **Permissions → Repository permissions → Contents → Read and write**. Nothing
   else.
4. Generate, copy the `github_pat_…` value, then:
   ```bash
   printf 'github_pat_…' | CLOUDFLARE_ACCOUNT_ID=<your-account-id> npx wrangler secret put GITHUB_TOKEN
   ```

Check: on the live demo, **Configure** any bot — the **Commit to GitHub** button
is no longer greyed out.

---

## 3. GitHub repo secrets: BOT_URL and ADMIN_PASSPHRASE

Why: the workflow `.github/workflows/sync-library.yml` pushes documents from a
bot's `knowledge/` folder into AI Search on every commit. It needs to know the
Worker's URL and the admin code.

1. GitHub → the repo → **Settings → Secrets and variables → Actions → New
   repository secret**. Add two:
   - `BOT_URL` = `https://bot-you-own.<your-subdomain>.workers.dev`
   - `ADMIN_PASSPHRASE` = the admin code (the same value the Worker's
     `ADMIN_PASSPHRASE` secret holds — currently `under-the-hood-2026`).

Check: commit a `.md` file into any `YourBots/<bot>/knowledge/` folder; the
Action runs green, and **Under the hood → Files** lists the document.

---

## 4. Google sign-in client id (optional — a sign-in button on Plate)

Why: with a Google client id, Plate (and any food bot) shows a "Sign in with
Google" button that links a second device by proving the email. Without it, the
button simply doesn't render; email + device key and the authenticator code still
work. Microsoft and Apple are the same shape if you want them later.

1. `console.cloud.google.com` → create a project (any name).
2. **APIs & Services → OAuth consent screen** → External → fill in the app name
   and your support email.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID →
   Application type: Web application.**
4. **Authorized JavaScript origins** = `https://bot-you-own.<your-subdomain>.workers.dev`
   (add `http://localhost:8787` too if you want it in `wrangler dev`). No redirect
   URI is needed — the button uses an ID token, not a callback.
5. Copy the **Client ID** (ends in `.apps.googleusercontent.com`), then either:
   ```bash
   printf '…apps.googleusercontent.com' | CLOUDFLARE_ACCOUNT_ID=<your-account-id> npx wrangler secret put GOOGLE_CLIENT_ID
   ```
   (applies to every food bot), or put it per-bot in `project.json → food.signIn[]`.

Check: open `/apps/plate` in a fresh browser — the "Sign in with Google" button
appears on the join screen.

---

## 5. The admin's second factor (optional — a code on top of the admin login)

Why: with `ADMIN_TOTP_SECRET` set, opening "Under the hood" (and the coach page,
and `/api/admin/unlock`) asks for six digits from your authenticator app as well
as the admin code. Without it, the admin code alone opens the door.

1. In an authenticator app (Google Authenticator, 1Password, Authy) add a manual
   entry and let it generate a base32 secret, or make one yourself (16+ base32
   characters, A–Z and 2–7).
2. Put the **same** secret both in the app and in the Worker:
   ```bash
   printf 'YOURBASE32SECRET' | CLOUDFLARE_ACCOUNT_ID=<your-account-id> npx wrangler secret put ADMIN_TOTP_SECRET
   ```

Check: **Under the hood → Settings** shows "Admin second factor: on". The admin
login now has a second field for the six digits.

Related, no secret to create: to log every admin out at once (say you shared the
code and want it rotated), bump `ADMIN_TOKEN_VERSION`:
```bash
printf '2' | CLOUDFLARE_ACCOUNT_ID=<your-account-id> npx wrangler secret put ADMIN_TOKEN_VERSION
```

---

## 6. A custom domain (optional)

Why: serve the bot from `chat.yourdomain.com` instead of the `workers.dev` URL.

1. The domain must already be on Cloudflare (in this same account).
2. Dashboard → **Workers & Pages → bot-you-own → Settings → Domains & Routes →
   Add → Custom Domain** → e.g. `chat.designatic.com`. Pick a hostname with no
   existing record.

One warning, because it bites silently: **passkeys are tied to the hostname.** A
passkey made on `bot-you-own.<your-subdomain>.workers.dev` will not work on
`chat.designatic.com`, and vice versa. If anyone has already set up a passkey on
the current URL, they set it up again after the domain changes. Authenticator
codes and email + device key are unaffected. So add the domain **before** telling
people to make passkeys, if you can.

Check: `https://chat.yourdomain.com/health` returns `ok <version> …`.

---

## 7. The break-glass key (recommended before you set item 5)

Why: if the authenticator is lost, wiped or set up wrong, `ADMIN_TOTP_SECRET`
locks *you* out too. `ADMIN_UNLOCK_KEY` is the way back in: typed where the admin
code goes, it opens "Under the hood" with no code and no six digits, and takes you
straight to Settings to re-set the second factor.

1. Make a long random one and set it:
   ```bash
   printf "$(openssl rand -base64 24)" | CLOUDFLARE_ACCOUNT_ID=<your-account-id> npx wrangler secret put ADMIN_UNLOCK_KEY
   ```
   (Under 16 characters it is ignored.) Keep the value somewhere the authenticator
   isn't — a password manager entry, a printed card.
2. After you ever use it: re-set `ADMIN_TOTP_SECRET` (item 5), bump
   `ADMIN_TOKEN_VERSION`, and set a **new** `ADMIN_UNLOCK_KEY`.

Check: **Under the hood → Settings** shows "Break-glass key: SET". Every use lands
in the admin record there as `admin-break-glass`.

---

## 8. The allowlist key (only if a bot uses access mode `allow`)

Why: `allow` mode lets in the emails you list (Settings → The allowlist), per bot
or for every bot. The list is encrypted; this is its key. Without it the mode
refuses everyone.

1. ```bash
   printf "$(openssl rand -base64 32)" | CLOUDFLARE_ACCOUNT_ID=<your-account-id> npx wrangler secret put ALLOWLIST_KEY
   ```
2. Under the hood → Settings → The allowlist → add the first email.

Check: the Settings allowlist section says "ALLOWLIST_KEY is set", and the address
you added is listed back to you. Rotating the key empties the list (old hashes
stop matching) — add people again.

---

## Where each secret lives

| Secret | Set by | Switches on |
|---|---|---|
| `ACCESS_PASSPHRASE` | already set | the shared passphrase (key mode) |
| `ADMIN_PASSPHRASE` | already set | "Under the hood" and the coach page |
| `GITHUB_TOKEN` | item 2 | Commit to GitHub |
| `BOT_URL`, `ADMIN_PASSPHRASE` (GitHub repo secrets) | item 3 | the library sync Action |
| `GOOGLE_CLIENT_ID` (and MICROSOFT_/APPLE_) | item 4 | a sign-in button |
| `ADMIN_TOTP_SECRET` | item 5 | the admin's six-digit second factor |
| `FOODLOG_PEPPER` | already set | hashing food-log user ids (set before real use) |
| `ADMIN_UNLOCK_KEY` | item 7 | the break-glass way into Under the hood |
| `ALLOWLIST_KEY` | item 8 | the allowlist (access mode `allow`) |

`ACCESS_PASSPHRASE_<NAME>` (per-bot keys) are optional and only needed when a bot
names its own secret in `project.json → accessKey`.
