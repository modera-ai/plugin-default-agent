import { it, expect, vi } from "vitest";
import { RunBudget } from "../src/run-budget";
it("excludes pause time without resetting token and step budgets", () => {
  let now = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  try {
    const budget = new RunBudget({
      maxDurationMs: 10,
      maxSteps: 3,
      maxTokens: 100,
    });
    now = 100;
    budget.excludeSuspension(99);
    expect(() => budget.check(2, 99)).not.toThrow();
    expect(() => budget.check(3, 99)).toThrow("STEP");
    expect(() => budget.check(2, 100)).toThrow("TOKEN");
    now = 110;
    expect(() => budget.check(2, 99)).toThrow("TIME");
  } finally {
    clock.mockRestore();
  }
});
