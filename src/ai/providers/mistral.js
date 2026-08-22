// Mistral primary-regime provider (OpenAI-compatible chat completions).
//
// Same responsibility boundary as the other providers: HTTP, auth, request
// shape, response extraction, usage, timeout/error propagation — and nothing
// else. It does NOT parse regime JSON; parseRegimeResponse() in regime.js
// stays the single parser for every provider, so Mistral's formatting goes
// through the same validated path with no weakened validation.
//
// The canonical SYSTEM_PROMPT is imported (never copied) and the market
// summary is serialized exactly as for the other providers. Temperature is
// deliberately left unset, matching the existing calls.
import { config } from '../../config.js';
import { SYSTEM_PROMPT } from '../prompt.js';

export const mistralProvider = {
  name: 'mistral',

  keyEnvVar: 'MISTRAL_API_KEY',
  isConfigured() {
    return Boolean(config.mistralApiKey);
  },

  // Model-selection rule, identical across every primary provider: an
  // explicitly set AI_MODEL wins; otherwise this provider's own default.
  // config.aiModelOverride is the RAW AI_MODEL (empty when unset), so the
  // Anthropic-flavoured fallback in config.aiModel can never leak in here.
  get model() {
    return config.aiModelOverride || config.mistralModel;
  },

  /**
   * @returns {Promise<{provider: string, model: string, text: string,
   *   usage: {inputTokens: number, outputTokens: number}, reportedModel: string|null}>}
   * `fetchImpl` is injectable purely for unit tests; production passes nothing.
   */
  async complete({ summary, maxTokens = config.aiMaxOutputTokens, fetchImpl = fetch } = {}) {
    const model = this.model; // single source of the selection rule

    const res = await fetchImpl(`${config.mistralBase}/chat/completions`, {
      method: 'POST',
      // Same deadline mechanism as every other AI request — no second timeout system.
      signal: AbortSignal.timeout(config.aiRequestTimeoutMs),
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        // Bearer header only. A key in a query string leaks into logs,
        // proxies and error messages.
        authorization: `Bearer ${config.mistralApiKey}`,
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
      throw new Error(`Mistral API ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = await res.json();
    const choice = (data.choices || [])[0];
    if (!choice) {
      throw new Error(`Mistral API returned no choice (${data.object ?? 'no_choices'})`);
    }

    // ONLY message.content. Mistral returns it either as a plain string or,
    // on newer API versions, as an array of typed chunks — handle both, and
    // drop any `thinking`/reasoning chunk: hidden chain-of-thought is never
    // extracted and never persisted.
    const content = choice.message?.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((c) => c && c.type !== 'thinking' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('');
    }

    // Usage is OpenAI-shaped. Absent usage reads as 0 — the same safe
    // representation the other providers use; token counts are never invented.
    // NOTE: cost is still computed with the repo's Anthropic pricing
    // constants; provider-specific pricing is a later step.
    const usage = data.usage || {};
    return {
      provider: 'mistral',
      model, // the CONFIGURED model is the authoritative experiment identifier
      text,
      usage: {
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
      },
      // What Mistral says it actually served, for verification only — never
      // substituted for `model` above. Useful because '-latest' aliases
      // resolve to a concrete version server-side.
      reportedModel: typeof data.model === 'string' ? data.model : null,
    };
  },
};

export default mistralProvider;
