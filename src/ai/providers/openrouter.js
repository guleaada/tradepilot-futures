// OpenRouter primary-regime provider (OpenAI-compatible chat completions).
//
// Same responsibility boundary as anthropic.js / gemini.js: HTTP, auth,
// request shape, response extraction, usage, timeout/error propagation — and
// nothing else. It does NOT parse regime JSON; parseRegimeResponse() in
// regime.js stays the single parser for every provider, so OpenRouter's
// formatting quirks go through the same validated path with no weakened
// validation.
//
// The canonical SYSTEM_PROMPT is imported (never copied) and the market
// summary is serialized exactly as for the other providers. Only the envelope
// differs — OpenAI-style `messages[]` with a system role — because the API
// requires it. Temperature is deliberately left unset, matching the existing
// Anthropic/Gemini calls.
import { config } from '../../config.js';
import { SYSTEM_PROMPT } from '../prompt.js';

export const openrouterProvider = {
  name: 'openrouter',

  keyEnvVar: 'OPENROUTER_API_KEY',
  isConfigured() {
    return Boolean(config.openrouterApiKey);
  },

  // Generic AI_MODEL wins when explicitly set; otherwise the OpenRouter
  // default. Read at call time so env/test overrides take effect.
  get model() {
    return config.aiModelOverride || config.openrouterModel;
  },

  /**
   * @returns {Promise<{provider: string, model: string, text: string,
   *   usage: {inputTokens: number, outputTokens: number}, reportedModel: string|null}>}
   * `fetchImpl` is injectable purely for unit tests; production passes nothing.
   */
  async complete({ summary, maxTokens = config.aiMaxOutputTokens, fetchImpl = fetch } = {}) {
    const model = this.model;

    const res = await fetchImpl(`${config.openrouterBase}/chat/completions`, {
      method: 'POST',
      // Same deadline mechanism as every other AI request — no second timeout system.
      signal: AbortSignal.timeout(config.aiRequestTimeoutMs),
      headers: {
        'content-type': 'application/json',
        // Bearer header only. A key in a query string leaks into logs,
        // proxies and error messages.
        authorization: `Bearer ${config.openrouterApiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT }, // the one canonical prompt
          { role: 'user', content: JSON.stringify(summary) },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenRouter API ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = await res.json();
    // OpenRouter can answer HTTP 200 with an error envelope (upstream provider
    // failures, moderation). Treat it as a provider error, not as a completion.
    if (data.error) {
      const msg = typeof data.error === 'string' ? data.error : (data.error.message ?? JSON.stringify(data.error));
      throw new Error(`OpenRouter API error: ${String(msg).slice(0, 300)}`);
    }

    const choice = (data.choices || [])[0];
    if (!choice) {
      throw new Error(`OpenRouter API returned no choice (${data.finish_reason ?? 'no_choices'})`);
    }

    // ONLY message.content. Some models also return `message.reasoning` /
    // `reasoning_details` — hidden chain-of-thought that is deliberately never
    // extracted and never persisted.
    const text = typeof choice.message?.content === 'string' ? choice.message.content : '';

    // Usage is OpenAI-shaped. Absent usage reads as 0 — the same safe
    // representation the other providers use; token counts are never invented.
    // NOTE: cost is still computed with the repo's Anthropic pricing
    // constants; provider-specific pricing is a later step.
    const usage = data.usage || {};
    return {
      provider: 'openrouter',
      model, // the CONFIGURED model is the authoritative experiment identifier
      text,
      usage: {
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
      },
      // What OpenRouter says it actually served, for verification only. It is
      // never substituted for `model` above — silently rewriting attribution
      // would corrupt the experiment.
      reportedModel: typeof data.model === 'string' ? data.model : null,
      // OpenRouter's generation id. Used ONLY to look up the actual billed
      // cost later via GET /api/v1/generation; it never affects the estimate,
      // the attribution, or any trading decision.
      generationId: typeof data.id === 'string' ? data.id : null,
    };
  },
};

export default openrouterProvider;
