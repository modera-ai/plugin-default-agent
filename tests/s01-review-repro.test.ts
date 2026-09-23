import { expect, it } from "vitest";
import type { ChatMessage, RunId, SessionId } from "@modera/contracts";
import {
  AgentLoop,
  type ModelAdapter,
} from "../src/agent-loop";
import {
  ContextManager,
  estimateContext,
} from "../src/context-manager";
import { ModelLimitError } from "@modera/contracts";

const summaryRequestLimitModel = (limit: number): ModelAdapter => ({
  async *stream(request) {
    expect(estimateContext(request.messages)).toBeLessThanOrEqual(limit);
    yield { type: "text-delta" as const, text: "Keep requirements." };
    yield { type: "completed" as const };
  },
});

const oversizedHistory = (): ChatMessage[] => [
  { id: "u", role: "user", content: "Preserve requirements.", createdAt: "" },
  {
    id: "old",
    role: "assistant",
    content: "evidence ".repeat(10000),
    createdAt: "",
  },
  { id: "tail", role: "assistant", content: "pending", createdAt: "" },
];

it("keeps summary requests within the reduced input budget after a provider rejection", async () => {
  const messages: ChatMessage[] = [
    { id: "u", role: "user", content: "修复问题，不删除要求", createdAt: "" },
    {
      id: "old",
      role: "assistant",
      content: "evidence ".repeat(10000),
      createdAt: "",
    },
    { id: "tail", role: "assistant", content: "pending", createdAt: "" },
  ];
  const manager = new ContextManager(
    {
      async *stream(request) {
        expect(estimateContext(request.messages)).toBeLessThanOrEqual(8000);
        yield {
          type: "text-delta",
          text: "Keep requirements; work is pending.",
        };
        yield { type: "completed" };
      },
    },
    { inputBudget: 16000, summaryInputBudget: 16000 },
  );
  manager.reduceBudget(16000);
  await manager.prepare({
    messages,
    tools: [],
    runId: "r" as RunId,
    sessionId: "s" as SessionId,
    signal: new AbortController().signal,
  });
});

it("keeps summaries within a lower configured summary budget", async () => {
  const manager = new ContextManager(summaryRequestLimitModel(10000), {
    inputBudget: 16000,
    summaryInputBudget: 10000,
  });
  await manager.prepare({
    messages: oversizedHistory(),
    tools: [],
    runId: "r" as RunId,
    sessionId: "s" as SessionId,
    signal: new AbortController().signal,
  });
});

it("applies consecutive input budget reductions to summaries", async () => {
  const manager = new ContextManager(summaryRequestLimitModel(4000), {
    inputBudget: 16000,
    summaryInputBudget: 16000,
  });
  manager.reduceBudget(16000);
  manager.reduceBudget(8000);
  await manager.prepare({
    messages: oversizedHistory(),
    tools: [],
    runId: "r" as RunId,
    sessionId: "s" as SessionId,
    signal: new AbortController().signal,
  });
});

it("recovers a rejected normal request by sending smaller summary requests", async () => {
  const fixtureLimit = 10000;
  const calls: number[] = [];
  const loop = new AgentLoop({
    context: { inputBudget: 16000, summaryInputBudget: 16000 },
    model: {
      async *stream(request) {
        const size = estimateContext(request.messages, request.tools);
        calls.push(size);
        const limit =
          request.messages[0]?.id === "handoff-policy" ? 16000 : fixtureLimit;
        if (size > limit)
          throw new ModelLimitError("context", "fixture window exceeded");
        yield { type: "text-delta", text: "Work remains pending." };
        yield { type: "completed" };
      },
    },
  });
  const messages: ChatMessage[] = [
    {
      id: "u",
      role: "user",
      content: "Preserve the original task.",
      createdAt: "",
    },
    {
      id: "old",
      role: "assistant",
      content: "evidence ".repeat(5000),
      createdAt: "",
    },
    { id: "tail", role: "assistant", content: "pending", createdAt: "" },
  ];
  const events = [];
  for await (const event of loop.run({
    messages,
    tools: [],
    runId: "r" as RunId,
    sessionId: "s" as SessionId,
    signal: new AbortController().signal,
  }))
    events.push(event);
  expect(events.at(-1)?.type).toBe("completed");
  expect(calls.some((size) => size > fixtureLimit)).toBe(true);
  expect(calls.at(-1)).toBeLessThanOrEqual(fixtureLimit);
});
