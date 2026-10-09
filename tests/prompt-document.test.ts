import { expect, it } from "vitest";
import { AgentLoop } from "../src/agent-loop";
import type { ModelRequest, SessionId, RunId } from "@modera/contracts";

it("sends edited source text to the model while leaving conversation history unchanged", async () => {
  const requests: ModelRequest[] = [];
  const messages = [
    { id: "user", role: "user" as const, createdAt: "now", content: "Hello" },
  ];
  const loop = new AgentLoop({
    model: {
      async *stream(request) {
        requests.push(request);
        yield { type: "completed" as const };
      },
    },
    collectPromptSections: async () => [
      {
        owner: "instructions",
        id: "agents",
        source: "AGENTS.md",
        text: "Original project",
      },
    ],
    transformPromptDocument: async (blocks) =>
      blocks.map((block) =>
        block.kind === "base"
          ? { ...block, text: "Edited policy" }
          : block.id === "agents"
            ? { ...block, text: "Edited project" }
            : block,
      ),
  });
  for await (const _ of loop.run({
    messages,
    tools: [],
    signal: new AbortController().signal,
    sessionId: "session" as SessionId,
    runId: "run" as RunId,
  })) {
    /* consume */
  }
  expect(requests[0]?.messages[0]?.content).toContain("Edited policy");
  expect(requests[0]?.messages[0]?.content).toContain("Edited project");
  expect(requests[0]?.messages[0]?.content).not.toContain("Original project");
  expect(messages).toHaveLength(1);
  expect(messages[0]?.content).toBe("Hello");
});
