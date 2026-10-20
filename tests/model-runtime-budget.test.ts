import { expect, it } from "vitest";
import { resolveModelBudget, validateModelBudget } from "@modera/model-catalog";
import { AgentLoop } from "../src/agent-loop";
import { type ModelAdapter } from "@pal/contracts";
import { estimateContext } from "../src/context-manager";
import { ContinuingModel } from "../src/model-continuation";
import { ModelLimitError } from "@pal/contracts";
import type { ChatMessage, RunId, SessionId } from "@pal/contracts";

const request = {
  sessionId: "s" as SessionId,
  runId: "r" as RunId,
  messages: [],
  tools: [],
  signal: new AbortController().signal,
};
it("resolves exact-model overrides, inherited defaults and combined window reservations", () => {
  const profile = {
    contextInputBudget: 48000,
    modelBudgets: {
      small: { contextWindowTokens: 16000, maxOutputTokens: 2000 },
      large: {
        contextInputBudget: 96000,
        contextWindowTokens: 128000,
        maxOutputTokens: 16000,
      },
    },
  };
  expect(resolveModelBudget(profile, "small")).toEqual({
    inputBudget: 12976,
    summaryInputBudget: 12976,
    maxOutputTokens: 2000,
  });
  expect(resolveModelBudget(profile, "large")).toEqual({
    inputBudget: 96000,
    summaryInputBudget: 24000,
    maxOutputTokens: 16000,
  });
  expect(resolveModelBudget(profile, "Small")).toEqual({
    inputBudget: 48000,
    summaryInputBudget: 24000,
  });
  expect(resolveModelBudget({}, "unknown")).toEqual({
    inputBudget: 48000,
    summaryInputBudget: 24000,
  });
  expect(resolveModelBudget(profile, "__proto__").inputBudget).toBe(48000);
});

it("rejects impossible windows and missing output limits before dispatch", () => {
  expect(() => validateModelBudget({ contextWindowTokens: 16000 })).toThrow(
    "output limit",
  );
  expect(() =>
    validateModelBudget({ contextWindowTokens: 16000, maxOutputTokens: 8192 }),
  ).toThrow("10000");
  expect(() =>
    validateModelBudget({ contextWindowTokens: NaN, maxOutputTokens: 1 }),
  ).toThrow();
  expect(() =>
    validateModelBudget({ contextWindowTokens: 32000.5, maxOutputTokens: 1 }),
  ).toThrow();
});

it("bounds normal and summary requests by the configured combined window with Chinese history and schemas", async () => {
  const context = resolveModelBudget(
    {
      modelBudgets: {
        small: { contextWindowTokens: 16000, maxOutputTokens: 2000 },
      },
    },
    "small",
  );
  const messages: ChatMessage[] = [
    {
      id: "user",
      role: "user",
      content: "保留原始任务和要求",
      createdAt: "now",
    },
    ...Array.from({ length: 10 }, (_, i): ChatMessage => ({
      id: `old${i}`,
      role: "assistant",
      content: "历史代码日志".repeat(1000),
      createdAt: "now",
    })),
    ...Array.from({ length: 6 }, (_, i): ChatMessage => ({
      id: `tail${i}`,
      role: "assistant",
      content: "近期结果",
      createdAt: "now",
    })),
  ];
  let summaries = 0,
    normal = 0;
  const model: ModelAdapter = {
    async *stream(input) {
      expect(estimateContext(input.messages, input.tools)).toBeLessThanOrEqual(
        context.inputBudget,
      );
      if (input.messages[0]?.id === "handoff-policy") summaries++;
      else {
        normal++;
        expect(
          input.messages.some(
            (message) => message.content === "保留原始任务和要求",
          ),
        ).toBe(true);
      }
      yield { type: "text-delta", text: "保留的工作状态" };
      yield { type: "completed" };
    },
  };
  for await (const _ of new AgentLoop({ model, context }).run({
    ...request,
    messages,
    tools: [
      {
        id: "read",
        title: "读取",
        description: "按路径读取文件",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
        },
        requiredPermissions: [],
      },
    ],
  })) {
  }
  expect(summaries).toBeGreaterThan(0);
  expect(normal).toBe(1);
});

it("stops continuation before sending a prefix that exceeds the input budget", async () => {
  let calls = 0;
  const model: ModelAdapter = {
    async *stream() {
      calls++;
      yield { type: "text-delta", text: "x".repeat(4000) };
      throw new ModelLimitError("output", "limit", { canContinueText: true });
    },
  };
  await expect(
    (async () => {
      for await (const _ of new ContinuingModel(model, 2, 1024).stream(
        request,
      )) {
      }
    })(),
  ).rejects.toThrow("CONTINUATION_CONTEXT_BUDGET_EXCEEDED");
  expect(calls).toBe(1);
});
