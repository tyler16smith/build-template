import { MockLanguageModelV4 } from "ai/test";
import { setTestModel } from "../src/modules/assistant/models";

/** One model reply: words, or a call to a tool with its input. */
export type ScriptedReply = { text: string } | { tool: string; input: Record<string, unknown> };

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};

function parts(reply: ScriptedReply, index: number): unknown[] {
  const start = { type: "stream-start", warnings: [] };
  if ("text" in reply)
    return [
      start,
      { type: "text-start", id: `t${index}` },
      { type: "text-delta", id: `t${index}`, delta: reply.text },
      { type: "text-end", id: `t${index}` },
      { type: "finish", usage, finishReason: { unified: "stop", raw: "stop" } },
    ];
  return [
    start,
    {
      type: "tool-call",
      toolCallId: `call_${index}`,
      toolName: reply.tool,
      input: JSON.stringify(reply.input),
    },
    { type: "finish", usage, finishReason: { unified: "tool-calls", raw: "tool_use" } },
  ];
}

/**
 * Drives the agents with a script instead of a provider: each model call takes the next reply.
 * Returns what each call was asked (its prompt), for assertions.
 */
export function scriptModel(replies: ScriptedReply[]): { prompts: unknown[] } {
  const prompts: unknown[] = [];
  let call = 0;
  setTestModel(
    () =>
      new MockLanguageModelV4({
        doStream: async (options) => {
          prompts.push(options.prompt);
          const reply = replies[Math.min(call, replies.length - 1)]!;
          const index = call++;
          return {
            stream: new ReadableStream<never>({
              start(controller) {
                for (const part of parts(reply, index)) controller.enqueue(part as never);
                controller.close();
              },
            }),
          };
        },
      }) as never,
  );
  return { prompts };
}

export function clearModel(): void {
  setTestModel(null);
}
