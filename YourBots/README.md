# YourBots — this folder is your bots

**Two ways to make one.** In the browser: admin code → ✎ Configure / ✎ New bot
(ChatGPT's builder form, with a live preview; Save makes it live, Export gives you
these files). Or in files, as below. A saved copy and a folder with the same name:
the saved copy wins until you remove it.

A **project** is exactly what ChatGPT calls a Project (and what a custom GPT was):
a set of **instructions**, some **files**, and a few **starter prompts**. One folder each.

```
YourBots/
  your-project/
    project.json       ← name, greeting, starters, which job it does, the links it may share
    instructions.md    ← what you'd have typed into the Instructions box in ChatGPT
    knowledge/         ← what you'd have uploaded as files (Markdown / plain text)
      about.md
      faq.md
      pricing.md
    prompt/            ← optional: a copy of any root prompt/ file, for this bot only (root = global, here = this bot)
  index.js             ← GENERATED at build from the folders above. Never edit.
```

**Everything your bot knows is in `knowledge/`. In `strict` mode it is not allowed
to say anything that isn't.** How every bot *behaves* (tone, refusals, the jobs)
lives one folder up in `YourBots/_prompt/` — also plain Markdown. In `open` mode it behaves like ChatGPT and uses the
files as its first source.

## Make your own (five minutes, no code)
1. **Copy the `_template` folder** and rename it, e.g. `my-shop`. (GitHub: open
   `_template`, use "Add file" to create `my-shop/project.json` and paste; or do it
   on your computer and upload the folder.)
2. Fill in `project.json`: the name, the greeting, `mode`, `grounding`, the links
   it may share, where to send people when it can't help, and `order` (its place
   in the sidebar; lowest first). Also who can use it: `access` (`open` · `email` ·
   `key` · `key+email` · `admin` · `draft`, or leave it out for the deployment
   default), `listed` (`false` = not in the sidebar, still works by link) and
   `accessKey` (the name of its own passphrase secret, optional). `docs/CUSTOMIZE.md → Who can use it`.
3. Paste your instructions into `instructions.md` — raw, don't tidy them.
4. **Drop your material into `knowledge/`.** Markdown, `.txt` or `.csv`. Any number
   of files. The best material is the emails you've already written answering the
   same question for the tenth time.
5. Set `defaultProject: "my-shop"` in `YourBots/config.js`. Commit.

That's the whole job. Nothing else registers it: the build finds every folder in
`YourBots/`, every file in its `knowledge/`, and every override in its `YourBots/_prompt/`.

**Adding more data later** = drop another file into `knowledge/` and commit.

**PDFs, Word files, spreadsheets, transcripts, screenshots** go in the same
`knowledge/` folder (or `knowledge/library/` for long text you don't want in the
prompt). They aren't bundled: the *Sync library* GitHub Action sends them to the
bot's library in Cloudflare AI Search, and the bot pulls the relevant passages
per question. Every file is scanned for things that shouldn't be public first;
a held-back file is approved by listing it in `knowledge/APPROVED.txt`. Or skip
GitHub and drop them into Configure → Documents. `docs/CUSTOMIZE.md → Give it documents`.

**Giving one bot its own voice** = copy a file from the root `YourBots/_prompt/` folder into
`YourBots/my-shop/prompt/` with the same name and edit it. Root is global, the
bot's folder wins. Jobs cascade the same way: `YourBots/my-shop/prompt/jobs/answer.md`.

## The samples
| Folder | Job | Grounding | What it's testing |
|---|---|---|---|
| `general` | a ChatGPT-style general assistant | `open` | the "clone": tone, formatting, honesty about no tools |
| `example-co` | answer bot for a machine-servicing firm | `strict` | the workshop's Hire #1. Handoff instead of guessing |
| `tumblebrook-dental` | intake bot for a dental practice | `strict` | one question at a time, emergency routing, no invented prices |
| `ledgerly-support` | concierge for a bookkeeping SaaS | `strict` | refund/discount traps, answer-before-pitch, link allowlist |

Delete the sample folders you don't need before you go live (or leave them and
set `singleProject: true` in `YourBots/config.js` so customers see only yours).

⚠️ **Don't put anything in `knowledge/` you wouldn't put on your website.** Assume
every word can be read by anyone who talks to the bot. Ownership changes who
controls it; it doesn't make text unreadable.
