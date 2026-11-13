import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { AiResponseError, structuredJson, toClaudeSchema } from "../lib/ai-client";
import { extractionSchema } from "../lib/validation";
import { extractionPrompt } from "../lib/email";

process.env.ANTHROPIC_API_KEY = "fixture-key";

const reply = (text: string, stop_reason = "end_turn") =>
  Response.json({
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    content: [{ type: "text", text }],
  });

test("extraction schema drops bounds Claude rejects but keeps structure", () => {
  const schema = JSON.stringify(toClaudeSchema(z.toJSONSchema(extractionSchema)));
  for (const key of ["$schema", "minLength", "maxLength", "minimum", "maximum"])
    assert.ok(!schema.includes(`"${key}"`), key);
  assert.ok(schema.includes('"additionalProperties":false'));
  assert.ok(schema.includes('"physicalDelivery"'));
});

test("prompt names the household zone only as the fallback", () => {
  const prompt = extractionPrompt("America/Chicago");
  assert.ok(prompt.includes("Use America/Chicago only when the email states no destination zone"));
  assert.ok(prompt.includes("untrusted data"));
});

test("refusals, cut-off replies and out-of-range values become review errors", async () => {
  const schema = z.object({ quantity: z.number().int().min(1) }).strict();
  const cases: [Response, string][] = [
    [reply("{}", "refusal"), "declined"],
    [reply('{"quantity":', "max_tokens"), "cut off"],
    [reply("not json"), "unreadable"],
    [reply('{"quantity":0}'), "expected format"],
  ];
  for (const [response, message] of cases) {
    globalThis.fetch = async () => response;
    await assert.rejects(
      structuredJson({ system: "s", content: "c", schema }),
      (error: unknown) => error instanceof AiResponseError && error.message.includes(message),
    );
  }
  globalThis.fetch = async () => reply('{"quantity":2}');
  assert.deepEqual(await structuredJson({ system: "s", content: "c", schema }), { quantity: 2 });
});
