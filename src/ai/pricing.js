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
    // Mistral Large 3, pinned away from the moving 'mistral-large-latest'
    // alias so regime_calls.model identifies exactly what ran.
    // 'mistral-large-2512' is the API model id (date-suffix convention, cf.
    // the deprecated 'mistral-large-2411' = Nov 2024).
    //
    // Price verified from Mistral's official pricing page: "Mistral Large
    // costs $0.5 /M tokens in and $1.5 /M tokens out".
    //
    // This is the ONLY priced Mistral entry. The documentation-style handle
    // 'mistral-large-3-25-12' is deliberately NOT registered: it is not the
    // API model id, and pricing a string the API does not accept would put a
    // confident cost against a call that never happens. It therefore resolves
    // to 'unknown' like any other unrecognised model.
    'mistral-large-2512': {
      inputPerMTok: 0.50, outputPerMTok: 1.50,
      verifiedOn: '2026-08-21', source: 'mistral.ai/pricing',
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
