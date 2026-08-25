// THE canonical AI pricing registry — the only place model prices live.
//
// Design rules, in order of importance:
//   1. There is NO default and NO fallback price. An unrecognised
//      (provider, model) pair resolves to status 'unknown' with null rates.
//      A provider can never silently inherit another provider's pricing —
//      the bug this module exists to make impossible.
//   2. Prices are keyed by BOTH provider and model. Selecting a model with
//      AI_MODEL therefore selects its price too; an unknown override is
//      priced as unknown, never at the provider's default-model rate.
//   3. Nothing here is inferred from a model NAME. 'claude-sonnet-5' does not
//      inherit 'claude-sonnet-4-6' pricing just because the strings look
//      alike; every entry is an explicit, separately verified fact.
//   4. Prices are NOT env-configurable. A price is a verified external fact
//      with a date, not a tunable — an env var would let a typo silently
//      corrupt every cost figure in the experiment.
//
// `verifiedOn` is the date the rate was last checked against the provider's
// official pricing page. Treat an old date as a prompt to re-verify: vendors
// change prices, and a stale number is a wrong number.

export const PRICING_STATUS = Object.freeze({
  EXACT: 'exact',     // priced, and the price was verified recently
  STALE: 'stale',     // priced, but the verification is older than the threshold
  UNKNOWN: 'unknown', // no verified price for this (provider, model)
});

// A price older than this is reported as STALE. 90 days is chosen because
// frontier-model prices have historically moved on roughly a quarterly
// cadence (Claude Sonnet 5 shipped at $2/$10 against Sonnet 4.6's $3/$15
// inside such a window), so a quarter is long enough to avoid noise and short
// enough that a silently-wrong cost figure cannot survive a whole experiment.
// STALE still produces a cost — an old price is a far better estimate than no
// estimate — but it is flagged so the number is never mistaken for verified.
export const PRICING_FRESHNESS_DAYS = 90;

