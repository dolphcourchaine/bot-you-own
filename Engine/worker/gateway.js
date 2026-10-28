// ============================================================================
//  LAYER 3b — THE GATEWAY
//
//  One function: complete({ env, config, system, messages, stream, model, maxTokens, meta }).
//  It talks to whichever model YourBots/config.js names (or the `model` you
//  pass — the router uses this for cheap turns), through Cloudflare AI Gateway
//  when a gateway id is set, and hands back either the full text or an async
//  iterator of text chunks. `meta` is an empty object you pass in; on the way
//  out it says how the call went (meta.gateway, meta.usage).
//
//  Why a gateway at all: it's the dollar ceiling. AI Gateway gives you logs,
//  caching, a per-minute rate limit, a SPEND LIMIT in dollars, and Guardrails
//  (Llama Guard at the edge) — all from the dashboard, none of it in code.
//  See docs/DEPLOY.md. Fails open: if the gateway call errors, we retry without it.
//
//  The gateway is ON by default (id "bot-you-own") but it has to EXIST on your
//  account before it does anything. Until it does, every call falls back to
//  the model directly, one warning goes in the log, and nobody's chat breaks.
//
//  Providers:
//    workers-ai  — no key. env.AI.run(). Default.
//    openai      — secret OPENAI_API_KEY. Chat Completions.
//    anthropic   — secret ANTHROPIC_API_KEY. Messages API.
// ============================================================================

// ---- what the last call did, for Under the hood → Gateway & model -----------
//  "via gateway"               — the call went through AI Gateway
//  "direct (gateway missing)"  — a gateway id is set but no such gateway exists yet
//  "direct (gateway error)"    — the gateway answered with some other error; we retried without it
//  "direct (not configured)"   — gateway.id is empty
let lastGatewayStatus = "direct (not configured)";
let warnedMissing = false;          // the "create it" warning goes in the log once per isolate
let gatewayMissingUntil = 0;        // after a "not found", skip the gateway for a while instead of failing every call twice
const MISSING_RECHECK_MS = 5 * 60 * 1000;

export function gatewayStatus(config) {
  const id = config?.gateway?.id || "";
  return {
    id,
    lastCall: lastGatewayStatus,
    cacheTtl: Number(config?.gateway?.cacheTtl || 0),
    note: !id ? "gateway.id is empty — calls go straight to the model"
      : lastGatewayStatus === "direct (gateway missing)" ? `no gateway named "${id}" on this account yet — create it (docs/OWNER-CHECKLIST.md §1, or DEPLOY.md §D for the API route); calls go direct until then`
      : lastGatewayStatus === "via gateway" ? "logs, rate limit and spend limit live in the dashboard: AI → AI Gateway → " + id
      : "no call has gone through the gateway yet in this isolate",
  };
}

