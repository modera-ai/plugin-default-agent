import { expect, it } from "vitest";
import { ContinuingModel } from "../src/model-continuation";
import {
  ModelLimitError,
  ModelStreamInterruptedError,
  type ModelAdapter,
  type ModelStreamEvent,
} from "@pal/contracts";
import { RecoveryBudget } from "../src/recovery-budget";
import type { RunId, SessionId } from "@pal/contracts";
const request = {
  sessionId: "s" as SessionId,
  runId: "r" as RunId,
  messages: [],
  tools: [],
  signal: new AbortController().signal,
};

it.each(["", "Preparing the requested question. "])(
  "regenerates partial tool arguments with prefix %j and sums usage",
  async (prefix) => {
    let attempts = 0;
    const events: ModelStreamEvent[] = [];
    const adapter: ModelAdapter = {
      async *stream(input) {
        if (!attempts++) {
          if (prefix) yield { type: "text-delta", text: prefix };
          throw new ModelStreamInterruptedError(
            "tool-arguments-partial",
            "invalid JSON",
            { inputTokens: 10, outputTokens: 3 },
          );
        }
        expect(input.messages.at(-1)?.content).toContain(
          "Regenerate the intended tool call",
        );
        expect(
          input.messages.filter(
            (message) => message.role === "assistant" && !message.content,
          ),
        ).toHaveLength(0);
        if (prefix) yield { type: "text-delta", text: prefix };
        yield {
          type: "tool-call",
          id: "question",
          name: "ask_user_question",
          input: { questions: [{ title: "Question" }] },
        };
        yield {
          type: "completed",
          usage: { inputTokens: 20, outputTokens: 4 },
        };
      },
    };
    for await (const event of new ContinuingModel(adapter).stream(request))
      events.push(event);
    expect(attempts).toBe(2);
    expect(events.filter((event) => event.type === "tool-call")).toHaveLength(
      1,
    );
    expect(
      events
        .filter((event) => event.type === "text-delta")
        .map((event) => event.text)
        .join(""),
    ).toBe(prefix);
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      usage: { inputTokens: 30, outputTokens: 7 },
    });
  },
);

it("does not regenerate partial tool arguments when shared recovery is exhausted", async () => {
  let attempts = 0;
  const adapter: ModelAdapter = {
    async *stream() {
      attempts++;
      throw new ModelStreamInterruptedError(
        "tool-arguments-partial",
        "invalid JSON",
      );
    },
  };
  await expect(
    (async () => {
      for await (const _ of new ContinuingModel(adapter).stream({
        ...request,
        recovery: new RecoveryBudget(0),
      })) {
        /* drain */
      }
    })(),
  ).rejects.toMatchObject({ state: "tool-arguments-partial" });
  expect(attempts).toBe(1);
});

it("continues from the prefix, removes an exact repeated prefix and sums usage", async () => {
  const prefix = "This is the already visible response prefix. ";
  let calls = 0;
  const adapter: ModelAdapter = {
    async *stream(input) {
      if (!calls++) {
        yield { type: "text-delta", text: prefix };
        throw new ModelLimitError("output", "limit", {
          canContinueText: true,
          usage: { inputTokens: 10, outputTokens: 5 },
        });
      }
      expect(input.messages.at(-2)?.content).toBe(prefix);
      yield { type: "text-delta", text: prefix.slice(0, 10) };
      yield { type: "text-delta", text: prefix.slice(10) + "The rest." };
      yield { type: "completed", usage: { inputTokens: 20, outputTokens: 6 } };
    },
  };
  const events: ModelStreamEvent[] = [];
  for await (const event of new ContinuingModel(adapter).stream(request))
    events.push(event);
  expect(
    events
      .filter((e) => e.type === "text-delta")
      .map((e) => e.text)
      .join(""),
  ).toBe(prefix + "The rest.");
  expect(events.at(-1)).toMatchObject({
    type: "completed",
    usage: { inputTokens: 30, outputTokens: 11 },
  });
  expect(calls).toBe(2);
});

