# The food log · `/apps/plate` (a bot of kind `food`)

A photo food log a coach deploys for their clients. Not a chat bot: a page with a
camera button. Snap the plate → the model names the foods and guesses the numbers →
fix the portion with a tap → the day is a ring and three bars. It also reads barcodes,
nutrition labels and receipts, takes weigh-ins, and lets a household share.

It lives inside this Worker. Nothing extra to deploy. Since v3.7 it is **a bot
folder like any other**: `YourBots/plate/project.json` with `"kind": "food"` and
its settings in a `"food": { … }` block (model, photo limits, coach name, sign-in
methods). Common fields — name, tagline, greeting, `access`, `listed` — are the same
as a chat bot's. Delete the folder and it's gone; copy it to `YourBots/plate-two/`
and you have a second, separate food log (its own people, its own coach view).

Where it answers: `/apps/<id>` (the app), `/apps/<id>/coach` (the coach),
`/api/apps/<id>/…` and `/api/admin/apps/<id>/…`. **For one release** `/apps/plate`,
`/apps/plate/coach`, `/api/apps/plate/…` and `/api/admin/apps/plate/…` still reach the bot whose id
is `plate`. A `foodLog` block left in `YourBots/config.js` is still honoured as a
deprecated fallback (it becomes the bot `plate`, with a warning in the logs).
The sidebar lists it with a camera icon; the Configure screen edits it (kind →
food log) like any bot; Export / Commit to GitHub write `project.json`.

![the day screen](food-log.png)

## For the coach: how to deploy it

1. Deploy the bot as usual (`docs/DEPLOY.md`). The food log is already in.
2. Set the pepper — once, before real people use it:
   `npx wrangler secret put FOODLOG_PEPPER` (any long random string; it salts the
   user ids so an email can't be turned into an id from outside). Until it's set the
   log warns and uses a dev value.
3. Put your name in `project.json → food.coachName` so the page says "Your coach: …" (or Configure → the food log settings).
4. Send clients to `https://YOUR-BOT-URL/apps/plate`. Their phone. That's it.
5. You look at `https://YOUR-BOT-URL/apps/plate/coach` with the admin code (the
   `ADMIN_PASSPHRASE`, same one as "Under the hood"): every client, targets, streak,
   last log, 7-day adherence, weight trend, household; click for their week; **Export
   CSV**; link a second device.

## What a client sees

- **First visit:** type an email once. A one-line privacy note. Then targets:
  weight + goal → **Cut / Maintain / Build** fills the numbers, or type your own.
  The preset: maintenance ≈ 33 kcal/kg (the common 15 kcal/lb rule of thumb),
  cut = −500, build = +300; protein 2.0 g/kg (cut) or 1.8 g/kg (in the range the
  Morton 2018 meta-analysis found useful, 1.6–2.2 g/kg); fat 25% of calories;
  carbs the remainder. It's a starting point; the coach adjusts.
- **Three tabs, one date (v3.10):** **Chat · Day · Week**, with the yesterday /
  tomorrow arrows under all three. The tab is the lens; the date is the subject.
- **Chat — the day is a conversation.** A small ring and the three numbers pinned
  at the top; below it, every meal as a card (tap to edit, ✕ to delete) with a
  one-line reaction written by code, never the model: *Logged. 640 kcal · 1,360
  left today · protein 45 of 150.* You can also **talk to the day**: "was lunch
  too much?", "what should dinner be to hit protein?" — the coach bot answers from
  the day's own numbers (it is handed the totals as facts and may not invent any;
  no medical advice; pain, fainting or an eating disorder get "one for your coach").
  On a new day the first thing you see is **yesterday's summary**, one line, tap for
  the rest.
- **Day — the numbers and the words.** The big ring, the three bars, the meals, and
  a written review: what you ate, where it landed against the targets, one thing
  that went well, one thing for tomorrow (or "the rest of today"). One small model
  call, **cached under a hash of the meals**, so it is only rewritten when the food
  changed. A day with nothing logged says so; nothing is made up. ↻ writes it again.
- **Week — the patterns.** The 7-day strip, a row per day, the weight trend, and a
  seven-day look-back that reads the days rather than the meals: average against
  target across logged days, which days were off and what they had in common,
  how many days hit protein, the weight trend, one change for next week.
- **Repeats — because people eat the same things.** Every saved meal becomes a
  **favourite** (keyed on its foods): a chip above the composer, the ones you eat
  around this hour first — marked *usually now* once you have had it then twice. A
  tap puts it in the box; send logs it (nothing is logged by a tap alone). A chip
  you have not tapped today breathes; a used one goes quiet. **⟲ Same as yesterday** (and
  *same as last Tuesday* when there was one) copies a whole day, then you delete
  the one that differs. Typing or saying **"chicken rice again"** or **"log my work
  lunch"** matches a favourite *before* any model runs — "Logging your chicken, rice
  and broccoli from Tuesday, about 640 kcal. Right?" with Yes / ½× / Adjust first /
  No, estimate fresh. After the third time the coach asks once for a name; every
  fifth repeat opens the editor with "still about this much?" so a staple never
  quietly drifts. ★ Staples lists them all: log, half, rename, forget.
