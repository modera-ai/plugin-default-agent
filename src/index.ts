import {
  AGENT_RUNTIME_CONTRACT,
  type AgentRunInvocation,
  type PluginModule,
} from "@modera/contracts";
import { AgentLoop } from "./agent-loop";

export const activate: PluginModule["activate"] = async () => ({
  services: {
    "modera.default-agent.runtime": {
      ...AGENT_RUNTIME_CONTRACT,
      methods: {
        run: {
          // The Agent enforces active-time budgets; pausing must not consume a channel deadline.
          timeoutMs: 0,
          call: async () => {
            throw new Error("Agent runtime requires streaming");
          },
          async *stream(input, context) {
            const { dependencies, request } = input as AgentRunInvocation;
            const signal = AbortSignal.any([request.signal, context.signal]);
            yield* new AgentLoop(dependencies).run({ ...request, signal });
          },
        },
      },
    },
  },
});
