import { expect, it } from "vitest";
import { AgentLoop } from "../src/agent-loop";
import { ToolExecutor, ToolRegistry } from "@modera/agent-host";
import type { RunId, SessionId } from "@pal/contracts";

it("counts missing provider usage conservatively rather than permitting unlimited rounds", async () => {
  const registry = new ToolRegistry();
  registry.register("fixture", {
    definition: {
      id: "read",
      title: "Read",
      description: "",
      inputSchema: {},
      requiredPermissions: [],
    },
    execute: async () => "value",
  });
  let calls = 0;
  const loop = new AgentLoop({
    limits: { maxTokens: 100 },
    executor: new ToolExecutor(registry, async () => true),
    model: {
      async *stream() {
        calls++;
        yield { type: "tool-call", id: String(calls), name: "read", input: {} };
        yield { type: "completed" };
      },
    },
  });
  await expect(
    (async () => {
      for await (const _ of loop.run({
        sessionId: "s" as SessionId,
        runId: "r" as RunId,
        signal: new AbortController().signal,
        tools: [],
        messages: [],
      })) {
      }
    })(),
  ).rejects.toThrow("RUN_TOKEN_BUDGET_EXCEEDED");
  expect(calls).toBe(1);
});
import { RunBudget, ProgressGuard } from "../src/run-budget";

it("does not impose hidden round, duration or cumulative token limits", () => {
  const budget = new RunBudget();
  budget.excludeSuspension(-1);
  expect(() => budget.check(10000, 20_000_000)).not.toThrow();
});

it("completes more than 80 productive rounds without replaying tools", async () => {
  const registry = new ToolRegistry();
  let executed = 0;
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
  let rounds = 0;
  const loop = new AgentLoop({
    executor: new ToolExecutor(registry, async () => true),
    model: {
      async *stream() {
        if (++rounds <= 85)
          yield {
            type: "tool-call",
            id: String(rounds),
            name: "advance",
            input: {},
          };
        else yield { type: "text-delta", text: "Done" };
        yield { type: "completed" };
      },
    },
  });
  for await (const _ of loop.run({
    sessionId: "s" as SessionId,
    runId: "r" as RunId,
    signal: new AbortController().signal,
    tools: [],
    messages: [],
  })) {
  }
  expect(rounds).toBe(86);
  expect(executed).toBe(85);
});

it("enforces configurable step and token budgets", () => {
  const budget = new RunBudget({ maxSteps: 30, maxTokens: 1000 });
  expect(() => budget.check(21, 900)).not.toThrow();
  expect(() => budget.check(30, 900)).toThrow("RUN_STEP_BUDGET_EXCEEDED");
  expect(() => budget.check(1, 1000)).toThrow("RUN_TOKEN_BUDGET_EXCEEDED");
  expect(() => new RunBudget({ maxSteps: NaN })).toThrow("Invalid run budget");
});

it("allows polling with changing results but stops identical non-progress", () => {
  const guard = new ProgressGuard();
  const calls = [{ name: "poll", input: {} }];
  for (let i = 0; i < 10; i++) guard.observe(calls, [String(i)]);
  guard.observe(calls, ["9"]);
  expect(() => guard.observe(calls, ["9"])).toThrow("without progress");
});
