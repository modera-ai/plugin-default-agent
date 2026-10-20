import { expect, it } from "vitest";
import { completionOrder, toolBatches } from "../src/tool-scheduler";
import type { ToolDefinition } from "@pal/contracts";
import { AgentLoop } from "../src/agent-loop";
import { ToolExecutor, ToolRegistry } from "@modera/agent-host";
import type { RunId, SessionId } from "@pal/contracts";

const definitions: ToolDefinition[] = [
  "read",
  "write",
  "question",
  "group",
].map((id) => ({
  id,
  title: id,
  description: id,
  inputSchema: {},
  requiredPermissions: [],
  ...(id !== "write" ? { concurrency: "independent-read" as const } : {}),
  ...(id === "question" ? { executionKind: "interaction" as const } : {}),
  ...(id === "group" ? { approvalGroup: "group" } : {}),
}));
const call = (name: string) => ({ name, input: {}, id: name });

it("respects mutation and interaction barriers and bounds batches", () => {
  const names = [
    "read",
    "read",
    "read",
    "write",
    "read",
    "question",
    "group",
    "unknown",
    "read",
  ];
  expect(
    toolBatches(names.map(call), definitions, 2).map((batch) =>
      batch.map((c) => c.name),
    ),
  ).toEqual([
    ["read", "read"],
    ["read"],
    ["write"],
    ["read"],
    ["question"],
    ["group"],
    ["unknown"],
    ["read"],
  ]);
});

it("allows independent reads with approval groups to share a batch", () => {
  expect(
    toolBatches([call("read"), call("group"), call("group")], definitions).map(
      (batch) => batch.map((call) => call.name),
    ),
  ).toEqual([["read", "group", "group"]]);
});

it("starts independent work together and emits completion order with original indices", async () => {
  let finishFirst!: (value: string) => void;
  let finishSecond!: (value: string) => void;
  const iterator = completionOrder([
    () =>
      new Promise<string>((resolve) => {
        finishFirst = resolve;
      }),
    () =>
      new Promise<string>((resolve) => {
        finishSecond = resolve;
      }),
  ]);
  const next = iterator.next();
  await Promise.resolve();
  finishSecond("second");
  expect((await next).value).toEqual({ index: 1, value: "second" });
  finishFirst("first");
  expect((await iterator.next()).value).toEqual({ index: 0, value: "first" });
  expect((await iterator.next()).done).toBe(true);
});

it("drains started tasks before propagating errors, including undefined rejections", async () => {
  let drained = false;
  const consume = async () => {
    for await (const _ of completionOrder([
      () => Promise.reject(undefined),
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        drained = true;
        return 1;
      },
    ])) {
    }
  };
  await expect(consume()).rejects.toBeUndefined();
  expect(drained).toBe(true);
});

it("runs reads concurrently but persists complete results in call order", async () => {
  const registry = new ToolRegistry();
  let started = 0;
  let release!: () => void;
  const bothStarted = new Promise<void>((resolve) => {
    release = resolve;
  });
  registry.register("test", {
    definition: { ...definitions[0]!, approvalGroup: "read-access" },
    async execute(input) {
      started++;
      if (started === 2) release();
      await bothStarted;
      if ((input as { slow: boolean }).slow)
        await new Promise((resolve) => setTimeout(resolve, 15));
      return input;
    },
  });
  let rounds = 0;
  const loop = new AgentLoop({
    executor: new ToolExecutor(registry, async () => true),
    model: {
      async *stream(request) {
        if (rounds++ === 0) {
          yield {
            type: "tool-call",
            id: "one",
            name: "read",
            input: { slow: true },
          };
          yield {
            type: "tool-call",
            id: "two",
            name: "read",
            input: { slow: false },
          };
        } else
          expect(
            request.messages
              .filter((m) => m.role === "tool")
              .map((m) => m.toolCallId),
          ).toEqual(["one", "two"]);
        yield { type: "completed" };
      },
    },
  });
  const finished: string[] = [];
  for await (const event of loop.run({
    sessionId: "s" as SessionId,
    runId: "r" as RunId,
    signal: new AbortController().signal,
    messages: [],
    tools: [],
  })) {
    if (event.type === "tool-finished")
      finished.push(event.message.toolCallId!);
  }
  expect(finished).toEqual(["two", "one"]);
});
