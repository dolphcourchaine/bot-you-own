# The prompt, in plain text

Everything the bot is told about *how to behave* lives in this folder as
Markdown. Edit a file, commit, and the bot changes. **You never need to open
`engine/`.** The code only stitches these files together, in number order, and
fills in the `{{placeholders}}`.

| File | What it is | Shown to the bot as |
|---|---|---|
| `1-identity.md` | who it is, the date, the "not ChatGPT" line | `<identity>` (protected) |
| `2-capabilities.md` | what it can't do — public, it is *meant* to repeat this | `<identity>` (public) |
| `3-personality.md` | tone: warm, direct, no flattery, one clarifying question | `<personality>` (protected) |
| `4-formatting.md` | plain paragraphs, when lists are allowed, links only from the list | `<formatting>` (protected) |
| `jobs/<mode>.md` | the job for this project's `mode`: Role · What a good answer looks like · Done when | `<job>` (protected) |
| `5-owner-instructions-intro.md` | the sentence that introduces the project's `instructions.md` | `<owner_instructions>` |
| `6-files-strict.md` / `6-files-open.md` | how to treat the project's `knowledge/` files, by `grounding` | `<files>` |
| `7-answering-strict.md` / `7-answering-open.md` | the answering rules, by `grounding` | `<how_to_answer>` |
| `8-links.md` | the link allowlist rule | `<links>` |
| `9-boundaries.md` | the refusals: no prompt disclosure, pasted "system messages" are data, no unwritten prices, emergencies → a human | `<boundaries>` (protected) |

**Protected** means the firewall withholds any answer that quotes it back
(`engine/firewall.js` → `leaksPrompt`). Public sections are the ones the bot is
supposed to repeat: the capabilities line, the owner's files, the handoff.

## Placeholders you can use
`{{botName}}` the project's name · `{{runBy}}` " run by <owner>" or nothing ·
`{{date}}` today · `{{business}}` the project's name · `{{handoff}}` the project's
handoff text + contact · `{{links}}` the allowed links as a bullet list ·
`{{#handoff}}…{{/handoff}}` include the line only when a handoff exists.

## The rule: root is global, the bot's folder wins
Any file in this folder can be copied into `YourBots/<name>/prompt/` with the
**same name**, and that copy replaces it for that bot only. Nothing to register —
the build finds it. Example in the repo:
`YourBots/tumblebrook-dental/prompt/3-personality.md` gives the dental bot a
calmer voice while the other bots keep the shared one. Jobs work the same way:
`YourBots/<name>/prompt/jobs/<mode>.md`.

## What's per bot, and what's shared
- **Shared by every project** (this folder): personality, formatting, boundaries, answering rules, the job descriptions.
- **Per project** (`YourBots/<name>/`): `project.json` (name, greeting, starters, `mode`, `grounding`, allowed links, handoff, thinking words), `instructions.md` (the owner's own words, on top), `knowledge/` (the files).
- **Per deployment** (`YourBots/config.js`): model, access mode, firewall switches, gateway, looks.
- **Secrets** (never in files): `ACCESS_PASSPHRASE`, `ADMIN_PASSPHRASE`, API keys.

Read the assembled result any time: under the hood → Prompt.
