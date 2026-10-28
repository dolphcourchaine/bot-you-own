// ============================================================================
//  LAYER 3c — THE ROUTER: cheap turns don't need a 120-billion-parameter model
//
//  "hi", "thanks!", "ok", "bye" — a good share of what a public bot hears is
//  small talk, and each of those turns costs the same as a real question when
//  it goes to the big model. This file decides, in plain code and with NO model
//  call, whether the visitor's last message is CHIT-CHAT or REAL. Chit-chat goes
//  to a small, cheap model with the SAME system prompt and a short answer
//  budget; everything else goes to the main model exactly as before.
//
//  Conservative on purpose: when in doubt it says "real". A wrong "real" costs
//  a few neurons; a wrong "chit-chat" could send a pricing question to a small
//  model. Rules, in order:
//    - anything with a digit, a link, an attachment, or a scripted job (intake,
//      booking, concierge…) is real — those need the big model to follow the
//      script. Only "answer" and "assistant" bots get cheap turns.
//    - strict grounding: a "?" or more than 6 words is real, always
//    - open grounding: a "?" is only chit-chat for "are you there?"-style phrases
//    - after that, EVERY word must be small talk. One unknown word = real.
//      A few soft words ("morning", "later", "call") count as small talk only
//      if the bot's own files never use them — "call" is small talk for a
//      dentist and a real question for a company that sells call-outs.
//  Fails open: if the classifier throws, the turn is real.
//  YourBots/config.js → routing.smallTurns switches the whole thing off.
// ============================================================================

// Pure small talk. A message is chit-chat only if every word is on one of the two lists.
const SMALL_TALK = new Set((
  "hi hello hey hiya heya yo howdy greetings hola sup " +
  "thanks thank thx ty tysm cheers ta appreciated appreciate " +
  "ok okay k kk sure fine alright right cool great nice awesome perfect brilliant lovely excellent fantastic wonderful sweet neat " +
  "yes yep yeah yup ya yah no nope nah " +
  "bye goodbye cya later ciao " +
  "got it understood noted gotcha roger " +
  "good bad well " +
  "lol haha hehe hmm hm oh ah wow ooh eh " +
  "you u your there here still anyone are im i am its it that this thats " +
  "please pls welcome np " +
  "so very really too much a an and the " +
  "helpful helps helped useful " +
  "cheers mate buddy friend pal " +
  "morning afternoon evening night weekend day one all " +
  "test testing ping hello? "
).trim().split(/\s+/));

// Soft words: small talk unless THIS bot's files use them (see filesVocabulary).
const SOFT = new Set("morning afternoon evening night weekend day later call help info time one all good great".split(" "));

// Whole phrases that are small talk even though they contain a question mark
// or a word that would otherwise look real ("how", "what").
const PHRASES = [
  /\b(are|r) (you|u) (there|here|still there|still here|around|alive|awake|a bot|a robot|human|real)\b/g,
  /\b(you|u|anyone|anybody|somebody) (there|here)\b/g,
  /\bhow (are|r) (you|u|things)( doing| today)?\b/g,
  /\bhow'?s it going\b/g, /\bwhat'?s up\b/g, /\bhows things\b/g,
  /\bhave a (good|great|nice|lovely) (one|day|evening|night|weekend)\b/g,
  /\b(see|catch) (you|u|ya)( later| soon)?\b/g,
  /\b(sounds|looks) (good|great|fine)\b/g,
  /\b(will|can) do\b/g, /\bno thanks\b/g, /\bthat'?s all\b/g, /\ball good\b/g, /\bnothing else\b/g,
  /\bthank (you|u)( very| so)?( much)?\b/g, /\bthanks( a lot| so much| very much)?\b/g,
  /\bnice (one|to meet you)\b/g, /\bgood (to know|job|stuff|bot)\b/g,
  /\btalk (later|soon)\b/g, /\bta ta\b/g, /\bta\b/g,
];

// A per-bot set of the words its instructions and files use. Built once per
// bot (keyed on size, so an edit rebuilds it) — the files can be long.
const vocabCache = new Map();
function filesVocabulary(project) {
  const text = [project?.instructions || "", ...Object.values(project?.files || {})].join("\n");
  const key = `${project?.id || "?"}:${text.length}`;
  const hit = vocabCache.get(key);
  if (hit) return hit;
  const words = new Set(text.toLowerCase().replace(/['’]/g, "").split(/[^a-z]+/).filter((w) => w.length >= 3));
  if (vocabCache.size > 50) vocabCache.clear();
  vocabCache.set(key, words);
  return words;
}

export function classifyTurn(text, { project = {}, attachments = 0 } = {}) {
  try {
    const raw = String(text || "").trim();
    if (!raw) return { kind: "real", reason: "empty" };
    if (attachments > 0) return { kind: "real", reason: "attachment" };
    if (!["answer", "assistant"].includes(project.mode || "answer")) return { kind: "real", reason: `mode ${project.mode}` };
    if (/\d/.test(raw)) return { kind: "real", reason: "has a number" };
    if (/https?:\/\/|@|\bwww\./i.test(raw)) return { kind: "real", reason: "has a link or address" };
    const strict = project.grounding !== "open";
    const words = raw.split(/\s+/).filter(Boolean);
    if (words.length > 6) return { kind: "real", reason: `${words.length} words` };
    if (raw.length > 60) return { kind: "real", reason: "long" };

    let lower = raw.toLowerCase().replace(/['’]/g, "");
    const hasQ = lower.includes("?");
    let phrase = false;
    for (const re of PHRASES) {
      re.lastIndex = 0;
      if (re.test(lower)) { phrase = true; lower = lower.replace(re, " "); }
    }
    if (hasQ && (strict || !phrase)) return { kind: "real", reason: strict ? "question mark (strict)" : "question mark" };

    const left = lower.split(/[^a-z]+/).filter(Boolean);
    // Emoji, "!!!", "👍" — no letters at all: small talk.
    if (!left.length) {
      const hasLetters = /[a-z]/i.test(raw);
      return hasLetters && !phrase ? { kind: "real", reason: "no words recognised" } : { kind: "chit-chat", reason: phrase ? "phrase" : "no words (emoji / punctuation)" };
    }
    const vocab = filesVocabulary(project);
    for (const w of left) {
      if (!SMALL_TALK.has(w)) return { kind: "real", reason: `"${w}" is not small talk` };
      if (SOFT.has(w) && vocab.has(w)) return { kind: "real", reason: `"${w}" appears in the bot's files` };
    }
    return { kind: "chit-chat", reason: "all small talk" };
  } catch (err) {
    console.error("router failed open", err?.message || err);
    return { kind: "real", reason: "classifier error" };
  }
}

// ---- the split, since this isolate started (Under the hood → Gateway & model)
const stats = {
  small: { turns: 0, promptTokens: 0, outputTokens: 0 },
  main: { turns: 0, promptTokens: 0, outputTokens: 0 },
};
export function recordRoute(kind, usage) {
  const s = stats[kind === "small" ? "small" : "main"];
  s.turns += 1;
  if (usage) {
    s.promptTokens += Number(usage.prompt_tokens || usage.input_tokens || 0);
    s.outputTokens += Number(usage.completion_tokens || usage.output_tokens || 0);
  }
}
export function routingStats() {
  return { sinceIsolateStart: true, ...stats };
}
