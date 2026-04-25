/**
 * LlmClientFactory — dispatches to the right OpenAI-compatible client
 * based on per-agent LlmConfig.provider, injecting the API key from
 * agent.llm.apiKey or a server env fallback.
 *
 * Env fallback names:
 *   OPENAI_API_KEY   for provider "openai"
 *   FLOCK_API_KEY    for provider "flock"
 */

import type { LlmClient, LlmClientFactory } from "../../../../shared/domain/agent/ports.js";
import type { LlmConfig } from "../../../../shared/domain/agent/types.js";
import { isKnownProvider, PROVIDERS } from "./providers.js";
import { makeOpenAiCompatibleClient } from "./openai-compatible-client.js";

const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOKENS = 400;

export const v1LlmFactory: LlmClientFactory = {
  async make(config: LlmConfig): Promise<LlmClient> {
    if (!isKnownProvider(config.provider)) {
      throw new Error(`unknown_provider:${config.provider}`);
    }
    const wire = PROVIDERS[config.provider];

    const apiKey =
      config.apiKey ??
      process.env[`${config.provider.toUpperCase()}_API_KEY`];
    if (!apiKey) {
      throw new Error(`no_api_key:${config.provider}`);
    }

    return makeOpenAiCompatibleClient({
      wire,
      apiKey,
      model: config.model || wire.defaultModel,
      temperature: config.temperature ?? DEFAULT_TEMPERATURE,
      maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    });
  },
};
