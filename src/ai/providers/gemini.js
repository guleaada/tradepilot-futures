// Google Gemini primary-regime provider.
//
// Same responsibility boundary as the Anthropic provider: HTTP, auth, request
// shape, response extraction, usage, timeout/error propagation — and nothing
// else. It does NOT parse the regime JSON: parseRegimeResponse() in regime.js
// remains the single parser for every provider, so Gemini's formatting quirks
// (code fences, prose around the JSON) are handled by the same validated path
// as Anthropic's, with no weakened validation.
//
// The prompt and the user content are byte-identical to the Anthropic call —
// the canonical SYSTEM_PROMPT is imported, never copied, and the market
// summary is serialized the same way. Only the envelope differs, because the
// API demands it: Gemini takes `systemInstruction` + `contents[]` where
// Anthropic takes `system` + `messages[]`.
import { config } from '../../config.js';
import { SYSTEM_PROMPT } from '../prompt.js';

export const GEMINI_API_VERSION = 'v1beta';

export const geminiProvider = {
  name: 'gemini',

  keyEnvVar: 'GEMINI_API_KEY',
  isConfigured() {
    return Boolean(config.geminiApiKey);
  },

  // Model-selection rule, identical across every primary provider: an
  // explicitly set AI_MODEL wins; otherwise this provider's own default.
  // (config.aiModelOverride is the RAW AI_MODEL — empty when unset — so the
  // Anthropic-flavoured fallback baked into config.aiModel can never leak in
  // here and override a provider default.) Read at call time so env/test
  // overrides take effect.
  get model() {
    return config.aiModelOverride || config.geminiModel;
  },

  /**
   * @returns {Promise<{provider: string, model: string, text: string,
   *   usage: {inputTokens: number, outputTokens: number}}>}
   * `fetchImpl` is injectable purely for unit tests; production passes nothing.
   */
  async complete({ summary, maxTokens = config.aiMaxOutputTokens, fetchImpl = fetch } = {}) {
    const model = this.model; // single source of the selection rule
    const url = `${config.geminiBase}/${GEMINI_API_VERSION}/models/${encodeURIComponent(model)}:generateContent`;

    const generationConfig = { maxOutputTokens: maxTokens };
    // Only sent when explicitly configured (see config.geminiThinkingBudget).
    if (Number.isFinite(config.geminiThinkingBudget)) {
      generationConfig.thinkingConfig = { thinkingBudget: config.geminiThinkingBudget };
    }

    const res = await fetchImpl(url, {
      method: 'POST',
      // Same deadline mechanism as every other AI request — no second timeout system.
      signal: AbortSignal.timeout(config.aiRequestTimeoutMs),
      headers: {
        'content-type': 'application/json',
        // Header auth, never a query string: a key in a URL leaks into logs,
        // proxies and error messages.
        'x-goog-api-key': config.geminiApiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] }, // the one canonical prompt
        contents: [{ role: 'user', parts: [{ text: JSON.stringify(summary) }] }],
        generationConfig,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gemini API ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = await res.json();
    const candidate = (data.candidates || [])[0];
    if (!candidate) {
      // Safety block or an otherwise empty completion. This is a PROVIDER
      // failure, not a parse failure — surface it so the engine takes its
      // normal safe-fallback path rather than pretending we got an opinion.
      const reason = data.promptFeedback?.blockReason ?? data.candidates?.[0]?.finishReason ?? 'no_candidates';
      throw new Error(`Gemini API returned no candidate (${reason})`);
    }

    // Concatenate visible text parts only. Parts flagged `thought: true` are
    // the model's hidden reasoning — never extracted, never persisted.
    const text = (candidate.content?.parts || [])
      .filter((p) => p && typeof p.text === 'string' && p.thought !== true)
      .map((p) => p.text)
      .join('');

    // Gemini reports usage as promptTokenCount / candidatesTokenCount, plus
    // thoughtsTokenCount for internal reasoning. Hidden thinking tokens are
    // billed as output, so they belong in outputTokens for honest accounting.
    // Missing usage reads as 0 — the same safe representation the Anthropic
    // provider uses; token counts are never invented.
    const usage = data.usageMetadata || {};
    return {
      provider: 'gemini',
      model,
      text,
      usage: {
        inputTokens: usage.promptTokenCount ?? 0,
        outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
      },
    };
  },
};

export default geminiProvider;