it.each([false, undefined])(
  "does not continue an unsafe or unspecified partial tool state (%s)",
  async (canContinueText) => {
    let calls = 0;
    const adapter: ModelAdapter = {
      async *stream() {
        calls++;
        yield { type: "text-delta", text: "partial" };
        throw new ModelLimitError(
          "output",
          "limit",
          canContinueText === undefined ? undefined : { canContinueText },
        );
      },
    };
    await expect(
      (async () => {
        for await (const _ of new ContinuingModel(adapter).stream(request)) {
        }
      })(),
    ).rejects.toMatchObject({ kind: "output" });
    expect(calls).toBe(1);
  },
);

it("bounds repeated truncation and never continues cancellation", async () => {
  let calls = 0;
  const adapter: ModelAdapter = {
    async *stream() {
      calls++;
      yield { type: "text-delta", text: "more text" };
      throw new ModelLimitError("output", "limit", { canContinueText: true });
    },
  };
  await expect(
    (async () => {
      for await (const _ of new ContinuingModel(adapter).stream(request)) {
      }
    })(),
  ).rejects.toMatchObject({ kind: "output" });
  expect(calls).toBe(3);
  const controller = new AbortController();
  controller.abort();
  await expect(
    (async () => {
      for await (const _ of new ContinuingModel(adapter).stream({
        ...request,
        signal: controller.signal,
      })) {
      }
    })(),
  ).rejects.toBeDefined();
  expect(calls).toBe(3);
});

it("continues a text-only stream interruption and includes failed-call usage", async () => {
  let calls = 0;
  const adapter: ModelAdapter = {
    async *stream() {
      calls++;
      if (calls === 1) {
        yield { type: "text-delta", text: "partial response " };
        throw new ModelStreamInterruptedError(
          "text-partial",
          "connection reset",
          { inputTokens: 10, outputTokens: 3 },
        );
      }
      yield { type: "text-delta", text: "completed" };
      yield { type: "completed", usage: { inputTokens: 20, outputTokens: 4 } };
    },
  };
  const events: ModelStreamEvent[] = [];
  const recovery = new RecoveryBudget(1);
  for await (const event of new ContinuingModel(adapter).stream({
    ...request,
    recovery,
  }))
    events.push(event);
  expect(events.at(-1)).toMatchObject({
    type: "completed",
    usage: { inputTokens: 30, outputTokens: 7 },
  });
  expect(calls).toBe(2);
  expect(recovery.used).toBe(1);
});

it.each(["stream-empty", "thinking-only", "tool-calls-complete"] as const)(
  "does not continue unsafe interrupted state %s",
  async (state) => {
    let calls = 0;
    const adapter: ModelAdapter = {
      async *stream() {
        calls++;
        if (state !== "stream-empty")
          yield { type: "thinking-delta", text: "partial" };
        throw new ModelStreamInterruptedError(state, "stopped");
      },
    };
    await expect(
      (async () => {
        for await (const _ of new ContinuingModel(adapter).stream(request)) {
          // Drain.
        }
      })(),
    ).rejects.toMatchObject({ state });
    expect(calls).toBe(1);
  },
);

it("stops continuation when the shared recovery allowance is exhausted", async () => {
  let calls = 0;
  const adapter: ModelAdapter = {
    async *stream() {
      calls++;
      yield { type: "text-delta", text: "partial" };
      throw new ModelStreamInterruptedError("text-partial", "stopped");
    },
  };
  await expect(
    (async () => {
      for await (const _ of new ContinuingModel(adapter).stream({
        ...request,
        recovery: new RecoveryBudget(0),
      })) {
        // Drain.
      }
    })(),
  ).rejects.toMatchObject({ state: "text-partial" });
  expect(calls).toBe(1);
});
