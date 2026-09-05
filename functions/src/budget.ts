// Visual analysis has fixed transcript/routing overhead for every clip plus
// duration-based moment work. These conservative allowances cover roughly two
// normal Batch passes without authorizing any provider spend by themselves.
export const MIN_PROJECT_VISUAL_ALLOWANCE_USD = 0.02;
export const VISUAL_ALLOWANCE_PER_CLIP_USD = 0.004;
export const VISUAL_ALLOWANCE_PER_MINUTE_USD = 0.001;

export interface VisualBudgetInput {
  projectDurationMs: number;
  projectClipCount: number;
  budgetPerFootageHour: number;
  geminiActualUsd: number;
  geminiReservedUsd: number;
}

export interface VisualBudget {
  totalUsd: number;
  remainingUsd: number;
  visualAllowancePerHour: number;
  workloadBasedUsd: number;
}

export function calculateVisualBudget(input: VisualBudgetInput): VisualBudget {
  const projectDurationMs = nonNegative(input.projectDurationMs);
  const projectClipCount = Math.floor(nonNegative(input.projectClipCount));
  const budgetPerFootageHour = nonNegative(input.budgetPerFootageHour);
  const visualAllowancePerHour = budgetPerFootageHour;
  const durationBasedBudget =
    (projectDurationMs / (60 * 60 * 1_000)) * visualAllowancePerHour;
  const workloadBasedBudget =
    projectClipCount * VISUAL_ALLOWANCE_PER_CLIP_USD +
    (projectDurationMs / (60 * 1_000)) * VISUAL_ALLOWANCE_PER_MINUTE_USD;
  const totalUsd =
    projectDurationMs > 0 && visualAllowancePerHour > 0
      ? roundUsd(
          Math.max(
            MIN_PROJECT_VISUAL_ALLOWANCE_USD,
            durationBasedBudget,
            workloadBasedBudget,
          ),
        )
      : 0;
  const usedUsd =
    nonNegative(input.geminiActualUsd) +
    nonNegative(input.geminiReservedUsd);
  return {
    totalUsd,
    remainingUsd: roundUsd(Math.max(0, totalUsd - usedUsd)),
    visualAllowancePerHour: roundUsd(visualAllowancePerHour),
    workloadBasedUsd: roundUsd(workloadBasedBudget),
  };
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
