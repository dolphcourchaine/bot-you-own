# Bring your ChatGPT Project or custom GPT across

You built something in ChatGPT. It works. Then OpenAI announced it is retiring
custom GPTs — their word, on their own help page. **On a personal account (Free, Go,
Plus, Pro) you already can't create a new one.** And if you accept the migration
they're offering, the original becomes read-only.

This takes what you built and puts it somewhere you own. **About twenty minutes.**

## The fast way: the Configure screen
Open your bot with the admin code → **✎ New bot**. It's the same form as ChatGPT's
builder: paste the Instructions, paste or upload the files, add the starters, try
it in the Preview, press Save. Done, and live. Press **Export files** when you want
the folder version in GitHub. The five steps below are the file-based route.

## The five steps
1. **Copy the Instructions.** ChatGPT → your GPT (Edit → Configure) or your
   Project (Project settings → Instructions). Select all, copy. Paste into
   `YourBots/my-project/instructions.md` **raw**. Don't tidy it. Whatever quirks
   made it work will survive the move; "improving" it is how people break a GPT
   that was fine.
2. **Bring the files.** Each file you uploaded becomes a file in
   `YourBots/my-project/knowledge/`. Text, Markdown, CSV: paste. PDFs and Word:
   copy the text out (fine for a handful) or use Cloudflare AI Search for the
   real thing — `docs/CUSTOMIZE.md`.
3. **Bring the conversation starters** into `project.json` → `starters`.
4. **Flip the switch:** `"mode": "imported"` in `project.json`, register the folder
   in `YourBots/index.js`, set it as `defaultProject` in `YourBots/config.js`.
5. **Test it before anyone else does.** Ask it the five things you always asked.
   Then run the break-it set (`docs/MODES.md`). Expect the voice to be slightly
   different — it's a different model underneath. If that matters, tune the
   instructions; that's now a file you control.

## What comes across, and what doesn't
| | |
|---|---|
| ✅ Instructions | pasted whole, they drive the behaviour |
| ✅ Files | as text, or properly via AI Search |
| ✅ Conversation starters | as buttons |
| ✅ The character of the thing | it answers like yours did |
| ❌ **Web browsing** | not included |
| ❌ **Image generation** | not included |
| ❌ **Code interpreter** | not included — and this is the feature the research showed could be used to *download your uploaded files* |
| ❌ **Actions / API calls** | rebuild deliberately. They were the most fragile part anyway |
| ❌ **Memory across chats** | not included. Each chat starts fresh; chats are saved in the visitor's browser only |

Be honest with yourself about that list. If your GPT's whole job was browsing,
this isn't a drop-in. If it was answering from your material — which is what
almost all of them do — it moves across cleanly.

## What you gain, precisely
**Your instructions sit ON TOP of this project's guardrails, not instead of them.**
It answers like your GPT *and* refuses to invent prices, won't share links you
didn't approve, hands off instead of guessing, and won't recite its own
instructions to a stranger. **Same brain. Better manners.**

And the ownership, said precisely:
- Your files are **not in a store where anyone can talk to your GPT and coax them
  back out.** That specific, documented attack is gone.
- It runs **on your domain, in your account, on your bill.** Nobody can change
  the terms or decide your plan no longer qualifies.
- It is still a model reading text. **Don't put anything in it you'd be unhappy to
  see quoted back.** Ownership changes who controls it. It doesn't make text unreadable.