// provider -> model -> { inputPerMTok, outputPerMTok, verifiedOn, source }
// USD per 1,000,000 tokens.
export const PRICING = Object.freeze({
  anthropic: {
    // Thinking tokens are billed as output tokens; the repo sends no
    // cache_control, so prompt-cache tiers do not apply.
    'claude-sonnet-4-6': {
      inputPerMTok: 3.00, outputPerMTok: 15.00,
      verifiedOn: '2026-08-21', source: 'platform.claude.com/docs/en/about-claude/pricing',
    },
  },
  gemini: {
    // Thinking tokens are INCLUDED in the output price, and the API reports
    // thoughtsTokenCount separately from candidatesTokenCount — which is why
    // the Gemini provider sums the two into outputTokens.
    // CURRENT production model. Verified 2026-08-25 against Google's official
    // pricing page: "Input price ... $0.75 through December 31, 2026" and
    // "Output price (including thinking tokens) ... $3.75 through December 31,
    // 2026". Thinking tokens are billed as OUTPUT, which is exactly how the
    // Gemini provider reports them (thoughtsTokenCount summed into
    // outputTokens), so outputPerMTok applies to them correctly.
    //
    // LIMITATION: Google has published a scheduled increase to $1.50/$7.50 on
    // 2027-01-01. This registry stores one rate per (provider, model) and
    // cannot express a future-dated change. The staleness threshold
    // (PRICING_FRESHNESS_DAYS = 90) flags this entry from ~2026-11-23, before
    // the increase takes effect, so the wrong rate cannot silently survive it.
    // Context caching ($0.075/MTok) is deliberately not modelled: this repo
    // sends no caching directives, so a cache hit only makes the real bill
    // lower than est_cost.
    'gemini-3.6-flash': {
      inputPerMTok: 0.75, outputPerMTok: 3.75,
      verifiedOn: '2026-08-25', source: 'ai.google.dev/gemini-api/docs/pricing',
    },
    // Retained for HISTORICAL rows only: this id returns 404 for this account
    // as of 2026-08-25. Removing it would make already-recorded costs unknown.
    'gemini-2.5-flash': {
      inputPerMTok: 0.30, outputPerMTok: 2.50,
      verifiedOn: '2026-08-21', source: 'ai.google.dev/gemini-api/docs/pricing',
    },
  },
  openrouter: {
    // Priced by the REQUESTED model: that is the experimental variable and it
    // is what regime_calls.model records. OpenRouter may route the request to
    // any of several upstream providers (captured as reported_model), but the
    // requested model is what keeps a run reproducible.
    'meta-llama/llama-3.3-70b-instruct': {
      inputPerMTok: 0.10, outputPerMTok: 0.32,
      verifiedOn: '2026-08-21', source: 'openrouter.ai/meta-llama/llama-3.3-70b-instruct',
    },
  },
  mistral: {
    // Mistral Large 3. Re-verified 2026-08-22 (UTC) against Mistral's own docs: the
    // model card publishes this model's API names as
    //   {"names":["mistral-large-2512","mistral-large-latest"]}
    // so 'mistral-large-2512' IS the concrete API model id and
    // 'mistral-large-latest' is its MOVING alias. 'mistral-large-3-25-12' is
    // only the docs URL slug (docs.mistral.ai/models/mistral-large-3-25-12),
    // never an API id. Neither the alias nor the slug is registered here:
    // both resolve to 'unknown', like any other unrecognised model.
    //
    // Rates are from the official per-model pricing table, which lists
    // Mistral Large 3 at input $0.5, cached input $0.05, output $1.5 per MTok.
    // Only the STANDARD input rate is registered: this repo sends no caching
    // directives, so a server-side cache hit can only make the real bill lower
    // than est_cost. The estimate is an upper bound, never optimistic.
    //
    // Thinking/reasoning chunks are stripped from the response TEXT, but their
    // tokens remain in usage.completion_tokens and are billed as output —
    // exactly how outputPerMTok is applied here.
    'mistral-large-2512': {
      inputPerMTok: 0.50, outputPerMTok: 1.50,
      verifiedOn: '2026-08-22', source: 'docs.mistral.ai/inference/pricing',
    },
  },
});

/**
 * Resolve the price for an exact (provider, model) pair.
 * Never guesses, never falls back to another provider or model.
 *
 * `now` is injectable purely so freshness can be tested deterministically.
 *
 * @returns {{inputPerMTok: number|null, outputPerMTok: number|null,
 *   status: 'exact'|'stale'|'unknown', verifiedOn: string|null,
 *   ageDays: number|null}}
 */
export function resolvePricing(provider, model, now = new Date()) {
  const entry = PRICING[String(provider ?? '').toLowerCase()]?.[model];
  if (!entry) {
    return {
      inputPerMTok: null, outputPerMTok: null,
      status: PRICING_STATUS.UNKNOWN, verifiedOn: null, ageDays: null,
    };
  }
  const verifiedMs = Date.parse(entry.verifiedOn);
  // An unparseable date is treated as stale, not fresh: the failure mode of a
  // malformed entry must be "flag it", never "silently trust it".
  const ageDays = Number.isFinite(verifiedMs)
    ? (now.getTime() - verifiedMs) / 86_400_000
    : Infinity;
  return {
    inputPerMTok: entry.inputPerMTok,
    outputPerMTok: entry.outputPerMTok,
    status: ageDays > PRICING_FRESHNESS_DAYS ? PRICING_STATUS.STALE : PRICING_STATUS.EXACT,
    verifiedOn: entry.verifiedOn,
    ageDays: Number.isFinite(ageDays) ? ageDays : null,
  };
}

// Flat listing, for tests and audits (e.g. staleness checks).
export function listPricedModels() {
  return Object.entries(PRICING).flatMap(([provider, models]) =>
    Object.entries(models).map(([model, entry]) => ({ provider, model, ...entry })));
}
