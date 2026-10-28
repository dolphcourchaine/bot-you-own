// ============================================================================
//  WHAT IT COST TODAY
//
//  Engine/worker/router.js already counts turns and tokens, but only in memory:
//  a Worker isolate lives minutes, so the numbers vanish and nobody ever sees
//  them. This keeps one row per day per model in D1 and prices it, so "your
//  account, your bill" stops being a line in the footer and becomes a number.
//
//  Cloudflare does not tell a Worker whether the account is on the free or the
//  paid plan — there is no runtime API for it, and the account-level billing
//  API needs a token no template should ship. So instead of guessing the plan,
//  this reports the two things that actually matter: what has been spent today,
//  and whether the free Workers AI allowance has run out (which the model call
//  itself tells us, by failing in a way we can recognise).
//
//  Fail-open, like the audit log: no DB, or a write that fails, and the bot
//  answers exactly as before. Nothing here is on the path to a reply.
// ============================================================================

// Workers AI list prices, USD per million tokens. A snapshot taken 2026-09-18 from
// developers.cloudflare.com/workers-ai/platform/pricing — Cloudflare changes this
// catalogue often, so treat a number here as "about right", not as a bill. An
// unknown model prices at 0 and is shown as unpriced rather than guessed at.
export const PRICES = {
  "@cf/meta/llama-4-scout-17b-16e-instruct":     { in: 0.270, out: 0.850 },
  "@cf/google/gemma-4-26b-a4b-it":               { in: 0.100, out: 0.300 },
  "@cf/zai-org/glm-5.3-flash":                   { in: 0.150, out: 0.500 },
  "@cf/openai/gpt-oss-120b":                     { in: 0.350, out: 0.750 },
  "@cf/openai/gpt-oss-20b":                      { in: 0.200, out: 0.300 },
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast":    { in: 0.293, out: 2.253 },
  "@cf/meta/llama-3.2-11b-vision-instruct":      { in: 0.049, out: 0.676 },
  "@cf/mistralai/mistral-small-3.1-24b-instruct":{ in: 0.351, out: 0.555 },
  "@cf/qwen/qwen3.8-27b":                        { in: 0.450, out: 3.200 },
  "@cf/qwen/qwen2.5-coder-32b-instruct":         { in: 0.660, out: 1.000 },
  "@cf/deepseek-ai/deepseek-v4-flash-0731":      { in: 0.440, out: 1.320 },
  "@cf/deepseek-ai/deepseek-v4-pro-0813":        { in: 1.320, out: 3.960 },
  "@cf/moonshotai/kimi-k2.6":                    { in: 0.950, out: 4.000 },
  "@cf/moonshotai/kimi-k2.7-code":               { in: 0.950, out: 4.000 },
  "@cf/moondream/moondream3.1-9B-A2B":           { in: 0.300, out: 1.000 },
  // Clef (decision models, 2026-09-29): billed on input only — the catalogue lists no output price.
  "@cf/cloudflare/clef":                         { in: 0.240, out: 0 },
  "@cf/cloudflare/clef-flash":                   { in: 0.090, out: 0 },
};

// Workers Free: 100,000 requests a day across the whole account. Documented, not
// readable at runtime — so it is a yardstick to show against, not a limit we enforce.
export const FREE_REQUESTS_PER_DAY = 100000;

export const priceOf = (model) => PRICES[String(model || "").trim()] || null;
const today = () => new Date().toISOString().slice(0, 10);

let SCHEMA = false;
async function ensure(env) {
  if (SCHEMA || !env.DB) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS usage_days (date TEXT NOT NULL, model TEXT NOT NULL, turns INTEGER NOT NULL DEFAULT 0,
     in_tokens INTEGER NOT NULL DEFAULT 0, out_tokens INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (date, model))`
  ).run();
  SCHEMA = true;
}

// One turn. `usage` is whatever the provider reported; both shapes are seen in the wild.
export async function recordUsage(env, { model, usage = null, error = false } = {}) {
  if (!env.DB) return;
  try {
    await ensure(env);
    const inTok = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0) || 0;
    const outTok = Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0) || 0;
    await env.DB.prepare(
      `INSERT INTO usage_days (date, model, turns, in_tokens, out_tokens, errors) VALUES (?, ?, 1, ?, ?, ?)
       ON CONFLICT(date, model) DO UPDATE SET turns = turns + 1, in_tokens = in_tokens + excluded.in_tokens,
       out_tokens = out_tokens + excluded.out_tokens, errors = errors + excluded.errors`
    ).bind(today(), String(model || "(unknown)").slice(0, 120), inTok, outTok, error ? 1 : 0).run();
  } catch (err) {
    console.error("usage write failed (continuing)", err?.message || err);
  }
}

// Today, and the last N days, priced. Admin only — it is a bill, not a visitor's business.
export async function usageReport(env, days = 7) {
  if (!env.DB) return { ok: false, reason: "No database bound, so nothing is counted." };
  try {
    await ensure(env);
    const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
    const rows = (await env.DB.prepare(
      `SELECT date, model, turns, in_tokens, out_tokens, errors FROM usage_days WHERE date >= ? ORDER BY date DESC, turns DESC`
    ).bind(since).all()).results || [];
    const price = (r) => {
      const p = priceOf(r.model);
      if (!p) return null;
      return (r.in_tokens / 1e6) * p.in + (r.out_tokens / 1e6) * p.out;
    };
    const withCost = rows.map((r) => ({ ...r, usd: price(r), priced: Boolean(priceOf(r.model)) }));
    const sum = (list) => list.reduce((a, r) => ({
      turns: a.turns + r.turns, in_tokens: a.in_tokens + r.in_tokens, out_tokens: a.out_tokens + r.out_tokens,
      errors: a.errors + r.errors, usd: a.usd + (r.usd || 0), unpriced: a.unpriced + (r.priced ? 0 : r.turns),
    }), { turns: 0, in_tokens: 0, out_tokens: 0, errors: 0, usd: 0, unpriced: 0 });
    const t = today();
    return {
      ok: true, today: t, days,
      todayTotals: sum(withCost.filter((r) => r.date === t)),
      periodTotals: sum(withCost),
      rows: withCost,
      freeRequestsPerDay: FREE_REQUESTS_PER_DAY,
      note: "List prices, snapshotted 2026-09-18. Cloudflare does not expose the account's plan to a Worker, so this is what was used — not which tier you are on.",
    };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err).slice(0, 200) };
  }
}
