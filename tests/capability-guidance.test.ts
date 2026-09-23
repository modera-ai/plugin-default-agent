import { expect, it } from "vitest";
import { AgentLoop } from "../src/agent-loop";
import { ToolExecutor, ToolRegistry } from "@modera/agent-host";
import { type ModelAdapter } from "@modera/contracts";
import type { RunId, SessionId } from "@modera/contracts";
import { parsePluginManifest } from "@modera/plugin-host";

const context = {
  sessionId: "session" as SessionId,
  runId: "run" as RunId,
  projectId: "project",
  signal: new AbortController().signal,
};

function register(registry: ToolRegistry, owner: string, id: string) {
  registry.register(owner, {
    definition: {
      id,
      title: id,
      description: id,
      inputSchema: { type: "object" },
      requiredPermissions: [],
    },
    execute: async () => "ok",
  });
}

it("orders enabled guidance stably and removes disabled capabilities", () => {
  const registry = new ToolRegistry();
  register(registry, "z-plugin", "z_tool");
  register(registry, "a-plugin", "a_tool");
  registry.registerGuidance("z-plugin", "Z guidance");
  registry.registerGuidance("a-plugin", "A guidance");
  const executor = new ToolExecutor(registry, async () => true);

  expect(executor.definitions(context).map((tool) => tool.id)).toEqual([
    "a_tool",
    "z_tool",
  ]);
  expect(executor.guidance(context)).toEqual(["A guidance", "Z guidance"]);
  registry.setEnabled("a_tool", false);
  expect(executor.guidance(context)).toEqual(["Z guidance"]);
});

it("removes refused capability guidance from the next model round", async () => {
  const registry = new ToolRegistry();
  register(registry, "search-plugin", "search_tool");
  registry.registerGuidance("search-plugin", "Search guidance sentinel");
  const executor = new ToolExecutor(registry, async () => false);
  const prompts: string[] = [];
  let round = 0;
  const model: ModelAdapter = {
    async *stream(request) {
      prompts.push(request.messages[0]?.content ?? "");
      if (round++ === 0)
        yield { type: "tool-call", id: "call", name: "search_tool", input: {} };
      else yield { type: "text-delta", text: "done" };
      yield { type: "completed" };
    },
  };
  for await (const _ of new AgentLoop({ model, executor }).run({
    ...context,
    messages: [],
    tools: [],
  })) {
    // Drain.
  }
  expect(prompts[0]).toContain("Search guidance sentinel");
  expect(prompts[1]).not.toContain("Search guidance sentinel");
});

it("bounds declarative agent guidance in plugin manifests", () => {
  const base = {
    apiVersion: 1,
    id: "example.guidance",
    name: "Guidance",
    version: "1.0.0",
    main: "index.cjs",
    permissions: [],
  };
  expect(
    parsePluginManifest({ ...base, agentGuidance: "Use exact evidence." }),
  ).toMatchObject({ agentGuidance: "Use exact evidence." });
  expect(() =>
    parsePluginManifest({ ...base, agentGuidance: "x".repeat(2001) }),
  ).toThrow();
});
