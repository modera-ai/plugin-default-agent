import { expect, it } from "vitest";
import type {
  ChatMessage,
  ContextCheckpoint,
  RunId,
  SessionId,
} from "@modera/contracts";
import {
  ContextManager,
  estimateContext,
  applyCheckpoint,
} from "../src/context-manager";

it("bounds serialized summary requests including escaped handoff text", async () => {
  const raw = [
    message("u", "user", "Keep facts"),
    ...Array.from({ length: 8 }, (_, i) =>
      message(`old${i}`, "assistant", 'quoted "code" '.repeat(600)),
    ),
    ...Array.from({ length: 6 }, (_, i) =>
      message(`tail${i}`, "assistant", "recent"),
    ),
  ];
  let requests = 0;
  const model: ModelAdapter = {
    async *stream(input) {
      requests++;
      expect(estimateContext(input.messages)).toBeLessThanOrEqual(24000);
      yield { type: "text-delta", text: '"'.repeat(4000) };
      yield { type: "completed" };
    },
  };
  const result = await new ContextManager(model, {
    inputBudget: 16000,
    summaryInputBudget: 24000,
  }).prepare({ ...request, messages: raw });
  expect(requests).toBeGreaterThan(1);
  expect(result.checkpoint).toBeDefined();
});
import { AgentLoop } from "../src/agent-loop";
import { type ModelAdapter } from "@modera/contracts";

const request = {
  sessionId: "s" as SessionId,
  runId: "r" as RunId,
  tools: [],
  signal: new AbortController().signal,
};
const message = (
  id: string,
  role: ChatMessage["role"],
  content: string,
): ChatMessage => ({ id, role, content, createdAt: "2026-09-11" });
function history(): ChatMessage[] {
  return [
    message("user", "user", "Keep mechanism and plugin commits separate."),
    ...Array.from({ length: 14 }, (_, i) =>
      message(String(i), "assistant", "evidence ".repeat(300)),
    ),
    message("correction", "user", "Do not push."),
    ...Array.from({ length: 6 }, (_, i) =>
      message(`tail${i}`, "assistant", "recent evidence"),
    ),
  ];
}
function summarizer(): { model: ModelAdapter; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    model: {
      async *stream(input) {
        expect(input.tools).toEqual([]);
        calls.push(input.messages.length);
        yield {
          type: "text-delta",
          text: "Completed inspection. Preserve outstanding tasks.",
        };
        yield {
          type: "completed",
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    },
  };
}

it("compacts without mutating history, preserving exact user requirements and recent context", async () => {
  const raw = history();
  const before = JSON.stringify(raw);
  const { model, calls } = summarizer();
  const result = await new ContextManager(model, {
    inputBudget: 12_000,
  }).prepare({ ...request, messages: raw });
  expect(result.checkpoint).toBeDefined();
  expect(JSON.stringify(raw)).toBe(before);
  expect(result.messages.filter((m) => m.role === "user")).toEqual(
    raw.filter((m) => m.role === "user"),
  );
  expect(result.messages.slice(-6)).toEqual(raw.slice(-6));
  expect(result.usages).toHaveLength(calls.length);
  const resumed = await new ContextManager(
    model,
    { inputBudget: 12_000 },
    result.checkpoint,
  ).prepare({ ...request, messages: raw });
  expect(resumed.checkpoint).toBeUndefined();
  expect(resumed.usages).toEqual([]);
});

it("does not pre-split a summary fragment that fits the serialized request budget", async () => {
  const { model, calls } = summarizer();
  await new ContextManager(model, {
    inputBudget: 12_000,
    summaryInputBudget: 24_000,
  }).prepare({ ...request, messages: history() });
  expect(calls).toHaveLength(1);
});

it("never splits a tool call/result group at a checkpoint", async () => {
  const raw = history();
  const call = {
    ...message("call", "assistant", ""),
    toolCalls: [{ id: "c", name: "read", input: {} }],
  };
  raw.splice(raw.length - 7, 2, call, {
    ...message("result", "tool", "data"),
    toolCallId: "c",
  });
  const { model } = summarizer();
  const result = await new ContextManager(model, {
    inputBudget: 12_000,
  }).prepare({ ...request, messages: raw });
  expect(result.messages.find((m) => m.id === "call")).toEqual(call);
  expect(result.messages.find((m) => m.id === "result")?.toolCallId).toBe("c");
});

it("ignores a stale boundary instead of losing history", () => {
  const raw = history();
  const checkpoint: ContextCheckpoint = {
    version: 1,
    throughMessageId: "missing",
    summary: "stale",
    createdAt: "now",
  };
  expect(applyCheckpoint(raw, checkpoint)).toEqual(raw);
});

it("rejects an oversized latest requirement instead of silently truncating it", async () => {
  const { model, calls } = summarizer();
  const raw = history();
  raw.push(message("latest", "user", "requirement ".repeat(4000)));
  await expect(
    new ContextManager(model, { inputBudget: 12_000 }).prepare({
      ...request,
      messages: raw,
    }),
  ).rejects.toThrow("CONTEXT_PROTECTED_INPUT_TOO_LARGE");
  expect(calls).toHaveLength(0);
});

it("does not commit an interrupted or cancelled summary", async () => {
  const model: ModelAdapter = {
    async *stream() {
      yield { type: "text-delta", text: "partial" };
    },
  };
  await expect(
    new ContextManager(model, { inputBudget: 12_000 }).prepare({
      ...request,
      messages: history(),
    }),
  ).rejects.toThrow("COMPACTION_INCOMPLETE");
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await expect(
    new ContextManager(model, { inputBudget: 12_000 }).prepare({
      ...request,
      signal: controller.signal,
      messages: history(),
    }),
  ).rejects.toThrow("cancelled");
});

it("includes compaction usage and emits the checkpoint before resuming normal output", async () => {
  let summaries = 0;
  const model: ModelAdapter = {
    async *stream(input) {
      if (input.messages[0]?.id === "handoff-policy") {
        expect(events[0]?.type).toBe("context-compacting");
        summaries++;
        yield { type: "text-delta", text: "Retain outstanding constraints." };
        yield {
          type: "completed",
          usage: { inputTokens: 10, outputTokens: 2 },
        };
      } else {
        yield { type: "text-delta", text: "Continued." };
        yield {
          type: "completed",
          usage: { inputTokens: 20, outputTokens: 3 },
        };
      }
    },
  };
  const events: import("../src/agent-loop").AgentEvent[] = [];
  for await (const event of new AgentLoop({
    model,
    context: { inputBudget: 12_000 },
  }).run({ ...request, messages: history() }))
    events.push(event);
  expect(events[0]?.type).toBe("context-compacting");
  expect(events[1]?.type).toBe("context-compacted");
  expect(events.filter((e) => e.type === "text-delta")).toEqual([
    { type: "text-delta", text: "Continued." },
  ]);
  expect(events.at(-1)).toMatchObject({
    type: "completed",
    usage: {
      inputTokens: summaries * 10 + 20,
      outputTokens: summaries * 2 + 3,
    },
  });
});
