import type { ToolCall, ToolDefinition } from "@modera/contracts";

/** Undeclared operations are barriers. Only adjacent explicitly independent reads overlap. */
export function toolBatches(
  calls: readonly ToolCall[],
  definitions: readonly ToolDefinition[],
  limit = 4,
): ToolCall[][] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16)
    throw new Error("Invalid tool concurrency");
  const byId = new Map(definitions.map((tool) => [tool.id, tool]));
  const batches: ToolCall[][] = [];
  let reads: ToolCall[] = [];
  const flush = () => {
    if (reads.length) batches.push(reads);
    reads = [];
  };
  for (const call of calls) {
    const definition = byId.get(call.name);
    if (
      definition?.concurrency === "independent-read" &&
      definition.executionKind !== "interaction"
    ) {
      reads.push(call);
      if (reads.length === limit) flush();
    } else {
      flush();
      batches.push([call]);
    }
  }
  flush();
  return batches;
}

/** Drain all started work even if a consumer stops: no detached tool mutations. */
export async function* completionOrder<T>(
  operations: readonly (() => Promise<T>)[],
): AsyncGenerator<{ index: number; value: T }> {
  const pending = new Map(
    operations.map((operation, index) => [
      index,
      Promise.resolve()
        .then(operation)
        .then(
          (value) => ({ index, value, failed: false as const }),
          (error) => ({ index, error, failed: true as const }),
        ),
    ]),
  );
  try {
    while (pending.size) {
      const result = await Promise.race(pending.values());
      pending.delete(result.index);
      if (result.failed) throw result.error;
      yield { index: result.index, value: result.value };
    }
  } finally {
    await Promise.all(pending.values());
  }
}
