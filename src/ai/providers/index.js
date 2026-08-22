// Primary-regime provider registry.
//
// Only Anthropic is registered today. The registry exists so the regime engine
// depends on an INTERFACE rather than on Anthropic specifically — adding a
// provider later is a registry entry plus a module, with no change to the
// engine, the parser, or the fallback semantics.
//
// There is deliberately NO automatic cross-provider fallback: if the
// configured provider fails, the engine takes its existing safe fallback
// (decayed prior regime, else the no-trade chop fallback). Trying a second
// provider mid-cycle would silently change which model produced a decision,
// which would corrupt the A/B experiment.
import { config } from '../../config.js';
import { anthropicProvider } from './anthropic.js';
import { geminiProvider } from './gemini.js';
import { openrouterProvider } from './openrouter.js';
import { mistralProvider } from './mistral.js';

const PRIMARY_PROVIDERS = {
  anthropic: anthropicProvider,
  gemini: geminiProvider,
  openrouter: openrouterProvider,
  mistral: mistralProvider,
};

export function listPrimaryProviders() {
  return Object.keys(PRIMARY_PROVIDERS);
}

// Throws on an unknown name. Called inside the engine's try block, so a
// misconfigured AI_PROVIDER degrades to the safe fallback rather than crashing
// the cycle.
export function getPrimaryProvider(name = config.aiProvider) {
  const provider = PRIMARY_PROVIDERS[String(name).toLowerCase()];
  if (!provider) {
    throw new Error(`unknown AI provider "${name}" — registered: ${listPrimaryProviders().join(', ')}`);
  }
  return provider;
}

// Resolve without throwing — for pre-flight checks that must not turn an
// unknown provider name into a different failure mode than the engine's own.
export function tryGetPrimaryProvider(name = config.aiProvider) {
  return PRIMARY_PROVIDERS[String(name).toLowerCase()] ?? null;
}

export { anthropicProvider, geminiProvider, openrouterProvider, mistralProvider };
