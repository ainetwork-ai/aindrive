/**
 * Single OpenAI-compatible chat-completions client. Works for any
 * provider whose /v1/chat/completions accepts OpenAI's JSON shape
 * (OpenAI itself, Flock, Together, Groq, OpenRouter, vLLM, ...).
 *
 * Only two things vary per provider: baseUrl and the auth header.
 * Both are passed in via ProviderWire so this one function covers all.
 *
 * Non-streaming for v1 — askAgent returns a single string today.
 * Streaming would require LlmClient.complete to also emit chunks; defer.
 */

import type { LlmClient } from "../../../../shared/domain/agent/ports.js";
import type { ProviderWire } from "./providers.js";

export type OpenAiCompatibleClientOpts = {
  wire: ProviderWire;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
};

export function makeOpenAiCompatibleClient(opts: OpenAiCompatibleClientOpts): LlmClient {
  return {
    async complete({ system, user, maxTokens }) {
      const url = `${opts.wire.baseUrl}/chat/completions`;
      const body = {
        model: opts.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: opts.temperature,
        max_tokens: maxTokens ?? opts.maxTokens,
        stream: false,
      };

      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          [opts.wire.authHeader]: `${opts.wire.authPrefix}${opts.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!r.ok) {
        const errText = await r.text().catch(() => `${r.status}`);
        throw new Error(`llm_http_${r.status}:${errText.slice(0, 300)}`);
      }

      const data = (await r.json()) as ChatCompletionResponse;
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new Error(`llm_bad_response:${JSON.stringify(data).slice(0, 200)}`);
      }
      return content;
    },
  };
}

type ChatCompletionResponse = {
  choices?: Array<{
    message?: { role?: string; content?: string };
    finish_reason?: string;
  }>;
};
