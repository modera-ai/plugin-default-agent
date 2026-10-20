import { expect, it, vi } from "vitest";
import { AgentLoop } from "../src/agent-loop";
import { withSystemPolicy } from "../src/system-prompt";
it("includes attributed sections in the system message without requiring tools", async () => {
 const collectPromptSections = vi.fn(async () => [{ owner: "example", id: "format", source: "Formatting", text: "Use named file links." }]);
 let policy = "";
 const loop = new AgentLoop({ collectPromptSections, transformPromptDocument: async blocks => { expect(blocks.find(block => block.id === "format")?.kind).toBe("guidance"); return undefined; }, model: { async *stream(request) { policy = request.messages[0]!.content; yield { type: "completed" as const }; } } });
 for await (const event of loop.run({ sessionId: "s", runId: "r", messages: [], tools: [], signal: new AbortController().signal })) {}
 expect(collectPromptSections).toHaveBeenCalledOnce();
 expect(policy).toContain("Use named file links.");
 expect(policy).toContain("你是 Modera");
});
it("preserves the base policy and source attribution", () => {
 const policy = withSystemPolicy([], [{ owner: "example", id: "project", source: "AGENTS.md", text: "Use pnpm." }])[0]!.content;
 expect(policy).toContain("AGENTS.md"); expect(policy).toContain("Use pnpm."); expect(policy).toContain("用户的明确要求优先");
});