- **Times keep their place.** Every meal stores the clock where it was eaten and the
  zone's name; seen later from another zone it reads *12:00 EDT*, not the local hour.
  Tap a meal → **Eaten at** to move it; the favourite's "usually now" hours follow.
- **Planned meals.** The date arrow opens the next two weeks. Anything logged on a day
  after today is a **plan**: drawn hollow, counted against that day's budget, never as
  eaten — so "dinner out, about 1,200" on Thursday lowers what Thursday's breakfast is told
  it has. Nothing planned touches the streak, the week's averages, the favourites or the
  coach's export until you tap **Had it**, which logs it as eaten at that moment. A meal
  on today can be marked planned in the editor (Eaten / Planned).
- **What fits.** Before you save, the editor sets the plate against what is left today:
  *Fits*, or *about three quarters fits* with one tap that scales every item (grams and
  ounces, to what a scale shows), or *leave the rice* when dropping the item worth the
  least protein gets you under. Written by code from the day's numbers, no model call.
- **One composer.** *Say what you ate, or ask…* takes both. The mic records a clip
  (press, talk, press again, 30 s at most) and sends it to **Whisper on Workers AI**
  through the app's own `transcribe` route — never the browser's speech service, so
  nothing goes to Google or Apple. The words are sent as if typed, so "eggs and toast
  again" out loud is the whole log. The matcher forgives one letter in words of five
  or more ("launch" for "lunch"). Model: `YourBots/config.js → voice.sttModel`, else
  `@cf/openai/whisper-large-v3-turbo` (about $0.0005 a minute of audio).
- **Snap a plate:** the big green button opens the camera. The photo is shrunk in
  the browser to ≤ 1024 px before upload (a 12 MP photo never goes over the wire).
  Sideways or upside-down photos are straightened first, by landmark: a kitchen
  scale's display sits at the bottom, a Nutrition Facts heading at the top of its
  panel. Photos with neither (a barcode alone, the front of a can, a plate) are left
  as they are — asked outright, no model on Workers AI can tell which way a photo is
  turned, so the app never guesses. ↻ on a photo turns it by hand — in the box before
  sending, or on a saved photo in the viewer (the original is kept as `<i>-orig.jpg`,
  and a photo turned by hand is never turned again automatically). A second opinion,
  Clef (`@cf/cloudflare/clef`, a decision model that returns a probability per
  answer), runs in shadow when `ORIENT_CLEF=shadow`: it is asked where the top of
  the thing points, its verdict is logged next to what the page did
  (`track_orient_log`), and nothing changes until `ORIENT_CLEF=live` — then it acts
  only where the landmarks had no say, and only at ≥ 0.8. `npm run deploy:photos`
  sets shadow; `Engine/tests/orient-eval.py` measures it on a folder of photos and
  `Engine/tests/orient-report.mjs` reads the shadow log
  (Engine/worker/track-orient.js has the rules).
  While the photos are read, a card fills in: each photo is looked at on its own at
  once (`POST peek`, one streamed line of JSON per food the moment the model writes
  it, in parallel across photos), so the first foods show in about a second and a
  full plate in two or three — the same label photographed three times is one food.
  The full read of all the photos together then settles the card (numbers count to
  the real ones) and is the one that is saved.
  Back comes the list of foods; a weight field (⚖️, grams or ounces, with the
  eighths a kitchen scale shows), **"Wrong food?"** → type "that's chicken, not
  pork" → it looks again with your correction; Save. Under it, always: *Photo estimates are typically within about
  30%. Fix the portion when it's off.*
- **Type it:** "2 eggs and toast" → same list, same buttons.
- **Barcode:** Chrome/Android read the code in the browser (`BarcodeDetector`);
  other browsers send the photo and the model reads the digits. The check digit is
  verified in code, then Open Food Facts (free, no key) gives per-100 g numbers →
  "how much did you have?" — 1 serving, the whole pack, or grams/servings.
  Lookups are cached 90 days in D1. Not in the database → "snap the label instead".
- **Label:** a photo of a nutrition-facts panel → serving size, servings per pack,
  kcal/protein/carbs/fat/fibre/sugar/sodium per serving → same "how much?" step.
  The label is remembered; the same label next time offers "use last time's".
