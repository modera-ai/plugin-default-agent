import { expect, it } from "vitest";
import type { ChatMessage, RunId, SessionId } from "@pal/contracts";
import {
  ContextManager,
  applyCheckpoint,
  estimateContext,
} from "../src/context-manager";
const message = (
  id: string,
  role: ChatMessage["role"],
  content: string,
): ChatMessage => ({ id, role, content, createdAt: "" });
const base = {
  runId: "r" as RunId,
  sessionId: "s" as SessionId,
  tools: [],
  signal: new AbortController().signal,
};

it("hands off older requirements and refusals while preserving latest instructions and original history", async () => {
  const raw = [
    message(
      "original",
      "user",
      "Build a board. Do not upload private files or push commits.",
    ),
  ];
  for (let i = 0; i < 20; i++)
    raw.push(
      message(
        `u${i}`,
        "user",
        `Correction ${i}: keep keyboard support. ` +
          "Detailed requirement. ".repeat(200),
      ),
      message(
        `a${i}`,
        "assistant",
        "Implemented locally; still needs validation.",
      ),
    );
  raw.push(
    message(
      "latest",
      "user",
      "Use a local database. The earlier no-upload restriction still applies.",
    ),
  );
  const original = JSON.stringify(raw);
  let summaryInput = "";
  const manager = new ContextManager(
    {
      async *stream(request) {
        summaryInput += request.messages[1]!.content;
        yield {
          type: "text-delta",
          text: "Board: keep keyboard support, use a local database. Never upload private files or push commits. Changes need validation.",
        };
        yield { type: "completed" };
      },
    },
    { inputBudget: 12000 },
  );
  const result = await manager.prepare({ ...base, messages: raw });
  expect(summaryInput).toContain("Do not upload private files or push commits");
  expect(summaryInput).toContain("Correction 0");
  expect(result.messages).toContainEqual(raw.at(-1));
  expect(
    result.messages.find((m) => m.id === "context-handoff")?.content,
  ).toContain("Never upload private files or push commits");
  expect(result.messages.filter((m) => m.role === "user").length).toBeLessThan(
    5,
  );
  expect(estimateContext(result.messages)).toBeLessThanOrEqual(12000);
  expect(JSON.stringify(raw)).toBe(original);
  expect(applyCheckpoint(raw, result.checkpoint)).toEqual(result.messages);
  expect((await manager.prepare({ ...base, messages: raw })).usages).toEqual(
    [],
  );
});

it("retains original users when reading a legacy checkpoint", () => {
  const raw = [
    message("u", "user", "Do not push"),
    message("a", "assistant", "Done"),
  ];
  expect(
    applyCheckpoint(raw, {
      version: 1,
      throughMessageId: "a",
      summary: "Summary",
      createdAt: "",
    }),
  ).toContainEqual(raw[0]);
});

it("carries the previous handoff into a later compaction after reloading", async () => {
  const seen: string[] = [];
  const model = {
    async *stream(request: import("@pal/contracts").ModelRequest) {
      seen.push(request.messages[1]!.content);
      yield {
        type: "text-delta" as const,
        text: "Do not push. Keyboard support remains required. Latest correction: use SQLite.",
      };
      yield { type: "completed" as const };
    },
  };
  const raw = [
    message("u", "user", "Do not push. Keep keyboard support."),
    message("a", "assistant", "implementation details ".repeat(3000)),
    message("v", "user", "Continue"),
  ];
  const first = await new ContextManager(model, { inputBudget: 8000 }).prepare({
    ...base,
    messages: raw,
  });
  expect(first.checkpoint).toBeDefined();
  seen.length = 0;
  const continued = [
    ...raw,
    message("b", "assistant", "new evidence ".repeat(3000)),
    message("correction", "user", "Correction: use SQLite."),
  ];
  const next = await new ContextManager(
    model,
    { inputBudget: 8000 },
    first.checkpoint,
  ).prepare({ ...base, messages: continued });
  expect(JSON.parse(seen[0]!).previousHandoff).toContain(
    "Do not push. Keyboard support remains required.",
  );
  expect(next.messages).toContainEqual(continued.at(-1));
  expect(
    next.messages.find((m) => m.id === "context-handoff")?.content,
  ).toContain("Do not push");
  expect(next.checkpoint?.throughMessageId).not.toBe(
    first.checkpoint?.throughMessageId,
  );
});
