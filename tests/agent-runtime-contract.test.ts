import { expect, it, vi } from "vitest";
import type {
  AgentEvent,
  AgentRuntime,
  AgentToolExecutor,
  ModelRequest,
  RecoveryBudgetPort,
  RunId,
  SessionId,
} from "@pal/contracts";
import { AgentLoop } from "../src/agent-loop";

const request = (): ModelRequest => ({
  sessionId: "contract-session" as SessionId,
  runId: "contract-run" as RunId,
  messages: [],
  tools: [],
  signal: new AbortController().signal,
});

function fixture() {
  const execute = vi.fn(async () => "host result");
  const reset = vi.fn();
  const recovery: RecoveryBudgetPort = {
    limit: 3,
    used: 0,
    tryConsume: () => true,
    resetAfterSuccess: reset,
  };
  const executor: AgentToolExecutor = {
    definitions: () => [
      {
        id: "probe",
        title: "Probe",
        description: "Probe",
        inputSchema: {},
        requiredPermissions: [],
      },
    ],
    title: () => "Probe",
    execute,
    completedCall: () => ({
      images: [{ mimeType: "image/png", data: "YWJj" }],
    }),
  };
  let calls = 0;
  const runtime: AgentRuntime = new AgentLoop({
    executor,
    model: {
      async *stream(input) {
        expect(input.recovery).toBe(recovery);
        if (++calls === 1)
          yield { type: "tool-call", id: "call", name: "probe", input: {} };
        else yield { type: "text-delta", text: "done" };
        yield { type: "completed" };
      },
    },
  });
  return { runtime, execute, reset, input: { ...request(), recovery } };
}

it("runs with host-owned structural tool and recovery ports", async () => {
  const { runtime, input, execute, reset } = fixture();
  const events: AgentEvent[] = [];
  for await (const event of runtime.run(input)) events.push(event);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(reset).toHaveBeenCalled();
  expect(events.find((event) => event.type === "tool-finished")).toMatchObject({
    message: {
      content: "host result",
      images: [{ mimeType: "image/png", data: "YWJj" }],
    },
  });
  expect(events.at(-1)?.type).toBe("completed");
});

it.each(["tool-round-prepared", "tool-started"] as const)(
  "never dispatches a tool when the host stops at %s",
  async (boundary) => {
    const { runtime, input, execute } = fixture();
    let reached = false;
    for await (const event of runtime.run(input)) {
      if (event.type === boundary) {
        reached = true;
        break;
      }
    }
    expect(reached).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  },
);
