/**
 * LLM provider registry — wire details for each OpenAI-compatible backend.
 *
 * v1 supports OpenAI and Flock. Both speak the same /v1/chat/completions
 * JSON shape; only the baseUrl and the auth header differ. Adding more
 * (Together, Groq, OpenRouter, ...) is one entry per provider.
 *
 * This file lives in CLI: the actual LLM call happens on the owner's
 * machine so the API key never leaves owner's host.
 */

export const PROVIDERS = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    defaultModel: "gpt-4o-mini",
  },
  flock: {
    baseUrl: "https://api.flock.io/v1",
    authHeader: "x-litellm-api-key",
    authPrefix: "",
    defaultModel: "qwen3-30b-a3b-instruct-2507",
  },
  "gemma-local": {
    baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1",
    authHeader: null,
    authPrefix: "",
    defaultModel: "gemma3:4b",
    noAuth: true,
  },
};

export function isKnownProvider(name) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, name);
}
