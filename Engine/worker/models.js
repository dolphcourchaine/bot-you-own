// ============================================================================
//  THE MODELS YOU CAN PICK (/chat)
//
//  Cloudflare's own catalogue, asked at runtime (env.AI.models), so a model
//  Cloudflare adds shows up here without a code change and one it retires
//  disappears. Only text-generation models, and only ones that take chat
//  messages. Prices come from usage.js (a snapshot); a model with no price there
//  is still listed, just marked "no price".
//
//  The same list is the allowlist: /api/chat only accepts a picked model that
//  is on it. Cached for an hour per isolate; if the catalogue can't be read,
//  the list is just the priced models, so the picker never comes up empty.
// ============================================================================
import { PRICES } from "./usage.js";

// The bot /chat talks to: the open ChatGPT-style Assistant (YourBots/general).
export const CHAT_BOT = "general";
const TTL = 60 * 60 * 1000;
let CACHE = { at: 0, list: null };

// Not chat models, or not useful to talk to: guards, embedders, rerankers, base models.
const SKIP = /lora|guard|embed|rerank|bge-|-base\b|summari[sz]|translat|whisper|melotts|aura|flux|stable-diffusion|detr|resnet|m2m100|distilbert|bart-large/i;
// Reasoning models spend part of their budget thinking before they answer.
// Models that take pictures with the words (Workers AI multimodal chat models).
const SEES = /llama-4-scout|gemma-4|gemma-3-|vision|mistral-small-3\.1|kimi-k2\.6/i;
export const seesImages = (id) => SEES.test(String(id || ""));
const THINKS = /gpt-oss|deepseek-r1|qwq|magistral|qwen3|deepseek-v4|kimi/i;

const nameOf = (id) => id.split("/").pop().replace(/-instruct|-it\b|-chat|-fp8|-fast|-awq|-int8/gi, "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
const MAKERS = { openai: "OpenAI", meta: "Meta", "meta-llama": "Meta", google: "Google", mistralai: "Mistral", mistral: "Mistral", qwen: "Qwen", "deepseek-ai": "DeepSeek", moonshotai: "Moonshot", "zai-org": "Z.ai", "ibm-granite": "IBM", nvidia: "NVIDIA", aisingapore: "AI Singapore", microsoft: "Microsoft", moondream: "Moondream" };
const makerOf = (id) => { const k = id.split("/")[1] || ""; return MAKERS[k] || k.replace(/-/g, " "); };

function shape(id, m = {}) {
  const p = PRICES[id] || null;
  const props = Array.isArray(m.properties) ? m.properties : [];
  const prop = (k) => props.find((x) => x?.property_id === k)?.value;
  return {
    id,
    name: nameOf(id),
    maker: makerOf(id),
    description: String(m.description || "").slice(0, 280),
    price: p,                                   // USD per million tokens {in, out}, or null
    context: Number(prop("context_window")) || null,
    beta: String(prop("beta")) === "true",
    thinks: THINKS.test(id),
    sees: SEES.test(id),
  };
}

export async function listTextModels(env) {
  if (CACHE.list && Date.now() - CACHE.at < TTL) return CACHE.list;
  let list = [];
  try {
    const seen = new Set();
    for (let page = 1; page <= 4; page++) {
      const batch = await env.AI.models({ task: "Text Generation", per_page: 100, page });
      if (!Array.isArray(batch) || !batch.length) break;
      for (const m of batch) {
        const id = String(m?.name || "");
        if (!id.startsWith("@cf/") || seen.has(id) || SKIP.test(id)) continue;
        seen.add(id); list.push(shape(id, m));
      }
      if (batch.length < 100) break;
    }
  } catch (err) { console.warn("model catalogue not read", err?.message || err); }
  if (!list.length) list = Object.keys(PRICES).map((id) => shape(id));
  // Priced (known) models first, cheapest input first; then the rest by name.
  list.sort((a, b) => (a.price ? 0 : 1) - (b.price ? 0 : 1) || (a.price && b.price ? a.price.in - b.price.in : 0) || a.name.localeCompare(b.name));
  CACHE = { at: Date.now(), list };
  return list;
}

export async function isPickable(env, id) {
  id = String(id || "").trim();
  if (!/^@cf\/[\w.\-]+\/[\w.\-]+$/.test(id)) return false;
  return (await listTextModels(env)).some((m) => m.id === id);
}
