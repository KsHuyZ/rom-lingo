// One OpenAI-compatible client covers every backend we use:
//   gemini-web-to-api  http://127.0.0.1:<port>/openai/v1
//   Anthropic          https://api.anthropic.com/v1/
//   Gemini API         https://generativelanguage.googleapis.com/v1beta/openai/

export type ProviderName = "primary" | "fallback";

export type ChatProvider = {
  name: ProviderName;
  label: string;
  complete: (system: string, user: string, signal?: AbortSignal) => Promise<string>;
};

export class ProviderError extends Error {
  constructor(
    message: string,
    /** rate limit / temporary block: worth retrying later or on fallback */
    public readonly transient: boolean,
  ) {
    super(message);
  }
}

function openAICompatible(name: ProviderName, baseUrl: string, apiKey: string, model: string): ChatProvider {
  const url = baseUrl.replace(/\/+$/, "") + "/chat/completions";
  return {
    name,
    label: new URL(baseUrl).host,
    async complete(system, user, signal) {
      const res = await fetch(url, {
        method: "POST",
        signal: signal ?? AbortSignal.timeout(180_000),
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          temperature: 0.3,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });
      const body = await res.text();
      if (!res.ok) {
        // never include request headers in errors: they carry the API key
        const transient = res.status === 429 || res.status >= 500 || /unusual traffic/i.test(body);
        throw new ProviderError(`${name} HTTP ${res.status}: ${body.slice(0, 200)}`, transient);
      }
      let content: unknown;
      try {
        content = JSON.parse(body)?.choices?.[0]?.message?.content;
      } catch {
        throw new ProviderError(`${name}: response is not JSON`, true);
      }
      if (typeof content !== "string" || !content.trim()) throw new ProviderError(`${name}: empty response`, true);
      return content;
    },
  };
}

/** Deterministic fake: prefixes text, keeps tokens. Dev only. */
function mockProvider(name: ProviderName): ChatProvider {
  return {
    name,
    label: "mock",
    async complete(_system, user) {
      await new Promise((r) => setTimeout(r, 400 + Math.random() * 600));
      const items = JSON.parse(user.slice(user.indexOf("["))) as { i: string; t: string }[];
      return JSON.stringify(items.map((it) => ({ i: it.i, v: it.t ? `VI ${it.t}` : "" })));
    },
  };
}

function fromEnv(name: ProviderName, prefix: string): ChatProvider | null {
  const base = process.env[`${prefix}_BASE_URL`]?.trim();
  if (!base) return null;
  if (base === "mock") {
    if (process.env.NODE_ENV === "production") throw new Error(`${prefix}_BASE_URL=mock is not allowed in production`);
    return mockProvider(name);
  }
  const model = process.env[`${prefix}_MODEL`]?.trim();
  if (!model) throw new Error(`${prefix}_MODEL is not set`);
  return openAICompatible(name, base, process.env[`${prefix}_API_KEY`]?.trim() ?? "", model);
}

let cached: { primary: ChatProvider | null; fallback: ChatProvider | null } | null = null;
export function providers() {
  return (cached ??= { primary: fromEnv("primary", "AI_PRIMARY"), fallback: fromEnv("fallback", "AI_FALLBACK") });
}
