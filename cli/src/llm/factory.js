/**
 * resolveLlmClient — picks the right OpenAI-compatible client per LlmConfig.
 *
 * apiKey resolution: agent.json's llm.apiKey (preferred) → process.env.<PROVIDER>_API_KEY
 * → throw no_api_key.
 *
 * Adding providers = entry in providers.js. This file unchanged.
 */

import { PROVIDERS, isKnownProvider } from "./providers.js";
import { makeOpenAiCompatibleClient } from "./openai-compatible-client.js";

const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOKENS = 400;

export function resolveLlmClient(config) {
  if (!config || !isKnownProvider(config.provider)) {
    throw new Error(`unknown_provider:${config?.provider}`);
  }
  const wire = PROVIDERS[config.provider];

  const apiKey =
    config.apiKey || process.env[`${config.provider.toUpperCase()}_API_KEY`];
  if (!apiKey) {
    throw new Error(`no_api_key:${config.provider}`);
  }

  return makeOpenAiCompatibleClient({
    wire,
    apiKey,
    model: config.model || wire.defaultModel,
    temperature: typeof config.temperature === "number" ? config.temperature : DEFAULT_TEMPERATURE,
    maxTokens: typeof config.maxTokens === "number" ? config.maxTokens : DEFAULT_MAX_TOKENS,
  });
}
