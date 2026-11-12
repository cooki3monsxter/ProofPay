import { config } from "../config.js";

/** Token usage of the most recent successful call (used by the LLM eval to report cost). */
export let lastUsage: { input_tokens: number; output_tokens: number } | null = null;

/** Wraps untrusted text so it can't close its own delimiter and pose as instructions. */
export function fenceUntrusted(text: string, max = 20_000) {
  return `<untrusted_evidence>\n${text.slice(0, max).replace(/<\/?untrusted_evidence>/gi, "[removed tag]")}\n</untrusted_evidence>`;
}

/**
 * Calls Claude with a forced tool call so the answer always comes back as JSON matching
 * `schema` (structured output). Returns null on any failure so callers fall back cleanly.
 */
export async function claudeJson<T>(opts: {
  system: string;
  user: string;
  toolName: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}): Promise<T | null> {
  if (!config.ai.anthropicKey) return null;
  try {
    const res = await fetch(`${config.ai.apiUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": config.ai.anthropicKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: config.ai.model,
        max_tokens: opts.maxTokens ?? 4000,
        system: opts.system,
        messages: [{ role: "user", content: opts.user }],
        tools: [{ name: opts.toolName, description: "Return the result.", input_schema: opts.schema }],
        tool_choice: { type: "tool", name: opts.toolName },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      console.warn(`[claude] ${res.status} ${await res.text()}`);
      return null;
    }
    const j: any = await res.json();
    if (j.stop_reason === "max_tokens") {
      console.warn("[claude] response truncated at max_tokens; using fallback");
      return null; // a cut-off tool call is incomplete JSON — never act on it
    }
    lastUsage = j.usage ?? null;
    const block = j.content?.find((c: any) => c.type === "tool_use");
    return (block?.input as T) ?? null;
  } catch (e) {
    console.warn("[claude] call failed:", (e as Error).message);
    return null;
  }
}
