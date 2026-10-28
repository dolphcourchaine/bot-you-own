// ============================================================================
//  LAYER 1a — WHICH LANGUAGE TO ANSWER IN
//
//  The model already speaks dozens of languages. Nothing here translates
//  anything: the files stay in the owner's language, the model reads them and
//  answers in the visitor's. This file does the one thing the model can't be
//  trusted to do on its own — decide, in code, which language that is, so the
//  prompt can say it plainly ("Reply in Spanish") and the firewall knows what
//  to expect.
//
//  Detection is a cheap guess from the visitor's own words. No model call:
//    1. Script first. Chinese, Japanese, Korean, Arabic, Cyrillic and Hindi
//       are unmistakable from the characters alone.
//    2. Then stopwords. For the Latin-alphabet languages we count the little
//       words ("the", "el", "les", "der", "não", "che", "het") plus a few
//       accents that only one language uses (¿ ñ ß ã). Most words decides.
//  Unsure = "" = English behaviour, exactly as before. Fails OPEN.
//
//  YourBots/config.js → languages:
//    mode:    "visitor" — reply in the visitor's language (default)
//             "owner"   — always reply in the owner's language
//    owner:   the owner's language, ISO code. The files, the handoff line and
//             the lead brief are in this language. "en" unless you say otherwise.
//    allowed: only these languages, e.g. ["en", "es"]. Empty = any the model
//             speaks. A visitor writing in another one gets one polite sentence,
//             in their language, saying which languages are available.
// ============================================================================

export const LANGUAGE_NAMES = {
  en: "English", es: "Spanish", fr: "French", de: "German", pt: "Portuguese", it: "Italian", nl: "Dutch",
  zh: "Chinese", ja: "Japanese", ko: "Korean", ar: "Arabic", ru: "Russian", uk: "Ukrainian", hi: "Hindi",
};

export function languageName(code) {
  const c = String(code || "").toLowerCase();
  return LANGUAGE_NAMES[c] || c;
}

// The little words that give a language away. Accents are stripped before
// matching, so "está" is looked up as "esta". Greetings and thanks count double:
// a lone "Merci !" is plenty to go on.
const STOPWORDS = {
  en: "the a an is are am do does did you your yours i my we our it its what how when where who which why can could would should will to of in on for and or but with this that these those me not have has had be was were if at from about please thanks thank hi hello hey need want get much many there here no yes",
  es: "el la los las un una unos unas de del al y o que como cuando donde cual cuales cuanto cuanta cuantos cuantas quien por para con sin sobre es son esta estan hay tiene tienen tengo puedo puede pueden quiero necesito ustedes usted nosotros mi mis su sus tu tus se si no me lo le les este esto ese esa eso muy mas pero tambien servicio precio cuesta horario horarios ayuda favor",
  fr: "le la les un une des du de et ou que qui quoi comment quand quel quelle quels quelles combien pour avec sans sur dans est sont il elle ils elles vous nous je tu on mon ma mes votre vos ton tes ce cet cette ces ne pas plus tres aussi avez ai avons ont peut peux pouvez voudrais veux faut prix horaires service c'est qu'est beaucoup",
  de: "der die das den dem des ein eine einen einem einer und oder nicht ist sind wie was wann wo wer welche welcher welches wieviel viel ich du sie wir ihr es mein meine ihre ihren mit ohne fur von zu zum zur bei nach auf aus uber unter im an am haben habe hat kann konnen konnte mochte brauche bitte ja nein auch sehr noch schnell kommt techniker preis kostet offnungszeiten uhr",
  pt: "o a os as um uma uns umas de do da dos das e ou que como quando onde qual quais quanto quanta quantos quem por para com sem sobre em no na nos nas ao aos sao esta estao tem tenho posso pode podem quero preciso bom boa dia tarde noite voce voces eu meu minha seu sua se sim nao me isso isto muito mais mas tambem servico preco horario horarios ajuda favor",
  it: "il lo la i gli le un uno una di del della dei delle e ed o che come quando dove quale quali quanto quanta quanti chi per con senza su in nel nella al alla ai alle sono ha hanno ho posso puo possono voglio vorrei prego voi noi io mio mia suo sua vostro vostra si non mi questo questa molto piu ma anche servizio prezzo costa orari orario aiuto favore",
  nl: "de het een en of dat die dit deze is zijn was wat hoe wanneer waar wie welke hoeveel ik je jij u wij we jullie ze mijn uw jouw met zonder voor van naar op bij aan in uit over heb hebt heeft hebben kan kunnen kunt wil moet graag ja nee niet ook geen prijs kost openingstijden dienst",
};
const GREETINGS = {
  es: "hola gracias buenos buenas dias tardes noches",
  fr: "bonjour bonsoir merci salut svp",
  de: "danke hallo guten tag morgen",
  pt: "ola obrigado obrigada",
  it: "ciao salve grazie buongiorno buonasera",
  nl: "hallo hoi dank bedankt dankjewel alstublieft alsjeblieft",
};
const SETS = Object.fromEntries(Object.keys(STOPWORDS).map((code) => {
  const m = new Map();
  for (const w of STOPWORDS[code].split(/\s+/)) m.set(w, 1);
  for (const w of (GREETINGS[code] || "").split(/\s+/).filter(Boolean)) m.set(w, 2);
  return [code, m];
}));

