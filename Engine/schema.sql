-- Optional audit log. See docs/CUSTOMIZE.md → "Read what your bot has been saying".
CREATE TABLE IF NOT EXISTS conversations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project    TEXT,
  visitor    TEXT,           -- email in email mode, 'admin', or empty
  asked      TEXT,
  answered   TEXT,
  refused    INTEGER DEFAULT 0,
  flags      TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_created ON conversations(created_at);
CREATE INDEX IF NOT EXISTS idx_conv_refused ON conversations(refused);

-- Existing table from an earlier version? Add the column:
-- ALTER TABLE conversations ADD COLUMN visitor TEXT;

-- What the document scan did (Configure → Documents; under the hood → Files).
-- One row per outcome. Created by the Worker on first use, like the table above.
CREATE TABLE IF NOT EXISTS library_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bot        TEXT,               -- which bot's library
  file       TEXT,               -- the document's name
  event      TEXT NOT NULL,      -- held | override | upload | remove | rescan-held
  detail     TEXT,               -- for held / rescan-held: JSON of what was found (labels, counts, masked samples)
  who        TEXT,               -- 'admin' (Configure) or 'github' (the sync action)
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_libev_bot ON library_events(bot, id);

-- Leads: one row per visitor email, with the stored AI summary (Engine/worker/leads.js).
-- The Worker creates this itself on first use; kept here for reading.
CREATE TABLE IF NOT EXISTS leads (
  visitor          TEXT PRIMARY KEY,   -- the email they gave (email mode); never "admin"
  bot              TEXT,               -- the bot of their latest turn when summarised
  summary          TEXT,               -- JSON: asked[], situation, cares_about[], objections[], next_step, score, reason
  score            INTEGER,            -- 0-100
  updated_at       TEXT NOT NULL,
  turns_at_summary INTEGER DEFAULT 0,  -- how many turns the summary covered (more since = stale)
  sent_at          TEXT                -- last time it was pushed to the webhook
);
CREATE INDEX IF NOT EXISTS idx_conv_visitor ON conversations(visitor, id);