- **Receipt:** a photo → store, date, total, the items. A **Receipts** screen with
  this-week / this-month totals and "+ today" on any item (goes through the
  text estimate). Receipts belong to the household when you're in one.
- **Weigh in:** kg or lb (remembered). A 30-day line and 7-day average on the day
  screen; the coach sees the trend.
- **Household:** create one → a 6-character invite code → your spouse enters it.
  You see each other's days (read-only, with a name), one receipts list, both weight
  trends. Everyone keeps their **own** targets and meals; you cannot edit theirs
  (the server says 403). Leave from the settings screen.

## Identity, in plain English

The whole of it is `docs/IDENTITY.md`; the short version:

- Your **email is your log**. The browser makes a random **device key**, keeps it
  in localStorage, sends it with every request; the server keeps only its hash. No
  password. "Remembered forever on this browser" — until *Forget me*.
- The user id is `SHA-256(email + FOODLOG_PEPPER + bot id)` — two food logs on one
  deployment are two different people even with the same email.
- **A second browser typing the same email does not get the log.** It shows a
  6-character code and, in this order: **Use a passkey** · **Sign in with
  Google/Microsoft/Apple** (if set up) · **type your authenticator code** · or the
  coach links it from `/apps/plate/coach` (email + code; `POST
  /api/admin/apps/plate/link {email, deviceCode}`; codes expire in 7 days).
- Once in, the *This device* card offers **Set up a passkey** and **Set up an
  authenticator app** so the next device needs nobody's help.
- The device key check **fails closed** (bad key = 401). Features **fail open**.
- Household reads are checked server-side on every call: `GET …/day?user=X` is
  allowed only when X shares your household.

## "Sign in with …" (optional)

A provider's own button gives the browser a signed ID token (a JWT). The browser
posts it to `POST /api/apps/plate/signin {provider, idToken}` with its device key; the
Worker (`Engine/identity/idtoken.js`) fetches the provider's published public
keys (JWKS, cached an hour), checks the **RS256 signature**, the **issuer**, the
**audience** (= your client id), the **expiry**, and that the email is **verified**.
Only then is the device linked. No client secret, no redirect, no callback route.

Each button appears only when it has a client id — `project.json → food.signIn[].clientId`
or the secret `GOOGLE_CLIENT_ID` / `MICROSOFT_CLIENT_ID` / `APPLE_CLIENT_ID`.
No ids = no buttons; the coach code still links devices.

**Google** (free):
1. console.cloud.google.com → create a project (any name).
2. APIs & Services → **OAuth consent screen** → External → app name + support
   email (yours) → no extra scopes → save. Set the publishing status to
   **In production** — the basic `openid email` scopes need no verification. No logo
   (a logo triggers verification).
3. APIs & Services → **Credentials** → Create credentials → **OAuth client ID** →
   Application type **Web application** → **Authorized JavaScript origins** = your
   bot's origin (`https://bot-you-own.you.workers.dev`, and `http://localhost:8798`
   for dev). No redirect URI is needed for the button.
4. Copy the **Client ID** (ends in `.apps.googleusercontent.com`) →
   `npx wrangler secret put GOOGLE_CLIENT_ID`.

**Microsoft** (free): entra.microsoft.com → Identity → Applications → **App
registrations** → New → name it → Supported account types: **Accounts in any
organizational directory and personal Microsoft accounts** → Redirect URI: platform
**Single-page application**, value = your bot origin + `/apps/plate/` → Register → copy
the **Application (client) ID** → `npx wrangler secret put MICROSOFT_CLIENT_ID`.

**Apple**: needs the **paid** Apple Developer account ($99/yr). Certificates, IDs &
Profiles → Identifiers → a **Services ID** with Sign in with Apple enabled, your
domain and `https://YOUR-BOT/apps/plate/` as the return URL; the Services ID is the
client id → `npx wrangler secret put APPLE_CLIENT_ID`.

Facebook is not included: Facebook Login returns an access token, not an OpenID
ID token, so verifying it needs a Graph API call — a different mechanism.

The verifier is unit-tested without any provider: `node Engine/tests/identity.mjs`
signs tokens with a throwaway RSA key against a local fake JWKS and checks that a
good token passes and wrong audience, expired, bad signature, wrong issuer,
unverified email, tampered payload and `alg: none` are all refused (16/16).
**The real buttons have not been clicked in a live deployment** — that needs real
client ids.

## The model — chosen by testing, not by assumption

Five public-domain plates (Wikimedia Commons: carbonara, cheeseburger and fries,
Caesar salad, oatmeal, a pizza slice), the same JSON prompt, every vision model in
the Workers AI catalogue that would take an image, Sept 2026:

| Model | Valid JSON | Foods named | Calories plausible | Time / photo | Verdict |
|---|---|---|---|---|---|
| `@cf/google/gemma-4-26b-a4b-it` (thinking off) | 5/5 | 5/5 — burger **and** fries, carbonara, Caesar salad + dressing, oats, pizza + toppings | 5/5 (burger+fries 1,270; carbonara 580; salad 645; oats 340; pizza 400) | 2–5 s | **chosen** |
| `@cf/meta/llama-3.2-11b-vision-instruct` | 5/5 | 2/5 — missed the burger ("fries, 700 g, 3,500 kcal"), pizza → "cheese, 5 g", salad → "lettuce" | 2/5 | 2–4 s | no |
| `@cf/llava-hf/llava-1.5-7b-hf` | 5/5 after repair (`protein\_g`, carbs as strings) | 4/5 generic ("Pasta", "Salad") | zeros for macros in 3/5 | 5–10 s | no |
| `@cf/qwen/qwen3.8-27b` | 0/5 | — | — | 59 s, ran out of tokens reasoning | no |
| `@cf/moondream/moondream3.1-9B-A2B` | 0/5 | — | — | returned `{}` for every input shape tried (base64 data URI, image_url, task/query, caption) | no |
| Gemma 4 with thinking **on** | 1/5 | — | — | 10–20 s, reasoning ate the token budget | no |

The same model, thinking off, then read a **nutrition label** (the FDA's 2014 sample:
2/3 cup (55 g), 8 servings, 230 kcal, 8 g fat, 37 g carbs, 4 g fibre, 1 g sugar,
3 g protein, 160 mg sodium — every number right), a **real Austrian supermarket
receipt** (Hofer, 2024-03-25, EUR 22.41, 9 items), a **rendered receipt** (8 items,
total 36.12, all correct) and an **EAN-13 barcode** (5449000000996, every digit).

Input shape: OpenAI-style `messages` with an `image_url` data URI (base64). Thinking
is switched off with `chat_template_kwargs: { enable_thinking: false }`.

**Cost** (developers.cloudflare.com/workers-ai/platform/pricing): Gemma 4 is $0.10
per M input and $0.30 per M output tokens. A plate photo was 380–680 tokens and
6–12 neurons in testing — about **$0.0001 a photo**. The free 10,000 neurons a day
cover roughly a thousand photos. `food.dailyPhotoLimit` (default 60 photo reads per person; one read can carry up to 6 photos of one meal)
is the ceiling.

## Privacy

- Photos are read once and **not kept**. The page also makes a ≤ 256 px thumbnail;
  the server checks its size from the image header and stores at most 48 KB of it,
  or nothing. Nothing goes to R2.
- The email is stored (it is the identity). Meals, targets, weights, receipts and
  household membership are stored in D1. Barcode products are cached.
- Delete a meal, a receipt, or leave a household from the page. A coach can look at
  everything; nobody else can.

## What it doesn't do

- It is **not medical advice** and not a substitute for a dietitian. Estimates are
  estimates: a plate photo is typically within about 30%, and the person is told so.
- It doesn't count micronutrients, water, or exercise.
- It doesn't send email. Ever. (Owner's rule for this whole repo.)
- It doesn't sync between browsers by itself — that's the point of the identity
  model; linking is the coach's tap, a sign-in, or the return window
  (`docs/IDENTITY.md`).
- The coach bot in the chat answers from your log; it never estimates a food
  itself (the photo/text estimate does that) and never gives medical advice.

## Under the hood

`Engine/worker/track.js` (routes, meals, day/week, coach) · `track-vision.js`
(the model, prompts, JSON checks, barcode check digit, image header sizes) ·
`track-extras.js` (barcodes, labels, receipts, weights, households) ·
`track-day.js` (v3.10: the day's chat, the code-written reactions, favourites and
the matcher, repeats, the two summaries and their cache, "say") · `track-common.js`.
Routes for v3.10: `chat`, `say`, `favourites`, `repeat`, `favourite/name`,
`favourite/<id>`, `summary`; coach `client/<id>/summary`. Tables `track_day_chat`,
`track_summaries`, `track_favourites`. Summaries and answers go through
`Engine/worker/gateway.js` with the deployment's chat model (gpt-oss needs a
token budget of ~1,400 for a summary: it thinks before it writes). Proof:
`node Engine/tests/plate-day.mjs --url … --admin …` (34 checks, ~150 neurons). Who a person is: `Engine/identity/` (`docs/IDENTITY.md`).
The bot's settings are normalised by `Engine/worker/projects.js` → `normaliseFood`.
Tables are in `Engine/schema.sql` (`id_*`, `track_*`), created on first use.
Upgrading from v3.6: people re-join once (ids now include the bot id; the old
`track_devices` / `track_pending` tables are left alone and can be dropped).
Pages: `Engine/public/food/index.html` (the app) and `coach.html`.