// Does this error mean "there is no gateway with that name"? Today Workers AI
// says exactly: `2001: Please configure AI Gateway in the Cloudflare dashboard`.
// The check is a little broader in case the wording moves — and it only ever
// decides which fallback message we log, never whether the visitor gets an answer.
function isGatewayMissing(err) {
  const m = String(err?.message || err || "");
  return /please configure ai gateway|^\s*2001\b|\b2001:|gateway[^.]{0,40}(not found|does not exist|doesn't exist|no such)|(not found|does not exist|no such)[^.]{0,40}gateway/i.test(m);
}

export async function complete({ env, config, system, messages, stream = false, model = "", maxTokens = 0, meta = {} }) {
  const provider = config.provider || "workers-ai";
  const opts = { env, config, system, messages, stream, model: model || config.model, maxTokens: maxTokens || config.maxTokens || 900, meta };
  if (provider === "openai") return openai(opts);
  if (provider === "anthropic") return anthropic(opts);
  return workersAI(opts);
}

// ---------------------------------------------------------------- Workers AI
// A reasoning model spends tokens thinking BEFORE it writes, and the thinking comes out of
// the same max_tokens budget. At 900 a long article plus a fussy system prompt is entirely
// eaten by the reasoning and the message comes back empty — which is how "Summarise the
// sample article" produced nothing at all, twice. max_tokens is a ceiling, not a spend: you
// pay for what is generated, so lifting it for these models costs nothing on a normal turn
// and is the difference between an answer and silence on a long one.
const REASONS = /gpt-oss|deepseek-r1|qwq|magistral/i;
export function budgetFor(model, maxTokens) {
  return REASONS.test(String(model || "")) ? Math.max(maxTokens, 4000) : maxTokens;
}

async function workersAI({ env, config, system, messages, stream, model, maxTokens, meta }) {
  if (!env.AI) throw new Error("Workers AI binding missing (wrangler.jsonc → \"ai\")");
  const input = {
    messages: [{ role: "system", content: system }, ...messages],
    max_tokens: budgetFor(model, maxTokens),
    stream,
  };
  const id = config.gateway?.id || "";
  const useGateway = id && Date.now() >= gatewayMissingUntil;
  const gw = useGateway
    ? { gateway: { id, skipCache: !(config.gateway.cacheTtl > 0), cacheTtl: config.gateway.cacheTtl || undefined } }
    : undefined;

  let result;
  try {
    result = gw ? await env.AI.run(model, input, gw) : await env.AI.run(model, input);
    meta.gateway = gw ? "via gateway" : id ? "direct (gateway missing)" : "direct (not configured)";
  } catch (err) {
    // Gateway Guardrails block: surface as a refusal, not a crash (codes 2016 / 2017).
    if (/2016|2017|blocked due to security/i.test(String(err?.message))) {
      const e = new Error("blocked-by-gateway"); e.code = "gateway-blocked"; throw e;
    }
    if (!gw) throw err;
    if (isGatewayMissing(err)) {
      gatewayMissingUntil = Date.now() + MISSING_RECHECK_MS;
      meta.gateway = "direct (gateway missing)";
      if (!warnedMissing) {
        warnedMissing = true;
        console.warn(`AI Gateway "${id}" doesn't exist on this account yet — calls are going direct (no logs, no spend limit). Create it: dashboard → AI → AI Gateway → Create Gateway, name it "${id}" (or the curl in docs/DEPLOY.md §D). Checked again in ${MISSING_RECHECK_MS / 60000} min. Error was: ${String(err?.message || err).slice(0, 160)}`);
      }
    } else {
      meta.gateway = "direct (gateway error)";
      console.error("gateway call failed, retrying direct", err?.message || err);
    }
    result = await env.AI.run(model, input);
  }
  lastGatewayStatus = meta.gateway;

  if (!stream) {
    if (result?.usage) meta.usage = result.usage;
    const text = extractText(result);
    // An empty reply is not an error anywhere in the stack, so it used to vanish:
    // the chat handler quietly swapped in the handoff line and the audit row looked
    // like a normal turn. Say what came back instead — keys only, never content.
    if (!text) {
      meta.empty = true;
      console.error("model returned no text", JSON.stringify({
        model, keys: result && typeof result === "object" ? Object.keys(result).slice(0, 12) : typeof result,
        outputTypes: Array.isArray(result?.output) ? result.output.map((o) => o?.type).slice(0, 8) : undefined,
        finish: result?.choices?.[0]?.finish_reason ?? result?.stop_reason ?? undefined,
      }));
    }
    return text;
  }
  // Streaming: Workers AI returns a ReadableStream of SSE lines.
  return sseTextChunks(result, (obj) => obj?.response ?? obj?.choices?.[0]?.delta?.content ?? obj?.delta?.text ?? "", meta);
}

// ------------------------------------------------------------------- OpenAI
async function openai({ env, config, system, messages, stream, model, maxTokens, meta }) {
  const key = env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY secret not set");
  const base = gatewayBase(config, "openai") || "https://api.openai.com/v1";
  lastGatewayStatus = meta.gateway = gatewayBase(config, "openai") ? "via gateway" : "direct (not configured)";
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: system }, ...messages],
      max_tokens: maxTokens,
      stream,
    }),
  });
  if (!res.ok) throw await httpError(res);
  if (!stream) {
    const data = await res.json();
    if (data?.usage) meta.usage = data.usage;
    return String(data?.choices?.[0]?.message?.content ?? "");
  }
  return sseTextChunks(res.body, (obj) => obj?.choices?.[0]?.delta?.content ?? "", meta);
}

