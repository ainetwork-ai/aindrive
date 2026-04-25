/**
 * LLM provider registry — wire details for each OpenAI-compatible backend.
 *
 * v1 supports OpenAI and Flock. Both speak the same /v1/chat/completions
 * JSON shape; only the baseUrl and the auth header differ. Adding more
 * (Together, Groq, OpenRouter, …) is one entry per provider — they're
 * almost all OpenAI-compatible at this point.
 *
 * Picking the default Flock model:
 *   qwen3-30b-a3b-instruct-2507 — small, fast, currently available on
 *   Flock per docs. Override via agent.llm.model.
 */

export type ProviderId = "openai" | "flock";

export type ProviderWire = {
  baseUrl: string;
  /**
   * Header name to send the API key under.
   *   OpenAI uses standard `Authorization: Bearer <key>`
   *   Flock uses LiteLLM-style `x-litellm-api-key: <key>`
   */
  authHeader: string;
  /** Prefix prepended to the key in the auth header value. */
  authPrefix: string;
  /** Default model if agent.llm.model is empty string. */
  defaultModel: string;
};

export const PROVIDERS: Record<ProviderId, ProviderWire> = {
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
};

export function isKnownProvider(name: string): name is ProviderId {
  return name in PROVIDERS;
}
