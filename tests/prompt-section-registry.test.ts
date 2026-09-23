import { describe, expect, it } from "vitest";
import { AgentLoop } from "../src/agent-loop";
import { type ModelAdapter } from "@modera/contracts";
import { PromptSectionRegistry } from "@modera-host/agent-host/src/prompt-section-registry";
import { withSystemPolicy } from "../src/system-prompt";
import type {
  PromptSection,
  PromptSectionContribution,
  RunId,
  SessionId,
} from "@modera/contracts";

const request = () => ({
  sessionId: "s" as SessionId,
  runId: "r" as RunId,
  projectId: "a",
  signal: new AbortController().signal,
});

const provider = (
  sections: readonly PromptSection[],
): PromptSectionContribution => ({ provide: async () => sections });

describe("prompt sections", () => {
  it("collects attributed sections from available owners only", async () => {
    const registry = new PromptSectionRegistry(
      (owner, project) => owner === "allowed" && project === "a",
    );
    registry.register("denied", [provider([{ id: "x", text: "must not run" }])]);
    registry.register("allowed", [
      provider([{ id: "agents", source: "AGENTS.md", text: "用 pnpm" }]),
    ]);
    expect(await registry.collect(request())).toEqual([
      { owner: "allowed", id: "agents", source: "AGENTS.md", text: "用 pnpm" },
    ]);
  });

  it("rejects a duplicate owner and releases the id on dispose", async () => {
    const registry = new PromptSectionRegistry(() => true);
    const dispose = registry.register("one", [provider([{ id: "a", text: "x" }])]);
    expect(() =>
      registry.register("one", [provider([{ id: "b", text: "y" }])]),
    ).toThrow("Duplicate prompt section owner");
    dispose();
    expect(await registry.collect(request())).toEqual([]);
  });

  it("caps total characters and section count", async () => {
    const registry = new PromptSectionRegistry(() => true);
    registry.register("big", [provider([{ id: "a", text: "x".repeat(5000) }])]);
    const sections = await registry.collect(request());
    expect(sections).toHaveLength(1);
    expect(sections[0]?.text.length).toBe(4000);

    const many = new PromptSectionRegistry(() => true);
    many.register("many", [
      provider(
        Array.from({ length: 20 }, (_, index) => ({
          id: `s${index}`,
          text: "t",
        })),
      ),
    ]);
    expect(await many.collect(request())).toHaveLength(8);
  });

  it("isolates provider failure and drops unusable sections", async () => {
    const registry = new PromptSectionRegistry(() => true);
    registry.register("broken", [
      {
        provide: async () => {
          throw new Error("unreadable");
        },
      },
    ]);
    registry.register("ok", [
      provider([
        { id: "blank", text: "   " },
        { id: "keep", text: "keep" },
      ]),
    ]);
    expect(await registry.collect(request())).toEqual([
      { owner: "ok", id: "keep", text: "keep" },
    ]);
  });

  it("discards an in-flight contribution after unregister", async () => {
    const registry = new PromptSectionRegistry(() => true);
    let finish!: (value: PromptSection[]) => void;
    const dispose = registry.register("slow", [
      {
        provide: () =>
          new Promise<PromptSection[]>(resolve => {
            finish = resolve;
          }),
      },
    ]);
    const pending = registry.collect(request());
    dispose();
    finish([{ id: "stale", text: "old" }]);
    expect(await pending).toEqual([]);
  });
});

describe("system policy composition", () => {
  const message = {
    id: "m",
    role: "user" as const,
    createdAt: "now",
    content: "hi",
  };

  it("appends project material without replacing the base policy", () => {
    const [policy] = withSystemPolicy([message], [], [
      {
        owner: "modera.instructions",
        id: "agents",
        source: "AGENTS.md",
        text: "本项目用 pnpm",
      },
    ]);
    expect(policy?.content).toContain("你是 Modera");
    expect(policy?.content).toContain("本项目用 pnpm");
    expect(policy?.content).toContain("AGENTS.md");
    expect(policy?.content).toContain("用户的明确要求始终优先");
  });

  it("omits the section when nothing is contributed", () => {
    const [policy] = withSystemPolicy([message]);
    expect(policy?.content).not.toContain("来自工作区文件");
  });

  it("injects collected sections into the model system message", async () => {
    const registry = new PromptSectionRegistry(() => true);
    registry.register("modera.instructions", [
      provider([
        { id: "agents", source: "AGENTS.md", text: "本项目用 pnpm，不要用 npm" },
      ]),
    ]);
    const prompts: string[] = [];
    const model: ModelAdapter = {
      async *stream(value) {
        prompts.push(value.messages[0]?.content ?? "");
        yield { type: "text-delta", text: "done" };
        yield { type: "completed" };
      },
    };
    const loop = new AgentLoop({
      model,
      collectPromptSections: value => registry.collect(value),
    });
    for await (const _ of loop.run({
      sessionId: "session" as SessionId,
      runId: "run" as RunId,
      projectId: "project",
      signal: new AbortController().signal,
      messages: [],
      tools: [],
    })) {
      // Drain.
    }
    expect(prompts[0]).toContain("你是 Modera");
    expect(prompts[0]).toContain("本项目用 pnpm，不要用 npm");
  });
});
