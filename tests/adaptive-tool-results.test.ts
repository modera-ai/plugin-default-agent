import { expect, it } from "vitest";
import { AgentLoop } from "../src/agent-loop";
import { ToolExecutor, ToolRegistry } from "@modera/agent-host";
import type { RunId, SessionId } from "@pal/contracts";
import { estimateContext } from "../src/context-manager";

const context = {
  sessionId: "s" as SessionId,
  runId: "r" as RunId,
  projectId: "p",
  signal: new AbortController().signal,
};
it("retains UTF-8 results smaller than the legacy character threshold and pages them within the caller budget", async () => {
  const registry = new ToolRegistry();
  let executions = 0;
  const original = {
    path: "日志.txt",
    content: '中文😀\\"\n'.repeat(600),
    totalLines: 231,
    hasMore: true,
    nextLine: 101,
  };
  registry.register("fixture", {
    definition: {
      id: "read",
      title: "read",
      description: "",
      inputSchema: {},
      requiredPermissions: [],
    },
    execute: async () => {
      executions++;
      return original;
    },
  });
  const executor = new ToolExecutor(registry, async () => true);
  const result = await executor.execute(
    { id: "first", name: "read", input: {} },
    context,
    768,
  );
  expect(Buffer.byteLength(result)).toBeLessThanOrEqual(768);
  const preview = JSON.parse(result);
  expect(preview.truncated).toBe(true);
  expect(preview.resultRef).toEqual(expect.any(String));
  expect(preview.preview).toMatchObject({
    totalLines: 231,
    hasMore: true,
    nextLine: 101,
  });
  let offset = 0,
    recovered = "";
  do {
    const raw = await executor.execute(
      {
        id: `page-${offset}`,
        name: "tool_result_read",
        input: { resultRef: preview.resultRef, offset, length: 3000 },
      },
      context,
      768,
    );
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(768);
    const page = JSON.parse(raw);
    recovered += page.content;
    expect(page.nextOffset).toBeGreaterThan(offset);
    offset = page.nextOffset;
    if (!page.hasMore) break;
  } while (offset < JSON.stringify(original).length);
  expect(JSON.parse(recovered)).toEqual(original);
  expect(executions).toBe(1);
  registry.setEnabled("read", false);
  const denied = JSON.parse(
    await executor.execute(
      {
        id: "revoked",
        name: "tool_result_read",
        input: { resultRef: preview.resultRef },
      },
      context,
      768,
    ),
  );
  expect(denied.error).toBe("RESULT_REFERENCE_UNAVAILABLE");
});

it("keeps a large recent read usable in a small-context loop without dropping original instructions", async () => {
  const registry = new ToolRegistry();
  registry.register("fixture", {
    definition: {
      id: "read",
      title: "read",
      description: "Read a long log",
      inputSchema: {},
      requiredPermissions: [],
    },
    execute: async () => ({
      content: "a long diagnostic line\n".repeat(600),
      path: "startup.log",
      hasMore: false,
    }),
  });
  let rounds = 0;
  const loop = new AgentLoop({
    context: { inputBudget: 16000 },
    executor: new ToolExecutor(registry, async () => true),
    model: {
      async *stream(request) {
        expect(
          estimateContext(request.messages, request.tools),
        ).toBeLessThanOrEqual(16000);
        expect(
          request.messages.some(
            (message) =>
              message.content === "Find the failure; never change logs.",
          ),
        ).toBe(true);
        if (rounds++ === 0)
          yield { type: "tool-call", id: "read-log", name: "read", input: {} };
        else {
          const result = JSON.parse(
            request.messages.find((message) => message.role === "tool")!
              .content,
          );
          expect(result.truncated).toBe(true);
          expect(result.readTool).toBe("tool_result_read");
          yield {
            type: "text-delta",
            text: "Narrow the read or use the result reference.",
          };
        }
        yield { type: "completed" };
      },
    },
  });
  for await (const _ of loop.run({
    ...context,
    tools: [],
    messages: [
      {
        id: "user",
        role: "user",
        content: "Find the failure; never change logs.",
        createdAt: "",
      },
    ],
  })) {
  }
  expect(rounds).toBe(2);
});
