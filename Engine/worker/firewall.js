// ============================================================================
//  LAYER 3a — THE FIREWALL
//
//  This is the part nobody teaches, and it's the part that decides whether
//  your bot is an asset or a liability.
//
//  Rule of thumb: enforce OUTSIDE the model wherever you can (real code, real
//  regexes, a second model that only says safe/unsafe), and REQUEST inside the
//  model where you can't (the <boundaries> section of the prompt).
//
//  Every check returns a verdict. YourBots/config.js decides what to do with it. Every
//  check fails OPEN: if it can't run, the bot still answers. Each one is tagged
//  with the OWASP LLM Top 10 (2025) risk it addresses.
//
//  Techniques borrowed from: protectai/llm-guard (invisible text, secrets),
//  meta-llama/PurpleLlama (Llama Guard), guardrails-ai (verdict + action),
//  OpenAI Model Spec ("ignore untrusted data by default").
// ============================================================================

// --- INBOUND: things we refuse to send to the model -------------------------

// LLM01 Prompt Injection / LLM07 System Prompt Leakage.
// These are the phrasings that, in practice, precede an attempt to pull the
// prompt or override the rules. Specific on purpose — "what's your system for
// booking?" must NOT match.
export const INJECTION_PATTERNS = [
  /ignore\s+(all\s+|any\s+|the\s+|your\s+)?(previous|prior|above|earlier|preceding)\s+(instructions?|rules?|prompts?|directions?)/i,
  /disregard\s+(all\s+|your\s+|the\s+)?(previous|prior|above|earlier)\s+(instructions?|rules?)/i,
  /\b(system|initial|original|hidden|secret|developer|internal)\s+(prompt|instructions?|message|configuration)\b/i,
  /\b(reveal|print|show|display|output|repeat|recite|dump|leak|expose|tell me)\b.{0,40}\b(your|the)\s+(instructions?|prompt|rules|configuration|guidelines|system message)/i,
  /\b(developer|debug|god|admin|jailbreak|unrestricted|dan)\s+mode\b/i,
  /\byou are now\s+(dan|in|an?\s+(unrestricted|unfiltered|uncensored))/i,
  /\bpretend\s+(you\s+)?(have\s+no|there\s+are\s+no|you\s+don'?t\s+have)\s+(rules|restrictions|guidelines|limits)/i,
  /\b(act|behave|respond)\s+as\s+(if\s+)?(you\s+)?(have|had)\s+no\s+(rules|restrictions|guidelines)/i,
  /\b(what|which)\s+(are|were)\s+(your|the)\s+(exact\s+)?(instructions|rules|guidelines)\s+(you\s+were\s+)?(given|told)/i,
  /\b(translate|encode|base64|rot13|reverse|summari[sz]e|paraphrase)\b.{0,40}\b(your|the)\s+(instructions?|prompt|rules)/i,
  /<\|im_start\|>|<\|system\|>|\[INST\]|<<SYS>>|\bBEGIN\s+SYSTEM\b/i,
  /\bI am (the|your) (developer|owner|administrator|creator)\b.{0,60}\b(instructions?|prompt|rules)/i,
  // The same three moves in Spanish, French and German — the top phrasings only.
  // "Ignore your previous instructions", "show me your prompt", "system prompt", "developer mode".
  /\bignora(?:r|d|)\s+(?:todas?\s+)?(?:las\s+|tus\s+|sus\s+)?(?:instrucciones|reglas|indicaciones)\s+(?:anteriores|previas)/i,
  /\b(?:muestra|mu[eé]strame|revela|imprime|repite|escribe|dime)\b.{0,40}\b(?:tu|tus|el|la|las)\s+(?:prompt|instrucciones|reglas|configuraci[oó]n|mensaje del sistema)/i,
  /\b(?:prompt|instrucciones|mensaje)\s+(?:del\s+)?sistema\b|\bmodo\s+(?:desarrollador|dios|sin restricciones)\b/i,
  /\bignore[sz]?\s+(?:toutes\s+)?(?:les\s+|tes\s+|vos\s+)?(?:instructions|r[èe]gles|consignes)\s+(?:pr[ée]c[ée]dentes|ant[ée]rieures)/i,
  /\b(?:montre|affiche|r[ée]v[èe]le|imprime|r[ée]p[èe]te|donne)(?:-moi)?\b.{0,40}\b(?:ton|tes|votre|vos|le|la|les)\s+(?:prompt|instructions|r[èe]gles|consignes|configuration|message syst[èe]me)/i,
  /\b(?:prompt|instructions|message)\s+(?:du\s+)?syst[èe]me\b|\bmode\s+(?:d[ée]veloppeur|dieu|sans restrictions?)\b/i,
  /\bignorier(?:e|en|)\s+(?:alle\s+)?(?:deine\s+|die\s+|ihre\s+)?(?:vorherigen|bisherigen|fr[üu]heren|obigen)\s+(?:anweisungen|regeln|instruktionen)/i,
  /\b(?:zeige?|zeig|gib|drucke|wiederhole|verrate|nenne)\b.{0,40}\b(?:mir\s+)?(?:dein|deine|deinen|den|die|das)\s+(?:prompt|anweisungen|regeln|konfiguration|systemnachricht)/i,
  /\bsystem(?:prompt|anweisung(?:en)?|nachricht)\b|\bentwicklermodus\b/i,
];

// LLM02 Sensitive Information Disclosure — things people paste by accident.
export const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/,                       // OpenAI / Anthropic style keys
  /\bAKIA[0-9A-Z]{16}\b/,                            // AWS access key
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,                  // GitHub tokens
  /\b(?:\d[ -]?){13,19}\b/,                          // card-number shaped runs
  /\b\d{3}-\d{2}-\d{4}\b/,                           // US SSN shape
];

