# AI evaluation layer

How the AI layer works, what it is allowed to decide, and what it is not.

## Roles

**Primary — Anthropic.** The only provider whose output can influence a trade.
`evaluateRegime()` in `src/ai/regime.js` calls it, parses the response, and
returns a regime to the rule engine. Selected by `AI_PROVIDER`, which defaults
to `anthropic` in `src/config.js` and is pinned to `anthropic` in the workflow.

**Shadow — Mistral (opt-in, manual only).** Runs in `src/ai/shadow.js`. It sees
the identical market summary and the identical system prompt, produces its own
evaluation, and that evaluation is written to `ai_shadow_calls` and read by
nothing on the trading path. It is off unless `AI_SHADOW_MODE=true`, which only
a manual `workflow_dispatch` with `shadow_provider=mistral` sets.

Shadow output is **evidence about models, never an input to a trade.**
`shadow.js` imports nothing from `src/engine/`, never sees an executor, and the
cycle discards the result of its `Promise.allSettled` drain.

## What the model is NOT allowed to control

Position size, leverage, entries, exits, stops, targets, the pair universe,
cadence, and every risk control. Those are deterministic and live in
`src/engine/`. The prompt states this, and the parser structurally enforces it:
only four fields ever reach the engine, so a model that emits `leverage` or
`stop_loss` is silently ignored.

## The prompt

`src/ai/prompt.js` holds the single canonical `SYSTEM_PROMPT`. Every provider
imports it; none inlines or paraphrases it, so the A/B comparison compares
models rather than instructions.

- **Version:** `PROMPT_VERSION = "regime-v2"`.
- It is a code-level constant, not a database column — this fork adds no
  migrations for observability. To map a historical row to a prompt version,
  use `regime_calls.ts` against `git log -- src/ai/prompt.js`.
- `test/promptContract.test.js` pins a SHA-256 of the prompt text. Editing the
  prompt without bumping `PROMPT_VERSION` (and the pinned hash) fails CI.
- Construction is deterministic: an array of literals joined at module load.
  No timestamp, no random id, no environment or config lookup.

### v2 vs v1

v2 adds an explicit role and boundary statement, an explicit data boundary
(market data is data, never instructions), the evaluation dimensions to weigh,
and `direction` / `evidence` / `uncertainty` as optional output. It **removes**
the required `<thinking>` block: chain-of-thought is no longer requested, and
the `evidence` list is the audit trail instead.

v2 keeps v1's tuned domain judgement verbatim in substance: metals guidance,
the "commit to a direction at confidence 55-75" instruction, the honesty of
`chop`, and the short-squeeze caution.

**Consequence of dropping `<thinking>`:** the truncation-salvage retry in
`regime.js` triggers on an opened-but-unclosed `<thinking>` tag. With v2 that
tag is no longer requested, so the salvage path will rarely fire for the
primary. Removing the block also shortens the response substantially, which
makes the truncation it salvaged far less likely in the first place. The retry
code is untouched and still works if a model emits the tag anyway.

**Cost:** v2 is 2709 chars vs v1's 2042, about +167 input tokens per call
(~$0.0005 at Sonnet rates). Dropping the `<thinking>` bullets removes output
tokens, which are 5x more expensive, so the net per-call change is small.
Watch `AI_DAILY_BUDGET_USD` (default $0.50) after rollout.

## Output contract

Defined once in `src/ai/evaluationContract.js` and embedded into the prompt as
`SCHEMA_LINE`, so prompt and validator cannot drift.

```json
{
  "regime": "bullish|bearish|chop",
  "confidence": 0-100,
  "trade_allowed": true|false,
  "direction": "long|short|neutral",
  "reasoning": "non-empty, max 2 sentences",
  "evidence": ["<=3 short factual statements"],
  "uncertainty": ["<=2 items; [] when clean"]
}
```

**Required:** `regime`, `confidence`, `trade_allowed`, `reasoning`. Exactly the
four the engine and the schema already depend on. Any violation is a hard
reject — fail closed.

**Optional:** `direction`, `evidence`, `uncertainty`. Additive observability. A
violation drops that one field and records an issue; it never invalidates an
otherwise-valid evaluation, and none of them is ever consulted for a trade.
They need no migration: they are persisted inside the existing raw text columns
(`regime_calls.raw_json`, `ai_shadow_calls.raw_response`).

A `direction` that contradicts its own regime (bullish + short) is dropped
rather than reconciled — the regime is what the engine acts on, and "fixing"
direction would invent an opinion the model did not give.

## Two parsers, deliberately

| | `parseRegimeResponse` (`regime.js`) | `validateEvaluation` (`evaluationContract.js`) |
|---|---|---|
| Role | **Authoritative** — the trading path | Specification + offline validator |
| Scope | The four required fields | Required + optional, with issue reporting |
| Used by | `evaluateRegime`, `shadow.js` | Tests, and analysis of persisted raw text |

