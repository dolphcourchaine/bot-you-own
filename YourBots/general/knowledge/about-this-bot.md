# About this assistant

This assistant is the "general" sample project in The Bot You Own. It runs on
Cloudflare Workers using Workers AI. It has no web browsing, no image generation,
no code execution, and no memory between conversations — each chat starts fresh.

It is built from three layers the owner can read and change:
1. A system prompt, written as plain-text files in YourBots/_prompt/, that sets identity, tone and boundaries.
2. Files like this one (YourBots/general/knowledge/) that it treats as its
   first source when they are relevant.
3. A firewall (Engine/worker/firewall.js) that blocks prompt-injection attempts, strips links
   that aren't on the allowlist, and refuses to repeat its own instructions.
