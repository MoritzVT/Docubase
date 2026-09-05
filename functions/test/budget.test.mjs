import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateVisualBudget,
  MIN_PROJECT_VISUAL_ALLOWANCE_USD,
} from "../lib/budget.js";

test("short projects receive enough allowance for fixed visual overhead", () => {
  const budget = calculateVisualBudget({
    projectDurationMs: 20_000,
    projectClipCount: 1,
    budgetPerFootageHour: 0.5,
    geminiActualUsd: 0,
    geminiReservedUsd: 0,
  });

  assert.equal(budget.totalUsd, MIN_PROJECT_VISUAL_ALLOWANCE_USD);
  assert.ok(budget.remainingUsd >= 0.0008);
});

test("normal projects pool visual allowance across all footage", () => {
  const budget = calculateVisualBudget({
    projectDurationMs: 60 * 60 * 1_000,
    projectClipCount: 1,
    budgetPerFootageHour: 0.5,
    geminiActualUsd: 0.02,
    geminiReservedUsd: 0.01,
  });

  assert.equal(budget.totalUsd, 0.5);
  assert.equal(budget.remainingUsd, 0.47);
});

test("completed and reserved Gemini usage both reduce the shared pool", () => {
  const budget = calculateVisualBudget({
    projectDurationMs: 20_000,
    projectClipCount: 1,
    budgetPerFootageHour: 0.5,
    geminiActualUsd: 0.006,
    geminiReservedUsd: 0.0035,
  });

  assert.equal(budget.totalUsd, 0.02);
  assert.equal(budget.remainingUsd, 0.0105);
});

test("zero hourly budget disables visual spending", () => {
  const budget = calculateVisualBudget({
    projectDurationMs: 20_000,
    projectClipCount: 1,
    budgetPerFootageHour: 0,
    geminiActualUsd: 0,
    geminiReservedUsd: 0,
  });

  assert.equal(budget.totalUsd, 0);
  assert.equal(budget.remainingUsd, 0);
});

test("several short clips receive allowance for per-clip request overhead", () => {
  const budget = calculateVisualBudget({
    projectDurationMs: 6 * 60 * 1_000,
    projectClipCount: 5,
    budgetPerFootageHour: 0.5,
    geminiActualUsd: 0.0086,
    geminiReservedUsd: 0,
  });

  assert.equal(budget.workloadBasedUsd, 0.026);
  assert.equal(budget.totalUsd, 0.05);
  assert.equal(budget.remainingUsd, 0.0414);
});