// Invisible / zero-width characters used to hide instructions in pasted text.
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u00AD]/g;

export function normalise(text) {
  return String(text || "").replace(INVISIBLE, "").replace(/\r\n/g, "\n");
}

export function screenInbound(text) {
  const clean = normalise(text);
  const hits = INJECTION_PATTERNS.filter((re) => re.test(clean)).length;
  const secret = SECRET_PATTERNS.some((re) => re.test(clean));
  const invisible = INVISIBLE.test(String(text || ""));
  return {
    text: clean,
    injection: hits > 0,
    injectionHits: hits,
    secret,
    invisible,
  };
}

// --- OUTBOUND: things we won't let leave -----------------------------------

// LLM05 Improper Output Handling. Enforced in code because asking nicely isn't enough.
export function stripDisallowedLinks(text, allowedLinks = []) {
  return String(text || "").replace(/https?:\/\/[^\s)>\]"']+/g, (url) => {
    const clean = url.replace(/[.,;:!?]+$/, "");
    const ok = allowedLinks.some((a) => clean === a || clean.startsWith(a.replace(/\/$/, "") + "/"));
    return ok ? url : "[link removed]";
  });
}

// LLM07 System Prompt Leakage. If the reply contains a run of words that only
// exists in the protected part of the prompt, the model has been talked into
// reciting it. We compare 7-word windows — long enough that ordinary answers
// never collide, short enough to catch a paraphrase that kept a sentence.
export function leaksPrompt(reply, protectedText, window = 7) {
  const words = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
  const p = words(protectedText);
  const r = words(reply);
  if (r.length < window || p.length < window) return false;
  const grams = new Set();
  for (let i = 0; i + window <= p.length; i++) grams.add(p.slice(i, i + window).join(" "));
  for (let i = 0; i + window <= r.length; i++) {
    if (grams.has(r.slice(i, i + window).join(" "))) return true;
  }
  // Structural markers are a leak on their own.
  return /<(identity|personality|formatting|boundaries|files|how_to_answer|links|job|owner_instructions)>/i.test(reply);
}

