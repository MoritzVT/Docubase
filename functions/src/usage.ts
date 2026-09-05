import { createHash } from "node:crypto";
import type { BatchJob } from "@google/genai";
import { HttpsError } from "firebase-functions/v2/https";
import { calculateVisualBudget } from "./budget.js";
import {
  database,
  ESTIMATED_OUTPUT_TOKENS_PER_CLIP_SUMMARY,
  ESTIMATED_OUTPUT_TOKENS_PER_MOMENT,
  ESTIMATED_PROMPT_TOKENS_PER_CLIP_SUMMARY,
  ESTIMATED_PROMPT_TOKENS_PER_MOMENT,
  GEMINI_BATCH_INPUT_USD_PER_MILLION,
  GEMINI_BATCH_OUTPUT_USD_PER_MILLION,
  GEMINI_IMAGE_TOKENS,
  GEMINI_STANDARD_INPUT_USD_PER_MILLION,
  GEMINI_STANDARD_OUTPUT_USD_PER_MILLION,
  arrayStrings,
  numeric,
  requireMember,
  roundUsd,
  usageTotals,
  type UsageTotals,
  type AnalysisMode,
} from "./shared.js";

export async function releaseReservation(
  projectId: string,
  reservationId: string,
): Promise<void> {
  const projectReference = database.doc(`projects/${projectId}`);
  const reservationReference = projectReference
    .collection("usageReservations")
    .doc(reservationId);
  await database.runTransaction(async (transaction) => {
    const [projectSnapshot, reservationSnapshot] = await Promise.all([
      transaction.get(projectReference),
      transaction.get(reservationReference),
    ]);
    if (!projectSnapshot.exists || !reservationSnapshot.exists) return;
    const reservation = reservationSnapshot.data() ?? {};
    if (reservation.status !== "reserved") return;
    const usage = usageTotals(projectSnapshot.data()?.usage);
    const estimatedCostUsd = numeric(reservation.estimatedCostUsd);
    const timestamp = new Date().toISOString();
    const nextUsage: UsageTotals & { updatedAt: string } = {
      actualUsd: usage.actualUsd,
      reservedUsd: roundUsd(
        Math.max(0, usage.reservedUsd - estimatedCostUsd),
      ),
      geminiActualUsd: usage.geminiActualUsd,
      geminiReservedUsd: roundUsd(
        Math.max(0, usage.geminiReservedUsd - estimatedCostUsd),
      ),
      updatedAt: timestamp,
    };
    transaction.set(
      projectReference,
      {
        usage: nextUsage,
      },
      { merge: true },
    );
    transaction.set(
      reservationReference,
      { status: "released", updatedAt: timestamp },
      { merge: true },
    );
  });
}

export function observedBatchCost(batches: BatchJob[]): number {
  let promptTokens = 0;
  let outputTokens = 0;
  for (const batch of batches) {
    for (const inline of batch.dest?.inlinedResponses ?? []) {
      promptTokens += inline.response?.usageMetadata?.promptTokenCount ?? 0;
      outputTokens +=
        (inline.response?.usageMetadata?.candidatesTokenCount ?? 0) +
        (inline.response?.usageMetadata?.thoughtsTokenCount ?? 0);
    }
  }
  return estimateGeminiBatchCost(promptTokens, outputTokens);
}

export function observedAnalysisCost(
  mode: AnalysisMode,
  batches: BatchJob[],
): number {
  let promptTokens = 0;
  let outputTokens = 0;
  for (const batch of batches) {
    for (const inline of batch.dest?.inlinedResponses ?? []) {
      promptTokens += inline.response?.usageMetadata?.promptTokenCount ?? 0;
      outputTokens +=
        (inline.response?.usageMetadata?.candidatesTokenCount ?? 0) +
        (inline.response?.usageMetadata?.thoughtsTokenCount ?? 0);
    }
  }
  return estimateGeminiCost(promptTokens, outputTokens, mode);
}

