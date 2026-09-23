import { expect, it } from "vitest";
import { AgentLoop } from "../src/agent-loop";
import type { RunId, SessionId } from "@modera/contracts";
import type { RunDiagnostic } from "../src/run-diagnostics";

const request = {
  sessionId: "s" as SessionId,
  runId: "r" as RunId,
  messages: [],
  tools: [],
  signal: new AbortController().signal,
};

it("reports failed model rounds without including streamed text", async () => {
  const events: RunDiagnostic[] = [];
  const loop = new AgentLoop({
    model: {
      async *stream() {
        yield { type: "text-delta" as const, text: "private text" };
        throw new Error("offline");
      },
    },
    diagnostics: (event) => events.push(event),
  });
  await expect(
    (async () => {
      for await (const _event of loop.run(request)) {
        /* consume */
      }
    })(),
  ).rejects.toThrow("offline");
  expect(events).toHaveLength(1);
  expect(events[0]?.outcome).toBe("interrupted");
  expect(JSON.stringify(events)).not.toContain("private text");
});

it("does not let a failing diagnostic sink interrupt generation", async () => {
  const loop = new AgentLoop({
    model: {
      async *stream() {
        yield { type: "completed" as const };
      },
    },
    diagnostics: () => {
      throw new Error("sink");
    },
  });
  const events = [];
  for await (const event of loop.run(request)) events.push(event);
  expect(events.at(-1)?.type).toBe("completed");
});
