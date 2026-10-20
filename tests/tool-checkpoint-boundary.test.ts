import { expect, it } from "vitest";
import { AgentLoop } from "../src/agent-loop";
import { ToolExecutor, ToolRegistry } from "@modera/agent-host";
import type { RunId, SessionId } from "@pal/contracts";

it.each(["tool-round-prepared", "tool-started"])(
  "does not execute a tool if the host cannot persist %s",
  async (failurePoint) => {
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register("test", {
      definition: {
        id: "write",
        title: "write",
        description: "write",
        inputSchema: {},
        requiredPermissions: [],
      },
      async execute() {
        executions++;
        return "written";
      },
    });
    const loop = new AgentLoop({
      executor: new ToolExecutor(registry, async () => true),
      model: {
        async *stream() {
          yield { type: "tool-call", id: "call", name: "write", input: {} };
          yield { type: "completed" };
        },
      },
    });
    await expect(
      (async () => {
        for await (const event of loop.run({
          sessionId: "s" as SessionId,
          runId: "r" as RunId,
          tools: [],
          messages: [],
          signal: new AbortController().signal,
        })) {
          if (event.type === failurePoint) throw new Error("disk failed");
        }
      })(),
    ).rejects.toThrow("disk failed");
    expect(executions).toBe(0);
  },
);

it("does not start the next write if saving the previous result fails", async () => {
  const executed: unknown[] = [];
  const registry = new ToolRegistry();
  registry.register("test", {
    definition: {
      id: "write",
      title: "write",
      description: "write",
      inputSchema: {},
      requiredPermissions: [],
    },
    async execute(input) {
      executed.push(input);
      return "written";
    },
  });
  const loop = new AgentLoop({
    executor: new ToolExecutor(registry, async () => true),
    model: {
      async *stream() {
        yield {
          type: "tool-call",
          id: "first",
          name: "write",
          input: { file: 1 },
        };
        yield {
          type: "tool-call",
          id: "second",
          name: "write",
          input: { file: 2 },
        };
        yield { type: "completed" };
      },
    },
  });
  await expect(
    (async () => {
      for await (const event of loop.run({
        sessionId: "s" as SessionId,
        runId: "r" as RunId,
        tools: [],
        messages: [],
        signal: new AbortController().signal,
      })) {
        if (event.type === "tool-finished") throw new Error("disk failed");
      }
    })(),
  ).rejects.toThrow("disk failed");
  expect(executed).toEqual([{ file: 1 }]);
});