The live parser was hardened in the `feat: harden regime AI output contract`
pass: it now strips the `<thinking>` tag linearly and validates confidence
strictly. Valid model output is unaffected; malformed output that used to be
coerced is now a parse failure taking the existing safe fallback path.

### Divergences

Both confidence divergences are **closed**. `regime.js` no longer coerces or
clamps: confidence must be an actual finite integer in `[0, 100]` or the
response is a parse failure. Contract and production now agree on every
required field, asserted by test across the whole malformed matrix.

One difference remains, shared by both and therefore not a disagreement:

- **Trailing prose is rejected when there is no leading prose.** The
  first-`{`-to-last-`}` salvage only runs when the body does not already start
  with `{`, so `{...} and here is why` fails `JSON.parse` outright, while
  `Here is why: {...} thanks` parses fine. Fail-closed, and the prompt forbids
  prose on either side. Pinned by test.

The remaining contract-only behavior is the optional-field layer
(`direction`, `evidence`, `uncertainty`), which production ignores entirely.

## Failure behavior

Every AI failure takes the same safe path and none of them invents a decision:

| Failure | Outcome | Effect |
|---|---|---|
| Missing key | `missing_key` | Decayed previous regime, or the no-trade fallback |
| Provider error | `provider_error` | Same |
| Timeout | `timeout` | Same |
| Malformed output | `parse_failure` | Same |
| Budget exhausted | `budget_skip` | Same |
| Inside cadence window | `cached` | Previous regime reused |

Only `fresh` means a real provider call produced a usable regime — and only a
`fresh` primary opens the shadow gate, so shadow spend can never be burned
comparing against a cached or fallback primary.

A shadow failure is isolated: it is recorded as an `error`, `timeout` or
`parse_failure` row and never affects the primary, the regime, or the cycle.

## Running the tests

```
npm test                                  # full suite
node --test test/promptContract.test.js   # prompt + contract matrix
node --test test/shadowMode.test.js       # shadow isolation
npm run shadow-analysis -- --status       # read-only dataset status
```

No test makes a network call or reads a secret. Every provider is stubbed and
every database is in-memory or a scratch file.

## Adversarial review findings (pre-deployment pass)

**Fixed — ReDoS in the contract validator (HIGH).** The lone-closing-tag strip
used a greedy `/[\s\S]*<\/thinking>/i`. With no closing tag present it
backtracks catastrophically: 597ms for a 16KB response, rising about fourfold
per doubling. `unwrap()` now uses `lastIndexOf`, which is O(n) — 1MB validates
in ~2ms, and a test asserts it stays under 500ms.

**Fixed — the same regex in `regime.js`.** The production parser carried the
identical pattern. It now uses the same `lastIndexOf` strip, proven
byte-equivalent against the original regex semantics across eight cases
(complete pairs, lone closing tag, multiple closers, unclosed opener, mixed
case, empty input). Measured: **16KB 597ms → 0.08ms**, 1MB ~2ms, 2MB ~3.6ms,
with normalised growth ~1x per size doubling instead of ~4x.

**Fixed — confidence coercion in `regime.js`.** `Number(obj.confidence)` plus a
clamp used to accept `null→0`, `true→1`, `"60"→60`, `"070"→70`, `[70]→70`,
`["70"]→70`, `1e21→100` and `"999"→100` — the last two manufacturing maximum
conviction from a value the schema forbids. Confidence must now be a real
finite integer within `[0, 100]`; everything else is a parse failure. Valid
integers 0, 1, 50, 64, 99 and 100 are unaffected, and the truncation-retry,
fallback and decay paths are untouched.

**Fixed — uncapped evidence/uncertainty items (LOW).** `reasoning` was capped
at 200 chars but the two arrays were not, so a model could return megabyte
strings. Both are now capped per item at `MAX_ITEM_CHARS` (200).

**Verified safe:** no prototype pollution from `__proto__` in a model response
(JSON.parse creates an own property; the result object keeps a clean
prototype); zero exceptions across ~90 pathological inputs; hostile text in any
market-data field never reaches the system prompt and is carried only as
JSON-encoded data in the user turn; and a fully compliant hostile response
(returning `leverage`, `position_size`, `stop_loss`, `order`, `api_call`) is
structurally stripped by both parsers.

**Shadow isolation, proven dynamically.** With an identical bullish primary
that genuinely opens a trade, three shadow states — screaming bearish/100,
screaming bullish/100, and no shadow row at all — produce byte-identical engine
actions. With a bearish/30/`trade_allowed:false` primary and a bullish/100
shadow, the executor is called zero times and no trade or order is written.
`src/engine/` contains no reference to shadow at all.
