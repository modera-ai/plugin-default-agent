import type { RunDiagnostic, DiagnosticSink } from "@pal/contracts";
export type { RunDiagnostic, DiagnosticSink } from "@pal/contracts";

export function reportDiagnostic(
  sink: DiagnosticSink | undefined,
  event: RunDiagnostic,
): void {
  // Observability failures must never replay or interrupt a model/tool transaction.
  try {
    sink?.(event);
  } catch {
    /* diagnostics are best effort */
  }
}
