import { expect, it } from "vitest";
import { readPluginManifest } from "@modera/plugin-host/testing";
import { resolve } from "node:path";
const pluginManifest = (id: string) => readPluginManifest(resolve("plugins", id));

// A plugin's manifest lives in its `plugin.json`, not in its source: the host
// reads it before any code runs, so a test must do the same.
const browser = pluginManifest("browser");
const websearch = pluginManifest("websearch");
const workspace = pluginManifest("workspace");
const search = pluginManifest("search");
const terminal = pluginManifest("terminal");
const todo = pluginManifest("todo");
const interaction = pluginManifest("interaction");
import {
  ContextManager,
  estimateContext,
} from "../src/context-manager";
import type { ChatMessage, RunId, SessionId } from "@modera/contracts";

const tools = [
  browser,
  websearch,
  workspace,
  search,
  terminal,
  todo,
  interaction,
].flatMap((m) => m.tools ?? []);
const message = (
  id: string,
  role: ChatMessage["role"],
  content: string,
): ChatMessage => ({ id, role, content, createdAt: "2026-09-12" });
const base = {
  runId: "r" as RunId,
  sessionId: "s" as SessionId,
  signal: new AbortController().signal,
};

it.each([true, false])(
  "handles an oversized final tool group, completed=%s",
  async (completed) => {
    const user = message("u", "user", "创建一个看板应用");
    const assistant: ChatMessage = {
      ...message("a", "assistant", "创建应用文件"),
      thinking: "检查布局和交互。".repeat(8500),
      toolCalls: [0, 1, 2].map((i) => ({
        id: `c${i}`,
        name: "workspace_create",
        input: {
          path: `src/view${i}.tsx`,
          content: "const view = 'board';\n".repeat(400),
        },
      })),
    };
    const messages = [
      user,
      assistant,
      ...[0, 1, 2].slice(0, completed ? 3 : 2).map((i) => ({
        ...message(
          `t${i}`,
          "tool",
          JSON.stringify({ ok: true, path: `src/view${i}.tsx` }),
        ),
        toolCallId: `c${i}`,
      })),
    ];
    const before = JSON.stringify(messages);
    let summaries = 0;
    const manager = new ContextManager({
      async *stream(input) {
        summaries++;
        expect(estimateContext(input.messages)).toBeLessThanOrEqual(24000);
        expect(input.messages[1]!.content).toContain("workspace_create");
        yield {
          type: "text-delta",
          text: "已创建三个看板文件；下一步运行构建检查，尚未验证成功。",
        };
        yield { type: "completed" };
      },
    });
    const pending = manager.prepare({ ...base, messages, tools });
    if (!completed) {
      await expect(pending).rejects.toThrow(
        "CONTEXT_PROTECTED_INPUT_TOO_LARGE",
      );
      expect(summaries).toBe(0);
      return;
    }
    const result = await pending;
    expect(result.checkpoint?.throughMessageId).toBe("t2");
    expect(result.messages).toContainEqual(user);
    expect(
      result.messages.some((m) => m.role === "tool" || m.toolCalls?.length),
    ).toBe(false);
    expect(estimateContext(result.messages, tools)).toBeLessThanOrEqual(48000);
    expect(JSON.stringify(messages)).toBe(before);
    expect(
      (await manager.prepare({ ...base, messages, tools })).usages,
    ).toEqual([]);
  },
);

it("continues a short task with every built-in tool and Chinese reasoning", async () => {
  const messages: ChatMessage[] = [
    message("u", "user", "创建一个todo应用，使用 React + Vite + TypeScript"),
  ];
  for (const [i, name] of [
    "workspace_read",
    "search_files",
    "interaction_ask",
    "todo_manage",
  ].entries()) {
    messages.push({
      ...message(`a${i}`, "assistant", "继续实施"),
      thinking: "先检查目录，再根据用户的选择创建文件。".repeat(200),
      toolCalls: [{ id: `c${i}`, name, input: {} }],
    });
    messages.push({
      ...message(`t${i}`, "tool", JSON.stringify({ ok: true, items: [] })),
      toolCallId: `c${i}`,
    });
  }
  expect(tools.length).toBeGreaterThan(25);
  expect(
    Buffer.byteLength(JSON.stringify({ messages, tools })),
  ).toBeGreaterThan(48000);
  expect(estimateContext(messages, tools)).toBeLessThan(48000);
  const manager = new ContextManager({
    async *stream() {
      throw new Error("Unnecessary compaction");
    },
  });
  expect(
    (await manager.prepare({ ...base, messages, tools })).messages,
  ).toEqual(messages);
});

it("compacts when the fixed old summary reserve would reject fitting protected input", async () => {
  const messages = [
    message("u", "user", "保留要求"),
    ...Array.from({ length: 8 }, (_, i) =>
      message(`a${i}`, "assistant", "旧证据".repeat(2500)),
    ),
    message("tail", "assistant", "最新证据"),
  ];
  const protectedCost = estimateContext(
    [messages[0]!, messages.at(-1)!],
    tools,
  );
  const budget = protectedCost + 3000;
  const manager = new ContextManager(
    {
      async *stream() {
        yield {
          type: "text-delta",
          text: "已检查目录；下一步创建应用。保留用户要求。",
        };
        yield { type: "completed" };
      },
    },
    { inputBudget: budget },
  );
  const result = await manager.prepare({ ...base, messages, tools });
  expect(result.checkpoint).toBeDefined();
  expect(result.messages).toContainEqual(messages[0]);
  expect(result.messages).toContainEqual(messages.at(-1));
  expect(estimateContext(result.messages, tools)).toBeLessThanOrEqual(budget);
});