// Characters only one of the Latin-alphabet languages uses.
const ACCENT_HINTS = [
  [/[¿¡ñ]/g, "es", 2],
  [/ß/g, "de", 2],
  [/[äöü]/g, "de", 1],
  [/[ãõ]/g, "pt", 2],
  [/[œ]/g, "fr", 2],
  [/[èàù]/g, "fr", 1],
  [/[èà]/g, "it", 1],
];

// Scripts: one look at the characters is enough.
const SCRIPTS = [
  ["ja", /[\u3040-\u30ff]/g],              // hiragana / katakana — checked before Han, Japanese uses both
  ["zh", /[\u4e00-\u9fff]/g],              // Han
  ["ko", /[\uac00-\ud7af\u1100-\u11ff]/g], // Hangul
  ["ar", /[\u0600-\u06ff]/g],
  ["hi", /[\u0900-\u097f]/g],              // Devanagari
  ["ru", /[\u0400-\u04ff]/g],              // Cyrillic; Ukrainian is told apart below
];

// One message → { code, name }. code "" means "not sure" (treat as English).
export function detectOne(text) {
  const s = String(text || "");
  const letters = (s.match(/\p{L}/gu) || []).length;
  if (!letters) return { code: "", name: "" };

  // 1. Script. A third of the letters in one script settles it.
  for (const [code, re] of SCRIPTS) {
    const n = (s.match(re) || []).length;
    if (n && n >= letters * 0.3) {
      if (code === "ru" && /[іїєґ]/i.test(s)) return { code: "uk", name: LANGUAGE_NAMES.uk };
      return { code, name: LANGUAGE_NAMES[code] };
    }
  }

  // 2. Stopwords, on the accent-stripped words.
  const scores = Object.fromEntries(Object.keys(SETS).map((c) => [c, 0]));
  for (const [re, code, weight] of ACCENT_HINTS) scores[code] += (s.match(re) || []).length * weight;
  const plain = s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const words = plain.split(/[^\p{L}\p{N}']+/u).map((w) => w.replace(/^'+|'+$/g, "")).filter(Boolean);
  for (const w of words) for (const [code, set] of Object.entries(SETS)) scores[code] += set.get(w) || 0;

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [best, bestScore] = ranked[0];
  const second = ranked[1][1];
  // Needs at least two clues, a clear winner, and to beat English.
  if (best === "en" || bestScore < 2 || bestScore === second || bestScore <= scores.en) return { code: "", name: "" };
  return { code: best, name: LANGUAGE_NAMES[best] };
}

// The visitor's last one or two messages → { code, name }. The latest message
// decides; if it's too short to tell ("ok", "yes?"), the one before it does.
export function detectLanguage(texts) {
  const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t || "")).filter((t) => t.trim());
  for (let i = list.length - 1; i >= 0 && i >= list.length - 2; i--) {
    const r = detectOne(list[i]);
    if (r.code) return r;
    // A latest message with a few real words is a verdict, not a shrug.
    if ((list[i].match(/\p{L}+/gu) || []).length >= 4) break;
  }
  return { code: "", name: "" };
}

// config.languages with the blanks filled in.
export function languageSettings(config) {
  const l = config?.languages && typeof config.languages === "object" ? config.languages : {};
  return {
    mode: l.mode === "owner" ? "owner" : "visitor",
    owner: String(l.owner || "en").toLowerCase().slice(0, 8) || "en",
    allowed: (Array.isArray(l.allowed) ? l.allowed : []).map((c) => String(c || "").toLowerCase().slice(0, 8)).filter(Boolean),
  };
}

// Settings + what was detected → what the bot should do this turn:
//   code / name     the language to answer in
//   detected        what the visitor wrote in ("" = unsure, or English)
//   unavailable     the visitor's language when the owner's list doesn't include it
//   menu            the owner's list as words: "English and Spanish"
export function chooseLanguage(settings, detected) {
  const s = settings || languageSettings(null);
  const visitor = String(detected?.code || "");
  let code = s.owner;
  let unavailable = "";
  if (s.mode === "visitor" && visitor) {
    if (!s.allowed.length || s.allowed.includes(visitor)) code = visitor;
    else if (!s.allowed.includes(s.owner) && s.allowed.length) { code = s.allowed[0]; unavailable = visitor; }
    else unavailable = visitor;
  }
  const names = s.allowed.map(languageName);
  const menu = names.length <= 1 ? names.join("") : names.slice(0, -1).join(", ") + " and " + names.at(-1);
  return { code, name: languageName(code), detected: visitor, unavailable, menu, owner: s.owner };
}

// The {{placeholders}} for the prompt (Engine/worker/prompt.js). All empty for
// an English visitor with an English owner, so the prompt reads as it always did.
export function languageVars(lang) {
  if (!lang) return { language: "", filesLanguage: "", visitorLanguage: "", languageMenu: "" };
  if (lang.unavailable) {
    return { language: "", filesLanguage: "", visitorLanguage: languageName(lang.unavailable), languageMenu: lang.menu };
  }
  // Say it only when there is something to say: a non-English answer, or an
  // owner who wants English back whatever the visitor wrote in.
  const say = lang.code !== "en" || (lang.detected && lang.detected !== lang.code);
  return {
    language: say ? lang.name : "",
    filesLanguage: say && lang.code !== lang.owner ? languageName(lang.owner) : "",
    visitorLanguage: "",
    languageMenu: "",
  };
}
