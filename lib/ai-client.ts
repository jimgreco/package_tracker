import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

export const DEFAULT_AI_MODEL = "claude-opus-5-5";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
// Claude structured outputs reject numeric and string length bounds and array
// minItems above 1. The Zod schema still enforces them on the parsed result.
const UNSUPPORTED_SCHEMA_KEYS = new Set([
  "$schema",
  "maxItems",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
]);

export const aiModel = () =>
  process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_AI_MODEL;
export const hasAiKey = () => !!process.env.ANTHROPIC_API_KEY?.trim();

export function toClaudeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toClaudeSchema);
  if (!schema || typeof schema !== "object") return schema;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    if (key === "minItems" && Number(value) > 1) continue;
    result[key] = toClaudeSchema(value);
  }
  return result;
}

export class AiResponseError extends Error {}

/** One structured-output request to Claude, validated against `schema`. */
export async function structuredJson<T extends z.ZodType>({
  system,
  content,
  schema,
  effort = "medium",
  maxTokens = 16_000,
  timeout = 120_000,
}: {
  system: string;
  content: string;
  schema: T;
  effort?: "low" | "medium" | "high";
  maxTokens?: number;
  timeout?: number;
}): Promise<z.infer<T>> {
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout,
    maxRetries: 1,
  });
  const response = await client.beta.messages.create({
    model: aiModel(),
    max_tokens: maxTokens,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    system,
    messages: [{ role: "user", content }],
    output_config: {
      effort,
      format: {
        type: "json_schema",
        schema: toClaudeSchema(z.toJSONSchema(schema)) as Record<string, unknown>,
      },
    },
  });
  if (response.stop_reason === "refusal")
    throw new AiResponseError("The AI declined to process this email.");
  if (response.stop_reason === "max_tokens")
    throw new AiResponseError("The AI response was cut off before it finished.");
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AiResponseError("The AI returned an unreadable response.");
  }
  const result = schema.safeParse(parsed);
  if (!result.success)
    throw new AiResponseError("The AI response did not match the expected format.");
  return result.data;
}