export async function reserveVisualUsage(input: {
  projectId: string;
  jobId: string;
  clipId: string | null;
  durationMs: number;
  projectDurationMs: number;
  projectClipCount: number;
  estimatedCostUsd: number;
  userId: string;
  operation: string;
}): Promise<void> {
  if (input.durationMs <= 0 || input.projectDurationMs <= 0) {
    throw new HttpsError(
      "failed-precondition",
      "Project footage duration is unavailable.",
    );
  }
  const projectReference = database.doc(`projects/${input.projectId}`);
  const reservationId = visualReservationId(input.jobId);
  const reservationReference = projectReference
    .collection("usageReservations")
    .doc(reservationId);
  await database.runTransaction(async (transaction) => {
    const [projectSnapshot, reservationSnapshot] = await Promise.all([
      transaction.get(projectReference),
      transaction.get(reservationReference),
    ]);
    const project = requireMember(projectSnapshot.data(), input.userId);
    if (
      reservationSnapshot.exists &&
      ["reserved", "complete"].includes(
        String(reservationSnapshot.data()?.status),
      )
    ) {
      return;
    }
    const usage = usageTotals(project.usage);
    const budget = calculateVisualBudget({
      projectDurationMs: input.projectDurationMs,
      projectClipCount: input.projectClipCount,
      budgetPerFootageHour: numeric(project.budgetPerFootageHour),
      geminiActualUsd: usage.geminiActualUsd,
      geminiReservedUsd: usage.geminiReservedUsd,
    });
    if (input.estimatedCostUsd > budget.remainingUsd + 0.000001) {
      throw new HttpsError(
        "resource-exhausted",
        `Visual analysis is estimated at $${input.estimatedCostUsd.toFixed(4)}. This project allows $${budget.totalUsd.toFixed(4)} for visual AI; $${usage.geminiActualUsd.toFixed(4)} is already recorded and $${usage.geminiReservedUsd.toFixed(4)} is reserved for active work, leaving $${budget.remainingUsd.toFixed(4)}. No new paid request was started.`,
      );
    }
    const timestamp = new Date().toISOString();
    transaction.set(
      projectReference,
      {
        usage: {
          actualUsd: usage.actualUsd,
          reservedUsd: roundUsd(
            usage.reservedUsd + input.estimatedCostUsd,
          ),
          geminiActualUsd: usage.geminiActualUsd,
          geminiReservedUsd: roundUsd(
            usage.geminiReservedUsd + input.estimatedCostUsd,
          ),
          updatedAt: timestamp,
        },
      },
      { merge: true },
    );
    transaction.set(reservationReference, {
      id: reservationId,
      projectId: input.projectId,
      clipId: input.clipId,
      jobId: input.jobId,
      provider: "gemini",
      operation: input.operation,
      durationMs: input.durationMs,
      estimatedCostUsd: input.estimatedCostUsd,
      status: "reserved",
      createdBy: input.userId,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  });
}

export async function completeUsageReservation(input: {
  projectId: string;
  reservationId: string;
  requestId: string;
  actualCostUsd: number;
  operation: string;
}): Promise<void> {
  const projectReference = database.doc(`projects/${input.projectId}`);
  const reservationReference = projectReference
    .collection("usageReservations")
    .doc(input.reservationId);
  const usageEventReference = projectReference
    .collection("usageEvents")
    .doc(input.reservationId);
  await database.runTransaction(async (transaction) => {
    const [projectSnapshot, reservationSnapshot] = await Promise.all([
      transaction.get(projectReference),
      transaction.get(reservationReference),
    ]);
    if (!projectSnapshot.exists || !reservationSnapshot.exists) return;
    const reservation = reservationSnapshot.data() ?? {};
    if (reservation.status === "complete") return;
    if (reservation.status !== "reserved") {
      throw new HttpsError(
        "failed-precondition",
        "The Gemini usage reservation is not active.",
      );
    }
    const usage = usageTotals(projectSnapshot.data()?.usage);
    const estimatedCostUsd = numeric(reservation.estimatedCostUsd);
    const actualCostUsd = roundUsd(Math.max(0, input.actualCostUsd));
    const timestamp = new Date().toISOString();
    transaction.set(
      projectReference,
      {
        usage: {
          actualUsd: roundUsd(usage.actualUsd + actualCostUsd),
          reservedUsd: roundUsd(
            Math.max(0, usage.reservedUsd - estimatedCostUsd),
          ),
          geminiActualUsd: roundUsd(
            usage.geminiActualUsd + actualCostUsd,
          ),
          geminiReservedUsd: roundUsd(
            Math.max(0, usage.geminiReservedUsd - estimatedCostUsd),
          ),
          updatedAt: timestamp,
        },
      },
      { merge: true },
    );
    transaction.set(
      reservationReference,
      {
        status: "complete",
        requestId: input.requestId,
        actualCostUsd,
        completedAt: timestamp,
        updatedAt: timestamp,
      },
      { merge: true },
    );
    transaction.set(usageEventReference, {
      id: input.reservationId,
      projectId: input.projectId,
      clipId: reservation.clipId ?? null,
      jobId: reservation.jobId,
      provider: "gemini",
      operation: input.operation,
      durationMs: reservation.durationMs,
      estimatedCostUsd,
      actualCostUsd,
      requestId: input.requestId,
      createdAt: timestamp,
    });
  });
}

export function visualReservationId(jobId: string): string {
  return `visual-${createHash("sha256")
    .update(jobId)
    .digest("hex")
    .slice(0, 40)}`;
}

export async function resolveVisualJob(
  projectReference: FirebaseFirestore.DocumentReference,
  baseJobId: string,
): Promise<{
  jobId: string;
  reference: FirebaseFirestore.DocumentReference;
  existing: FirebaseFirestore.DocumentSnapshot | null;
}> {
  let jobId = baseJobId;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const reference = projectReference.collection("visualJobs").doc(jobId);
    const snapshot = await reference.get();
    if (!snapshot.exists) {
      return { jobId, reference, existing: null };
    }
    const job = snapshot.data() ?? {};
    const state = String(job.state);
    const updatedAtMs = Date.parse(String(job.updatedAt ?? job.createdAt ?? ""));
    const submittingIsRecent =
      state === "submitting" &&
      Number.isFinite(updatedAtMs) &&
      updatedAtMs > Date.now() - 15 * 60 * 1_000;
    if (
      (submittingIsRecent ||
        ["pending", "running", "complete"].includes(state)) &&
      (submittingIsRecent ||
        String(job.batchName ?? "") ||
        arrayStrings(job.batchNames).length > 0)
    ) {
      return { jobId, reference, existing: snapshot };
    }
    if (
      state === "submitting" &&
      arrayStrings(job.batchNames).length === 0
    ) {
      await releaseReservation(
        projectReference.id,
        visualReservationId(jobId),
      );
    }
    const retryHash = createHash("sha256")
      .update(
        `${jobId}:${String(job.state)}:${String(job.updatedAt ?? job.createdAt ?? "")}`,
      )
      .digest("hex")
      .slice(0, 12);
    jobId = `${baseJobId}-retry-${retryHash}`;
  }
  throw new HttpsError(
    "resource-exhausted",
    "This visual workload has reached its retry limit.",
  );
}

export function estimateVisualCost(
  frameCount: number,
  momentCount: number,
  textTokens = 0,
  summaryFrameCount = 0,
  summaryTextTokens = 0,
  summaryCount = 0,
  mode: AnalysisMode = "batch",
): number {
  return estimateGeminiCost(
    Math.max(0, frameCount) * GEMINI_IMAGE_TOKENS +
      Math.max(0, momentCount) * ESTIMATED_PROMPT_TOKENS_PER_MOMENT +
      Math.max(0, textTokens) +
      Math.max(0, summaryFrameCount) * GEMINI_IMAGE_TOKENS +
      Math.max(0, summaryCount) *
        ESTIMATED_PROMPT_TOKENS_PER_CLIP_SUMMARY +
      Math.max(0, summaryTextTokens),
    Math.max(0, momentCount) * ESTIMATED_OUTPUT_TOKENS_PER_MOMENT +
      Math.max(0, summaryCount) * ESTIMATED_OUTPUT_TOKENS_PER_CLIP_SUMMARY,
    mode,
  );
}

export function estimateGeminiBatchCost(
  promptTokens: number,
  outputTokens: number,
): number {
  return roundUsd(
    (Math.max(0, promptTokens) *
      GEMINI_BATCH_INPUT_USD_PER_MILLION +
      Math.max(0, outputTokens) *
        GEMINI_BATCH_OUTPUT_USD_PER_MILLION) /
      1_000_000,
  );
}

export function estimateGeminiCost(
  promptTokens: number,
  outputTokens: number,
  mode: AnalysisMode,
): number {
  const inputRate = mode === "fast"
    ? GEMINI_STANDARD_INPUT_USD_PER_MILLION
    : GEMINI_BATCH_INPUT_USD_PER_MILLION;
  const outputRate = mode === "fast"
    ? GEMINI_STANDARD_OUTPUT_USD_PER_MILLION
    : GEMINI_BATCH_OUTPUT_USD_PER_MILLION;
  return roundUsd(
    (Math.max(0, promptTokens) * inputRate +
      Math.max(0, outputTokens) * outputRate) /
      1_000_000,
  );
}