// LLM07, the paraphrase case. A model can be talked into describing its rules
// "in its own words" — no 8-word run matches, but the answer is still a leak.
// Two signals together: it's talking ABOUT its rules, and it names several of
// the distinctive ideas in them. Either alone is normal conversation.
const META_TALK = /\b(my|the|these|those|its) (personality|formatting|system|hidden|internal|core|response|answer) (rules?|instructions?|prompt|guidelines|directives|style)\b|\b(rules?|instructions?|guidelines) (that )?(i|it) (follow|was given|were given|operate under|adhere to)\b|\bi('m| am| was) (supposed|told|instructed|programmed|designed|configured|built|meant) to\b|\bi (aim|try|strive|tend|prefer) to (be|keep|match|avoid|stay|not)\b|\b(in|with|across) my (responses|answers|replies)\b/i;
const RULE_TERMS = ["warm", "direct", "flatter", "lecture", "moraliz", "clarifying question", "match the length", "restate the question", "as an ai", "minimum formatting", "fenced code", "emoji", "civil", "hostile", "reveal", "paraphrase", "privileged", "untrusted", "persona", "boundaries", "sycophan", "disclaimer", "would you like me", "let me know if", "allowed list", "hand off", "handoff", "only from the files", "written down"];
export function paraphrasesRules(reply) {
  const low = String(reply || "").toLowerCase();
  if (!META_TALK.test(low)) return false;
  const hits = RULE_TERMS.filter((t) => low.includes(t)).length;
  return hits >= 3;
}

export function screenOutbound(reply, { allowedLinks, protectedText, config }) {
  const flags = [];
  let text = String(reply || "");
  if (config.firewall?.stripLinks !== false) {
    const stripped = stripDisallowedLinks(text, allowedLinks);
    if (stripped !== text) flags.push("link-stripped");
    text = stripped;
  }
  if (config.firewall?.blockPromptLeaks !== false && leaksPrompt(text, protectedText)) {
    flags.push("leak-blocked");
    text = "";
  } else if (config.firewall?.blockPromptLeaks !== false && paraphrasesRules(text)) {
    flags.push("leak-blocked:paraphrase");
    text = "";
  }
  return { text, flags };
}

// --- The handoff, enforced. --------------------------------------------------
// In a strict project the owner wrote a handoff contact for a reason. Models
// paraphrase it about one time in three ("consult a professional") and drop the
// phone number. If the reply is a decline and the contact isn't in it, add it.
// A contact line on the end of a decline is never wrong; a missing one is.
const DECLINE = /\b(i(?:'|’)?m not able to|i am not able to|i can(?:'|’)?t\b|i cannot\b|i(?:'|’)?m unable to|i am unable to|i don(?:'|’)?t have (?:that|specific|any|the)\b|not something i can\b|i(?:'|’)?d rather not\b|isn(?:'|’)?t (?:something )?(?:written|in the files|in our files))/i;
// The same "I can't / I don't have that" in Spanish, French, German, Portuguese,
// Italian and Dutch. Phrase-based like the English one: the common ways a model
// says no in each language, nothing clever.
const DECLINE_OTHER = /\b(no (?:puedo|tengo|dispongo de)|no (?:me )?es posible|je ne (?:peux|suis) pas|je n(?:'|’)ai pas|ich kann (?:das |dazu |ihnen )?(?:leider )?nicht|kann ich (?:leider )?nicht|ich habe (?:dazu |leider )?keine|(?:nao|não) (?:posso|tenho)|non (?:posso|ho|sono in grado)|ik kan (?:dat |daar )?(?:helaas )?niet|ik heb (?:daar |helaas )?geen)\b/i;

// The "[HANDOFF]" line 7-answering-strict.md asks for at the end of a decline. A
// model declining in Spanish won't say "I'm not able to", so the prompt asks it
// to mark the decline instead; the code reads the mark and takes it out. Tolerant
// of the same manglings as the intake marker (case, spaces, stray asterisks).
// The marker is an internal protocol token, never something a visitor should read. It used
// to be anchored to a whole line (^...$ /m), so a model that ended a SENTENCE with it —
// "...wenden Sie sich an unser Team. [HANDOFF]" — leaked it straight to the page. Strip it
// wherever it appears, with the spaces around it, and tidy what is left behind.
const HANDOFF_MARKER = /[ \t]*[*_]*\[\s*HANDOFF\s*\][*_]*[ \t]*/gi;
export function stripHandoffMarker(text) {
  const found = HANDOFF_MARKER.test(String(text || ""));
  HANDOFF_MARKER.lastIndex = 0;
  if (!found) return { text, found: false };
  const clean = String(text).replace(HANDOFF_MARKER, " ").replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  HANDOFF_MARKER.lastIndex = 0;
  return { text: clean, found: true };
}

// `declined: true` = the code already knows this is a decline (the marker was
// there), so the phrase check is skipped. Otherwise a decline is: an English or
// other-language "I can't" phrase, or the owner's own handoffText — a model that
// kept the sentence but dropped the contact.
export function ensureHandoff(reply, project, { declined = false } = {}) {
  if (project.grounding === "open" || !project.handoffContact) return { text: reply, added: false };
  const ownText = String(project.handoffText || "").trim().slice(0, 30);
  const isDecline = declined || DECLINE.test(reply) || DECLINE_OTHER.test(reply) || (ownText.length >= 12 && reply.includes(ownText));
  if (!isDecline) return { text: reply, added: false };
  const contact = project.handoffContact;
  const tokens = (contact.match(/[\w.+-]+@[\w.-]+|\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}|https?:\/\/\S+/g) || []);
  const present = tokens.length ? tokens.some((t) => reply.includes(t)) : reply.includes(contact.slice(0, 24));
  if (present) return { text: reply, added: false };
  return { text: reply.trim().replace(/\s+$/, "") + " " + contact, added: true };
}

// --- Llama Guard: a second model that only answers safe / unsafe -------------
// Model on Workers AI: @cf/meta/llama-guard-3-8b. Output is free text —
// "safe", or "unsafe" followed by category codes (S1–S14). Parse with a regex;
// never string-match the whole thing. Fails OPEN.
export const LLAMA_GUARD_MODEL = "@cf/meta/llama-guard-3-8b";
export const LLAMA_GUARD_CATEGORIES = {
  S1: "Violent Crimes", S2: "Non-Violent Crimes", S3: "Sex-Related Crimes",
  S4: "Child Sexual Exploitation", S5: "Defamation", S6: "Specialized Advice",
  S7: "Privacy", S8: "Intellectual Property", S9: "Indiscriminate Weapons",
  S10: "Hate", S11: "Suicide & Self-Harm", S12: "Sexual Content",
  S13: "Elections", S14: "Code Interpreter Abuse",
};

export async function llamaGuard(env, messages) {
  if (!env?.AI) return { ran: false, safe: true, categories: [] };
  try {
    const result = await env.AI.run(LLAMA_GUARD_MODEL, { messages, max_tokens: 20 });
    const raw = typeof result?.response === "string"
      ? result.response
      : JSON.stringify(result?.response ?? result ?? "");
    const unsafe = /^\s*unsafe/i.test(raw) || /"safe"\s*:\s*false/i.test(raw);
    const categories = (raw.match(/\bS\d{1,2}\b/g) || []).map((c) => c.toUpperCase());
    return { ran: true, safe: !unsafe, categories, raw: raw.slice(0, 80) };
  } catch (err) {
    console.error("llama guard failed, allowing through", err);
    return { ran: false, safe: true, categories: [] };
  }
}

// --- Strip personal info BEFORE anything is stored. -------------------------
//  ⚠️ KNOWN GAP: this does NOT catch people's names. Nothing pattern-based does.
export function redact(text) {
  return String(text || "")
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email]")
    .replace(/(\+?\d[\d\s().-]{7,}\d)/g, "[phone]")
    .replace(/\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/g, "[date]");
}
