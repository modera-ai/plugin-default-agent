import { it, expect } from "vitest";
import { AgentLoop } from "../src/agent-loop";
import { ToolExecutor, ToolRegistry } from "@modera/agent-host";
import { type ModelAdapter } from "@pal/contracts";
import type { SessionId, RunId, ChatMessage } from "@pal/contracts";

it("refreshes plugin context per round without persisting it, and binds current user evidence", async () => {
  const registry = new ToolRegistry();
  let enabled = true;
  registry.register("test", {
    definition: {
      id: "disable",
      title: "disable",
      description: "test",
      inputSchema: { type: "object" },
      requiredPermissions: [],
    },
    execute: async (_input, context) => {
      expect(context.userMessage).toEqual({
        id: "user",
        text: "remember this",
      });
      enabled = false;
      return "disabled";
    },
  });
  const snapshots: ChatMessage[][] = [];
  let rounds = 0;
  const model: ModelAdapter = {
    async *stream(request) {
      snapshots.push([...request.messages]);
      if (rounds++ === 0)
        yield { type: "tool-call", id: "call", name: "disable", input: {} };
      else yield { type: "text-delta", text: "done" };
      yield { type: "completed", usage: { inputTokens: 20, outputTokens: 5 } };
    },
  };
  const loop = new AgentLoop({
    model,
    executor: new ToolExecutor(registry, async () => true),
    collectContext: async () =>
      enabled
        ? [{ owner: "test", id: "memory", text: "unique historical memory" }]
        : [],
  });
  const persisted: ChatMessage[] = [];
  for await (const event of loop.run({
    sessionId: "s" as SessionId,
    runId: "r" as RunId,
    signal: new AbortController().signal,
    tools: [],
    messages: [
      {
        id: "user",
        role: "user",
        content: "remember this",
        createdAt: new Date().toISOString(),
      },
    ],
  })) {
    if (event.type === "messages") persisted.push(...event.messages);
  }
  expect(snapshots).toHaveLength(2);
  expect(JSON.stringify(snapshots[0])).toContain("unique historical memory");
  expect(JSON.stringify(snapshots[1])).not.toContain(
    "unique historical memory",
  );
  expect(JSON.stringify(persisted)).not.toContain("unique historical memory");
});
