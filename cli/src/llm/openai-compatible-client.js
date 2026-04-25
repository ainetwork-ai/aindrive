/**
 * Single OpenAI-compatible chat-completions client used for any provider
 * whose /v1/chat/completions accepts the OpenAI JSON shape (OpenAI itself,
 * Flock, Together, Groq, OpenRouter, vLLM, ...).
 *
 * Only baseUrl and the auth header vary per provider — both come in via
 * `wire`. Non-streaming for v1.
 */

export function makeOpenAiCompatibleClient({ wire, apiKey, model, temperature, maxTokens }) {
  return {
    async complete({ system, user, maxTokens: callMax }) {
      const url = `${wire.baseUrl}/chat/completions`;
      const body = {
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature,
        max_tokens: callMax ?? maxTokens,
        stream: false,
      };

      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          [wire.authHeader]: `${wire.authPrefix}${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!r.ok) {
        const errText = await r.text().catch(() => `${r.status}`);
        throw new Error(`llm_http_${r.status}:${String(errText).slice(0, 300)}`);
      }

      const data = await r.json();
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new Error(`llm_bad_response:${JSON.stringify(data).slice(0, 200)}`);
      }
      return content;
    },
  };
}
