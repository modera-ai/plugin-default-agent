import { expect, it } from "vitest";
import { AgentLoop } from "../src/agent-loop";
import { ModelLimitError, ModelStreamInterruptedError, type ModelAdapter } from "@modera/contracts";
import { RecoveryBudget } from "../src/recovery-budget";
import { ToolRegistry, ToolExecutor } from "@modera/agent-host";
import type { RunId, SessionId } from "@modera/contracts";

const request = {
  sessionId: "session" as SessionId,
  runId: "run" as RunId,
  messages: [],
  tools: [],
  signal: new AbortController().signal,
};

it("bounds all automatic recovery kinds with one allowance", () => {
  const budget = new RecoveryBudget(2);
  expect(budget.tryConsume("transport")).toBe(true);
  expect(budget.tryConsume("context")).toBe(true);
  expect(budget.tryConsume("continuation")).toBe(false);
  expect(budget.used).toBe(2);
  budget.resetAfterSuccess();
  expect(budget.tryConsume("transport")).toBe(true);
});

it("does not multiply a context retry and text continuation limits", async () => {
  let calls = 0;
  const model: ModelAdapter = {
    async *stream() {
      calls++;
      if (calls === 1) throw new ModelLimitError("context", "context rejected");
      yield { type: "text-delta", text: "partial body" };
      throw new ModelStreamInterruptedError("text-partial", "socket closed");
    },
  };

  await expect(
    (async () => {
      for await (const _ of new AgentLoop({ model }).run({
        ...request,
        recovery: new RecoveryBudget(1),
      })) {
        // Drain.
      }
    })(),
  ).rejects.toMatchObject({ state: "text-partial" });
  expect(calls).toBe(2);
});

it("renews recovery between successful tool rounds without replaying side effects", async () => {
  const registry = new ToolRegistry();
  let executed = 0,
    attempts = 0;
  registry.register("fixture", {
    definition: {
      id: "advance",
      title: "Advance",
      description: "",
      inputSchema: {},
      requiredPermissions: [],
    },
    execute: async () => String(++executed),
  });
  const loop = new AgentLoop({
    executor: new ToolExecutor(registry, async () => true),
    model: {
      async *stream(modelRequest) {
        if (
          modelRequest.messages[0]?.content.startsWith(
            "Produce a concise durable context handoff",
          )
        ) {
          yield {
            type: "text-delta",
            text: "Keep advancing until four operations are complete.",
          };
          yield { type: "completed" };
          return;
        }
        attempts++;
        if (attempts % 2)
          throw new ModelLimitError("context", "temporary rejection");
        if (executed < 4)
          yield {
            type: "tool-call",
            id: String(attempts),
            name: "advance",
            input: {},
          };
        else yield { type: "text-delta", text: "Done" };
        yield { type: "completed" };
      },
    },
  });
  for await (const _ of loop.run({
    ...request,
    recovery: new RecoveryBudget(1),
  })) {
  }
  expect(attempts).toBe(10);
  expect(executed).toBe(4);
});
