# Free, licensed prompts you can import as a bot

For the "imported" job (`mode: "imported"`): take a published custom-GPT style
instruction set, paste it into `YourBots/<name>/instructions.md`, and it runs on
your own Worker. The catch is the licence. The most-starred "leaked GPTs" repos
on GitHub have no licence, or slap MIT on text the repo owner never wrote, so
they are **not** usable in a paid workshop. These are.

## Use these

| Source | Stars | Licence | What it is |
|---|---|---|---|
| [danielmiessler/fabric](https://github.com/danielmiessler/fabric) | ~44k | MIT | Hundreds of "patterns": identity + steps + output-format system prompts, written to run on any model. The best fit for this tool. |
| [LichAmnesia/GPT-Prompt-Hub](https://github.com/LichAmnesia/GPT-Prompt-Hub) | ~2.4k | MIT | 222 original custom-GPT style instruction sets with frontmatter, sorted by category. Closest to a real GPT's Instructions box. |
| [f/awesome-chatgpt-prompts](https://github.com/f/awesome-chatgpt-prompts) ([prompts.chat](https://prompts.chat)) | ~170k | CC0 (prompt text) | The famous one. Public domain, so no attribution needed. Most entries are short ("Act as a Linux terminal"); use it for the classics, not for long rule sets. |

MIT means: keep a one-line credit (the repo name and "MIT licence") on the slide,
the handout, or at the top of the instructions file. CC0 needs nothing.

## Good first picks

**fabric** (each lives at `data/patterns/<name>/system.md`):
- `extract_wisdom` (~450 words): ideas, quotes, habits and references out of a transcript.
- `create_summary` (~280 words): a 20-word overview, 10 main points, 5 takeaways.
- `improve_writing` (~230 words): fixes grammar and style without changing meaning.

**GPT-Prompt-Hub** (under `prompts/`):
- `engineering/senior-code-reviewer.md` (~250 words): staff-engineer persona, severity-ranked findings.
- `business/product-manager-prd-writer-kpi-driven.md` (~450 words): PM persona with an 11-section PRD template.
- `learning/socratic-polymath-tutor-any-topic.md` (~900 words, trim it): a 7-move teaching framework.

**prompts.chat**: browse the site and copy any entry; `prompts.csv` in the repo has them all.

## Don't use these (and why)

| Repo | Stars | Problem |
|---|---|---|
| linexjlin/GPTs | ~32k | No licence. Prompts extracted from other people's GPTs. |
| friuns2/Leaked-GPTs | ~2.5k | No licence. Leaked. |
| LouisShark/chatgpt_system_prompt | ~10.8k | Says MIT, but the text was extracted from third-party GPTs; the repo can't license what it doesn't own. |
| 0xeb/TheBigPromptLibrary | ~5.4k | Same: the `CustomInstructions/` and `SystemPrompts/` folders are verbatim extractions. |
| ai-boost/awesome-gpts, taranjeet/awesome-gpts | ~3.4k / ~1.4k | Links only, no prompt text. |
| Anthropic and OpenAI prompt example pages | | Reference only; no reuse grant in their terms. |

## How to import one

1. Copy `YourBots/_template/` to `YourBots/<name>/`.
2. Paste the prompt into `instructions.md`. Put the credit line at the top as a comment.
3. In `project.json` set `"mode": "imported"`, a name, a greeting and three starters.
4. Add the folder to `YourBots/index.js`. Commit. It's live in about a minute.

Checked 2026-09-13. Star counts and licences move; look at the LICENSE file before you teach from a repo.
