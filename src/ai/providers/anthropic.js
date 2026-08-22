// Anthropic primary-regime provider.
//
// Responsibility boundary (deliberately narrow): HTTP, auth, request shape,
// response extraction, usage, timeout/error propagation. It does NOT parse the
// regime JSON and does NOT know what a "regime" is — parseRegimeResponse() in
// regime.js owns that, so every provider funnels through one parser and one
// set of fallback semantics.
//
// Behavior here is a verbatim lift of the previous inline callClaude(): same
// endpoint, same anthropic-version, same model/max_tokens, no temperature
// (unset, as before), same Step-1 AbortSignal deadline, same thrown Error
// shape on a non-2xx so the existing safe-fallback path is unchanged.
import { config } from '../../config.js';
import { SYSTEM_PROMPT } from '../prompt.js';

export const ANTHROPIC_VERSION = '2023-06-01';

export const anthropicProvider = {
  name: 'anthropic',

  // Credential contract, declared by the provider so the regime engine's
  // pre-flight check works for ANY provider instead of hard-coding one key.
  keyEnvVar: 'ANTHROPIC_API_KEY',
  isConfigured() {
    return Boolean(config.anthropicApiKey);
  },

  // Model-selection rule, identical across every primary provider: an
  // explicitly set AI_MODEL wins; otherwise this provider's own default.
  // config.aiModel already encodes exactly that (AI_MODEL || the Anthropic
  // default), so it is used directly here. Read at call time so env/test
  // overrides take effect.
  get model() {
    return config.aiModel;
  },

  /**
   * @returns {Promise<{provider: string, model: string, text: string,
   *   usage: {inputTokens: number, outputTokens: number}}>}
   * `fetchImpl` is injectable purely for unit tests; production passes nothing.
   */
  async complete({ summary, maxTokens = config.aiMaxOutputTokens, fetchImpl = fetch } = {}) {
    const model = this.model; // single source of the selection rule
    const res = await fetchImpl(`${config.anthropicBase}/v1/messages`, {
      method: 'POST',
      // Bounded deadline: a hung provider socket must never stall the cycle.
      signal: AbortSignal.timeout(config.aiRequestTimeoutMs),
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.anthropicApiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: SYSTEM_PROMPT, // the one canonical prompt — never inlined here
        messages: [{ role: 'user', content: JSON.stringify(summary) }],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    const text = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return {
      provider: 'anthropic',
      model,
      text,
      usage: {
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
      },
    };
  },
};

export default anthropicProvider;