-- Gaps: what the bot couldn't answer, as a to-do list (Engine/worker/gaps.js; under the hood → Audit).
-- One row per bot per normalised question. Counts are refreshed from conversations on
-- every read; state and draft are yours and are never overwritten by the refresh.
CREATE TABLE IF NOT EXISTS gaps (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  bot          TEXT NOT NULL,      -- the bot's id (YourBots/<id>)
  question_key TEXT NOT NULL,      -- the question, lowercased, punctuation stripped
  question     TEXT,               -- the newest wording a visitor used
  count_seen   INTEGER DEFAULT 0,  -- how many times it was refused in the window
  last_seen    TEXT,
  state        TEXT NOT NULL DEFAULT 'open',   -- open | drafted | accepted | dismissed
  draft        TEXT,               -- the FAQ entry (model draft, then whatever you accepted)
  grounded     INTEGER,            -- 1 = the files held the answer; 0 = template with blanks
  missing      TEXT,               -- JSON list of what the files didn't say
  file         TEXT,               -- the knowledge file it was added to
  updated_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gaps_bot_key ON gaps(bot, question_key);
-- Talk to a person (Engine/worker/person.js). One row per request; the thread lives
-- in handoff_messages. The id is 48 random hex characters and is the visitor's key.
-- The Worker creates these itself on first use; kept here for reading.
CREATE TABLE IF NOT EXISTS handoffs (
  id         TEXT PRIMARY KEY,   -- 48 hex chars; stored with the visitor's chat, sent in the webhook link
  bot        TEXT,               -- the bot's id (folder name)
  chat_id    TEXT,               -- the page's chat id; one open request per chat
  visitor    TEXT,               -- the email they gave at the door (email mode), 'admin', or empty
  transcript TEXT,               -- JSON: the last 8 turns before the button, redacted like conversations
  status     TEXT NOT NULL DEFAULT 'open',   -- open (waiting on you) | answered (waiting on them) | closed
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handoffs_status ON handoffs(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_handoffs_chat ON handoffs(bot, chat_id, status);
CREATE TABLE IF NOT EXISTS handoff_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,   -- the page polls with ?since=<id>
  handoff_id TEXT NOT NULL,
  from_role  TEXT NOT NULL,      -- visitor | owner
  text       TEXT NOT NULL,      -- NOT redacted: "call me on …" is the point of the thread
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hmsg_handoff ON handoff_messages(handoff_id, id);

-- Settings: one row per key. "access" holds { "default", "floor" }, "createYourOwn" the badge —
-- from under the hood → Settings. Merge order (Engine/worker/settings.js):
-- YourBots/config.js < YourBots/settings.json < these rows.
-- The Worker creates this itself on first use; kept here for reading.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,   -- 'access'
  json       TEXT NOT NULL,      -- the JSON for that key
  updated_at TEXT NOT NULL,
  updated_by TEXT                -- 'admin'
);

-- Admin events: what changed, and when. One row per admin write (a bot saved or
-- removed, settings changed, a commit, a document put in or taken out, a reply to
-- a visitor, a lead sent). ip_hash is a SHA-256 of the caller's IP — the IP itself is never stored.
CREATE TABLE IF NOT EXISTS admin_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  action     TEXT NOT NULL,      -- project-save | project-delete | project-commit | settings-save | settings-commit | gap-accept | library-upload | library-delete | library-rescan | handoff-reply | handoff-close | lead-send
                                 -- …and the access ones (v3.11): access-grant | access-extend | access-shorten | access-unlimited | access-key-date | allowlist-add | allowlist-remove | device-link | view-as
  target     TEXT,               -- the bot id, the file, the conversation id…
  detail     TEXT,               -- one line of what happened, e.g. "2026-03-01 → 2026-06-01"
  who        TEXT,               -- 'admin'
  ip_hash    TEXT,               -- SHA-256 hex of the IP address
  created_at TEXT NOT NULL,
  subject    TEXT                -- WHO it was about (an email), when the event is about a person.
                                 -- This is what makes the per-person timeline one indexed read:
                                 -- Under the hood → Settings → Access over time.
);
CREATE INDEX IF NOT EXISTS idx_adminev_created ON admin_events(id);
CREATE INDEX IF NOT EXISTS idx_adminev_subject ON admin_events(subject, id);

-- The allowlist (Engine/worker/allowlist.js; access mode "allow"). Encrypted at rest: a keyed
-- hash (HMAC-SHA256, the blind index) to check one address, and the address under AES-256-GCM
-- so the owner can read the list. Both keys derive from the ALLOWLIST_KEY secret. scope is a
-- bot id, or '*' for every bot.
CREATE TABLE IF NOT EXISTS allowlist (
  scope      TEXT NOT NULL,
  email_hmac TEXT NOT NULL,        -- HMAC(email) hex — never the email
  email_enc  TEXT NOT NULL,        -- base64(iv).base64(ciphertext)
  added_at   TEXT NOT NULL,
  added_by   TEXT,                 -- 'admin'
  expires_at TEXT,                 -- when the INVITATION runs out. NULL = unlimited (Engine/worker/expiry.js)
  PRIMARY KEY (scope, email_hmac)
);

-- History on any computer (Engine/worker/chats.js; docs/IDENTITY.md → "History on any computer").
-- An identified visitor's own threads, FULL text — separate from `conversations`, which stays
-- redacted for the owner's Audit/Leads views. Readable with their device key, or by the admin
-- read-only ("see what they see").
CREATE TABLE IF NOT EXISTS chat_threads (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bot        TEXT NOT NULL,
  user_id    TEXT NOT NULL,        -- id_users.id
  client_id  TEXT NOT NULL,        -- the page's own chat id
  title      TEXT,
  meta       TEXT,                 -- JSON: { handoff, attachments }
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_threads_owner ON chat_threads(bot, user_id, client_id);
CREATE TABLE IF NOT EXISTS chat_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  INTEGER NOT NULL,
  role       TEXT NOT NULL,        -- user | assistant | person
  content    TEXT NOT NULL,        -- raw, not redacted
  meta       TEXT,                 -- JSON: { flags, sources, note, talk, toPerson }
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id, id);

-- Identity (Engine/identity/; docs/IDENTITY.md). Shared by every kind of bot; every
-- table has a `bot` column. Created by the Worker on first use.
CREATE TABLE IF NOT EXISTS id_users (
  id         TEXT PRIMARY KEY,     -- sha256(lowercased email + FOODLOG_PEPPER + bot id)
  bot        TEXT NOT NULL,
  email      TEXT NOT NULL,        -- the only personal thing stored
  created_at TEXT NOT NULL,
  last_seen  TEXT,                 -- bumped on every identified request; the return window measures from here
  access_until TEXT,               -- when THIS PERSON's access runs out. NULL = unlimited.
  -- The sign-up gate (v3.12, Engine/identity/index.js → join). Added by ensureIdentitySchema
  -- when missing. The consent record is consent_text: the exact words next to the boxes.
  name TEXT, phone TEXT,           -- phone as +digits (E.164-ish); NULL when not asked or not given
  marketing INTEGER, sms INTEGER,  -- the two opt-in boxes, 1/0
  consented_at TEXT, consent_text TEXT,
  ip_hash TEXT, ua_hash TEXT, fp_hash TEXT,   -- keyed SHA-256 prefixes: connection, browser, device facts
  source TEXT                      -- the referring host, or "direct"
                                   -- Engine/worker/expiry.js; set from Under the hood → Settings.
                                   -- expiry.defaultDays gives a window without writing a date here.
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_id_users_bot_email ON id_users(bot, email);
CREATE TABLE IF NOT EXISTS id_devices (
  key_hash   TEXT NOT NULL,        -- sha256 of the browser's random device key; the key itself never leaves the browser
  bot        TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  label      TEXT,                 -- 'first device' | 'return window' | 'linked with a passkey' | 'signed in with google' | 'linked with an authenticator code' | 'linked by the owner'
  created_at TEXT NOT NULL,
  PRIMARY KEY (key_hash, bot)
);
CREATE INDEX IF NOT EXISTS idx_id_devices_user ON id_devices(user_id);
CREATE TABLE IF NOT EXISTS id_pending (
  code       TEXT PRIMARY KEY,     -- the 6-character code a second device shows
  bot        TEXT NOT NULL,
  key_hash   TEXT NOT NULL,        -- that device's key hash, bound when someone links it
  email      TEXT NOT NULL,
  created_at TEXT NOT NULL         -- codes expire after 7 days
);
CREATE TABLE IF NOT EXISTS id_passkeys (
  credential_id TEXT PRIMARY KEY,  -- base64url, what the browser calls credential.id
  bot           TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  public_key    TEXT NOT NULL,     -- JWK (EC P-256 or RSA)
  alg           TEXT NOT NULL,     -- ES256 | RS256
  counter       INTEGER DEFAULT 0, -- must go up on every login; a clone is refused
  label         TEXT,
  created_at    TEXT NOT NULL,
  last_used     TEXT
);
CREATE INDEX IF NOT EXISTS idx_id_passkeys_user ON id_passkeys(user_id);
CREATE TABLE IF NOT EXISTS id_challenges (
  challenge  TEXT PRIMARY KEY,     -- what we asked the browser to sign; 5 minutes; used once
  bot        TEXT NOT NULL,
  kind       TEXT NOT NULL,        -- register | login
  user_id    TEXT,
  key_hash   TEXT,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS id_totp (
  user_id    TEXT PRIMARY KEY,
  bot        TEXT NOT NULL,
  secret     TEXT NOT NULL,        -- base32, 20 random bytes
  confirmed  INTEGER DEFAULT 0,    -- 1 once a right code was typed
  created_at TEXT NOT NULL
);

-- The food log (Engine/worker/track.js; docs/FOOD-LOG.md). The food side of a person:
-- who they are is id_users above. Created by the Worker on first use.
-- (track_devices / track_pending from v3.6 are no longer used; drop them when convenient.)
CREATE TABLE IF NOT EXISTS track_users (
  id           TEXT PRIMARY KEY,   -- = id_users.id
  email        TEXT,               -- unused since v3.7 (kept so older databases still fit)
  targets_json TEXT,               -- {kcal, protein_g, carbs_g, fat_g, unit, name, preset, weight_kg}
  created_at   TEXT NOT NULL,
  last_seen    TEXT
);
CREATE TABLE IF NOT EXISTS track_meals (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  date       TEXT NOT NULL,        -- YYYY-MM-DD, the phone's own day
  time       TEXT,                 -- HH:MM UTC
  items_json TEXT NOT NULL,        -- [{name, portion, grams, kcal, protein_g, carbs_g, fat_g, confidence, source, mult, per100?}]
  kcal REAL, protein_g REAL, carbs_g REAL, fat_g REAL,
  thumb      TEXT,                 -- data: URI, ≤256 px, ≤48 KB. The photo itself is never kept
  source     TEXT,                 -- photo | text | barcode | label | receipt
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_track_meals_day ON track_meals(user_id, date);
CREATE TABLE IF NOT EXISTS track_usage (user_id TEXT NOT NULL, date TEXT NOT NULL, photos INTEGER DEFAULT 0, PRIMARY KEY (user_id, date));   -- the daily photo cap
CREATE TABLE IF NOT EXISTS track_products (code TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at TEXT NOT NULL);   -- barcode lookups (Open Food Facts) and read labels ("label:<slug>")
CREATE TABLE IF NOT EXISTS track_receipts (
  id TEXT PRIMARY KEY, household_id TEXT, user_id TEXT NOT NULL,   -- household_id set = shared with the household
  store TEXT, date TEXT, total REAL, currency TEXT, items_json TEXT, thumb TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_track_receipts_h ON track_receipts(household_id, date);
CREATE TABLE IF NOT EXISTS track_weights (user_id TEXT NOT NULL, date TEXT NOT NULL, kg REAL NOT NULL, PRIMARY KEY (user_id, date));   -- always kg; the unit is the person's choice on the page
-- v3.10 — the day as a conversation (Engine/worker/track-day.js; docs/FOOD-LOG.md).
CREATE TABLE IF NOT EXISTS track_day_chat (       -- the words of a day; meals themselves stay in track_meals and are merged by time
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  date       TEXT NOT NULL,
  role       TEXT NOT NULL,        -- user | assistant
  kind       TEXT NOT NULL,        -- reaction (code-written, points at a meal) | question | answer
  text       TEXT NOT NULL,
  meal_id    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_track_day_chat ON track_day_chat(user_id, date, id);
CREATE TABLE IF NOT EXISTS track_summaries (      -- the written day / week, cached under a hash of what it summarised
  user_id    TEXT NOT NULL,
  date       TEXT NOT NULL,        -- the day, or the week's last day
  kind       TEXT NOT NULL,        -- day | week
  json       TEXT NOT NULL,
  hash       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, date, kind)
);
CREATE TABLE IF NOT EXISTS track_favourites (     -- every distinct meal a person has logged, and the name they gave it
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  key        TEXT NOT NULL,        -- the sorted food names
  name       TEXT,                 -- "work lunch"
  items_json TEXT NOT NULL,
  kcal REAL, protein_g REAL, carbs_g REAL, fat_g REAL,
  thumb      TEXT,
  hours      TEXT,                 -- local hours it was logged at (last 20), for "your morning staples"
  times_used INTEGER DEFAULT 1,
  last_used  TEXT,
  name_asked INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_track_fav_key ON track_favourites(user_id, key);
CREATE TABLE IF NOT EXISTS track_households (id TEXT PRIMARY KEY, name TEXT, code TEXT UNIQUE, created_at TEXT NOT NULL);   -- code = the 6-character invite
CREATE TABLE IF NOT EXISTS track_members (household_id TEXT NOT NULL, user_id TEXT PRIMARY KEY, name TEXT, joined_at TEXT NOT NULL);   -- one household per person
CREATE INDEX IF NOT EXISTS idx_track_members_h ON track_members(household_id);

-- An end date on a PASSPHRASE (Engine/worker/expiry.js). One row per ACCESS_PASSPHRASE*
-- secret you want to time-box — the shared one, or a per-bot one like ACCESS_PASSPHRASE_CLIENTX.
-- The row governs nothing on its own: the secret does the letting in, this says until when.
-- A row whose secret is no longer set is shown as an orphan in Settings rather than hidden.
CREATE TABLE IF NOT EXISTS access_keys (
  name       TEXT PRIMARY KEY,   -- ACCESS_PASSPHRASE, or ACCESS_PASSPHRASE_<SOMETHING>
  expires_at TEXT,               -- NULL = unlimited
  note       TEXT,               -- "Acme demo, paid to March"
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT                -- 'admin'
);
