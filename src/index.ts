import {
  AGENT_RUNTIME_CONTRACT,
  type AgentRunInvocation,
  type PluginModule,
} from "@pal/contracts";
import { AgentLoop } from "./agent-loop";
import { BASE_SYSTEM_POLICY } from "./system-prompt";

export const activate: PluginModule["activate"] = async (host) => ({
  promptPolicy: {
    id: "pal.default-agent.system-policy",
    text: BASE_SYSTEM_POLICY,
  },
  services: {
    "pal.default-agent.runtime": {
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
            const signal = AbortSignal.any([
              host.signal,
              request.signal,
              context.signal,
            ]);
            yield* new AgentLoop(dependencies).run({ ...request, signal });
          },
        },
      },
    },
  },
});