// ---------------------------------------------------------------- Anthropic
// Raw Messages API over fetch (no SDK) so the Worker stays dependency-free and
// the request can be routed through AI Gateway's /anthropic path.
async function anthropic({ env, config, system, messages, stream, model, maxTokens, meta }) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY secret not set");
  const base = gatewayBase(config, "anthropic") || "https://api.anthropic.com";
  lastGatewayStatus = meta.gateway = gatewayBase(config, "anthropic") ? "via gateway" : "direct (not configured)";
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      system,
      messages,
      max_tokens: maxTokens,
      stream,
    }),
  });
  if (!res.ok) throw await httpError(res);
  if (!stream) {
    const data = await res.json();
    if (data?.usage) meta.usage = data.usage;
    if (data?.stop_reason === "refusal") {
      const e = new Error("refusal"); e.code = "model-refusal"; throw e;
    }
    return (data?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  }
  return sseTextChunks(res.body, (obj) =>
    obj?.type === "content_block_delta" && obj?.delta?.type === "text_delta" ? obj.delta.text : "",
    meta
  );
}

// ------------------------------------------------------------------ helpers

// Workers AI does not have one response shape. Most models answer in `response`;
// OpenAI-compatible ones in choices[].message.content; the gpt-oss family returns
// an `output` array holding a "reasoning" item AND a "message" item, and when the
// model spends its budget reasoning about a long input the first two fields come
// back empty while the real answer sits in the third. Reading only the first two
// turned those turns into a silent "I can't help with that one."
function extractText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  const direct = result.response ?? result.choices?.[0]?.message?.content;
  if (typeof direct === "string" && direct.trim()) return direct;
  if (Array.isArray(result.output)) {
    const parts = [];
    for (const item of result.output) {
      if (!item || item.type === "reasoning") continue;          // the thinking is not the answer
      const chunks = Array.isArray(item.content) ? item.content : [];
      for (const c of chunks) {
        if (typeof c?.text === "string" && (c.type === undefined || /text/.test(String(c.type)))) parts.push(c.text);
      }
      if (typeof item.text === "string") parts.push(item.text);
    }
    const joined = parts.join("").trim();
    if (joined) return joined;
  }
  if (typeof result.output_text === "string" && result.output_text.trim()) return result.output_text;
  return typeof direct === "string" ? direct : "";
}

function gatewayBase(config, provider) {
  const { id, accountId } = config.gateway || {};
  if (!id || !accountId) return null;
  return `https://gateway.ai.cloudflare.com/v1/${accountId}/${id}/${provider}`;
}

// Cloudflare does not tell a Worker what plan the account is on, but it does tell it when the
// free Workers AI allowance is gone — the call fails. Recognising that one case turns "the bot
// broke" into "today's free allowance is used up", which is the thing the owner can act on.
export function isAllowanceError(err) {
  const s = (String(err?.message || err || "") + " " + String(err?.code || "")).toLowerCase();
  return /neuron|quota|allowance|exceeded|limit reached|out of credit|capacity|3040|10000 request/.test(s);
}

async function httpError(res) {
  let detail = "";
  try { detail = (await res.text()).slice(0, 300); } catch {}
  const e = new Error(`${res.status} from provider: ${detail}`);
  if (res.status === 429) e.code = "rate-limited";
  return e;
}

// Turn an SSE body into an async iterator of text chunks. If a chunk carries
// token counts (Workers AI and OpenAI put them on the last one), keep them on meta.
async function* sseTextChunks(body, pick, meta = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const obj = JSON.parse(payload);
        if (obj?.usage) meta.usage = obj.usage;
        const text = pick(obj);
        if (text) yield text;
      } catch { /* partial line; ignore */ }
    }
  }
}
