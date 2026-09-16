import { HttpsError, onCall } from "firebase-functions/v2/https";
import {
  extractiveClipDescription,
  sanitizeClipSummary,
  selectTranscriptEvidence,
  type SanitizedClipSummary,
} from "../clip-summary.js";
import { extractGeminiResponseText } from "../gemini-response.js";
import {
  GEMINI_MODEL,
  REGION,
  VISUAL_ANALYSIS_VERSION,
  arrayStrings,
  database,
  geminiApiKey,
  readableProviderError,
  requireGeminiClient,
  requireId,
  requireMember,
  requireRecord,
  requireUserId,
  uniqueStrings,
  type SanitizedMomentAnalysis,
  type TranscriptEvidence,
} from "../shared.js";
import {
  completeUsageReservation,
  observedBatchCost,
  visualReservationId,
} from "../usage.js";
import {
  transcriptEvidence,
} from "./requests.js";
import {
  momentHasEditorEdits,
  sanitizeMomentAnalysis,
  visualBatchDescriptors,
} from "./validation.js";
import { refreshSeparatedVisualAnalysis } from "./separated-refresh.js";

export const refreshVisualAnalysis = onCall(
  {
    region: REGION,
    memory: "512MiB",
    maxInstances: 5,
    timeoutSeconds: 540,
    secrets: [geminiApiKey],
  },
  async (request) => {
    const userId = requireUserId(request.auth?.uid);
    const data = requireRecord(request.data);
    const projectId = requireId(data.projectId, "projectId");
    const jobId = requireId(data.jobId, "jobId");
    const projectReference = database.doc(`projects/${projectId}`);
    const [projectSnapshot, jobSnapshot] = await Promise.all([
      projectReference.get(),
      projectReference.collection("visualJobs").doc(jobId).get(),
    ]);
    const project = requireMember(projectSnapshot.data(), userId);
    if (!jobSnapshot.exists) {
      throw new HttpsError("not-found", "Visual analysis job not found.");
    }
    const job = jobSnapshot.data() ?? {};
    if (job.kind !== "clip") {
      throw new HttpsError("invalid-argument", "This is not a clip analysis job.");
    }
    if (String(job.analysisVersion) === "4") {
      try {
        return await refreshSeparatedVisualAnalysis({
          projectId,
          project,
          jobSnapshot,
        });
      } catch (error) {
        if (error instanceof HttpsError) throw error;
        const message = readableProviderError(error);
        console.error("Separated analysis refresh failed", {
          projectId,
          jobId,
          message,
        });
        throw new HttpsError(
          "unavailable",
          `Analysis could not be refreshed: ${message}. Existing paid work was preserved and Docubase will retry automatically.`,
        );
      }
    }
    const clipId = requireId(job.clipId, "clipId");
    const clipReference = projectReference.collection("clips").doc(clipId);
    if (job.state === "complete") {
      return {
        state: "complete",
        completed: true,
        completedMoments: arrayStrings(job.momentIds).length,
        failedMoments: 0,
      };
    }
    const batchNames = arrayStrings(job.batchNames);
    if (batchNames.length < 1) {
      throw new HttpsError("failed-precondition", "The Gemini batch is missing.");
    }
    const ai = requireGeminiClient();
    const batches = await Promise.all(
      batchNames.map((name) => ai.batches.get({ name })),
    );
    const failedBatches = batches.filter((batch) =>
      [
        "JOB_STATE_FAILED",
        "JOB_STATE_CANCELLED",
        "JOB_STATE_EXPIRED",
      ].includes(String(batch.state)),
    );
    const descriptors = visualBatchDescriptors(job.batchDescriptors);
    if (failedBatches.length > 0 && descriptors.length === 0) {
      const failed = failedBatches[0];
      const message =
        failed.error?.message ?? `Gemini batch ended in ${String(failed.state)}.`;
      const actualCostUsd = observedBatchCost(batches);
      const timestamp = new Date().toISOString();
      await Promise.all([
        jobSnapshot.ref.set(
          {
            state: "failed",
            actualCostUsd,
            error: message,
            updatedAt: timestamp,
          },
          { merge: true },
        ),
        clipReference.set(
          {
            visualStage: "failed",
            visualError: message,
            visualUpdatedAt: timestamp,
          },
          { merge: true },
        ),
        completeUsageReservation({
          projectId,
          reservationId: visualReservationId(jobId),
          requestId: batchNames.join(","),
          actualCostUsd,
          operation: "gemini-visual-analysis",
        }),
      ]);
      throw new HttpsError("unavailable", message);
    }
    const allTerminal = batches.every(
      (batch) =>
        String(batch.state) === "JOB_STATE_SUCCEEDED" ||
        [
          "JOB_STATE_FAILED",
          "JOB_STATE_CANCELLED",
          "JOB_STATE_EXPIRED",
        ].includes(String(batch.state)),
    );
    if (!allTerminal) {
      await jobSnapshot.ref.set(
        { state: "running", updatedAt: new Date().toISOString() },
        { merge: true },
      );
      return {
        state: "running",
        completed: false,
        completedMoments: 0,
        failedMoments: 0,
      };
    }

    const [existingMoments, transcriptSnapshot] = await Promise.all([
      clipReference.collection("visualMoments").get(),
      clipReference.collection("transcriptUtterances").get(),
    ]);
    const momentById = new Map(
      existingMoments.docs.map((snapshot) => [
        snapshot.id,
        snapshot.data(),
      ]),
    );
    const transcript = transcriptSnapshot.docs
      .map((snapshot) => transcriptEvidence(snapshot.id, snapshot.data()))
      .filter((value): value is TranscriptEvidence => value !== null)
      .sort((left, right) => left.startMs - right.startMs);
    let completedMoments = 0;
    let failedMoments = 0;
    let clipSummary: SanitizedClipSummary | null = null;
    let clipSummaryError: string | null = null;
    let clipSummaryModelVersion: string | null = null;
    const completedAnalyses: SanitizedMomentAnalysis[] = [];
    const processedMomentIds = new Set<string>();
    const writer = database.bulkWriter();
    for (const failedBatch of failedBatches) {
      const descriptor = descriptors.find(
        (value) => value.name === failedBatch.name,
      );
      const message =
        failedBatch.error?.message ??
        `Gemini batch ended in ${String(failedBatch.state)}.`;
      if (descriptor?.requestType === "clipSummary") {
        clipSummaryError = message;
      }
      for (const momentId of descriptor?.momentIds ?? []) {
        if (!momentById.has(momentId) || processedMomentIds.has(momentId)) {
          continue;
        }
        processedMomentIds.add(momentId);
        failedMoments += 1;
        writer.set(
          clipReference.collection("visualMoments").doc(momentId),
          {
            stage: "failed",
            error: message,
            updatedAt: new Date().toISOString(),
          },
          { merge: true },
        );
      }
    }
    for (const batch of batches.filter(
      (value) => String(value.state) === "JOB_STATE_SUCCEEDED",
    )) {
      for (const inline of batch.dest?.inlinedResponses ?? []) {
        if (inline.metadata?.requestType === "clipSummary") {
          if (inline.error || !inline.response) {
            clipSummaryError =
              inline.error?.message ?? "Gemini returned no clip summary.";
            continue;
          }
          try {
            clipSummary = sanitizeClipSummary(
              JSON.parse(extractGeminiResponseText(inline.response)),
              arrayStrings(job.summaryFrameIds),
              arrayStrings(job.summaryUtteranceIds),
            );
            clipSummaryModelVersion = inline.response.modelVersion ?? null;
            clipSummaryError = null;
          } catch (error) {
            clipSummaryError =
              `Invalid clip summary: ${readableProviderError(error)}`;
          }
          continue;
        }
        const momentId = inline.metadata?.momentId;
        if (!momentId || !momentById.has(momentId)) {
          continue;
        }
        if (processedMomentIds.has(momentId)) {
          continue;
        }
        processedMomentIds.add(momentId);
        const source = momentById.get(momentId) ?? {};
        if (inline.error || !inline.response) {
          failedMoments += 1;
          writer.set(
            clipReference.collection("visualMoments").doc(momentId),
            {
              stage: "failed",
              error: inline.error?.message ?? "Gemini returned no analysis.",
              updatedAt: new Date().toISOString(),
            },
            { merge: true },
          );
          continue;
        }
        try {
          const analysis = sanitizeMomentAnalysis(
            JSON.parse(extractGeminiResponseText(inline.response)),
            arrayStrings(source.frameIds),
          );
          const timestamp = new Date().toISOString();
          const momentUpdate: Record<string, unknown> = {
            stage: "complete",
            generatedDescription: analysis.description,
            generatedTags: analysis.tags,
            facets: analysis.facets,
            evidenceFrameIds: analysis.evidenceFrameIds,
            evidenceUtteranceIds: analysis.evidenceUtteranceIds,
            confidence: analysis.confidence,
            model: GEMINI_MODEL,
            modelVersion: inline.response.modelVersion ?? null,
            error: null,
            updatedAt: timestamp,
          };
          if (!momentHasEditorEdits(source)) {
            momentUpdate.description = analysis.description;
            momentUpdate.tags = analysis.tags;
          }
          writer.set(
            clipReference.collection("visualMoments").doc(momentId),
            momentUpdate,
            { merge: true },
          );
          completedAnalyses.push(analysis);
          completedMoments += 1;
        } catch (error) {
          failedMoments += 1;
          writer.set(
            clipReference.collection("visualMoments").doc(momentId),
            {
              stage: "failed",
              error: `Invalid structured analysis: ${readableProviderError(error)}`,
              updatedAt: new Date().toISOString(),
            },
            { merge: true },
          );
        }
      }
    }
    for (const momentId of arrayStrings(job.momentIds)) {
      if (processedMomentIds.has(momentId)) continue;
      failedMoments += 1;
      writer.set(
        clipReference.collection("visualMoments").doc(momentId),
        {
          stage: "failed",
          error: "Gemini returned no result for this visual moment.",
          updatedAt: new Date().toISOString(),
        },
        { merge: true },
      );
    }
    await writer.close();
    const actualCostUsd = observedBatchCost(batches);
    const expectsClipSummary = job.expectsClipSummary === true;
    const summaryFailed = expectsClipSummary && clipSummary === null;
    if (summaryFailed && !clipSummaryError) {
      clipSummaryError = "Gemini returned no whole-clip summary.";
    }
    const clipDescription =
      clipSummary?.description ??
      extractiveClipDescription(
        completedAnalyses.map((analysis) => analysis.description),
        transcript,
      );
    const clipTags = uniqueStrings(
      [
        ...(clipSummary?.tags ?? []),
        ...completedAnalyses.flatMap((analysis) => analysis.tags),
      ],
      40,
    );
    const visualFacets = {
      contentTypes: uniqueStrings(
        completedAnalyses.map((analysis) => analysis.facets.contentType),
        10,
      ),
      speechStates: uniqueStrings(
        completedAnalyses.map((analysis) => analysis.facets.speechState),
        10,
      ),
      settings: uniqueStrings(
        completedAnalyses.flatMap((analysis) => analysis.facets.setting),
        20,
      ),
      weather: uniqueStrings(
        completedAnalyses.flatMap((analysis) => analysis.facets.weather),
        20,
      ),
      colors: uniqueStrings(
        completedAnalyses.flatMap(
          (analysis) => analysis.facets.dominantColors,
        ),
        20,
      ),
      moods: uniqueStrings(
        completedAnalyses.flatMap((analysis) => analysis.facets.mood),
        20,
      ),
      actions: uniqueStrings(
        completedAnalyses.flatMap((analysis) => analysis.facets.actions),
        30,
      ),
    };
    const latestClip = (await clipReference.get()).data() ?? {};
    const issues: string[] = [];
    if (failedMoments > 0) {
      issues.push(
        `${failedMoments} visual moment${failedMoments === 1 ? "" : "s"} need retry`,
      );
    }
    if (summaryFailed) issues.push("the whole-clip summary needs retry");
    const hasFailures = issues.length > 0;
    const clipVisualUpdate: Record<string, unknown> = {
      generatedDescription: clipDescription,
      generatedTags: clipTags,
      summaryEvidenceFrameIds:
        clipSummary?.evidenceFrameIds ??
        uniqueStrings(
          completedAnalyses.flatMap(
            (analysis) => analysis.evidenceFrameIds,
          ),
          100,
        ),
      summaryEvidenceUtteranceIds:
        clipSummary?.evidenceUtteranceIds ??
        selectTranscriptEvidence(
          transcript,
          3,
          600,
        ).map((utterance) => utterance.id),
      summaryConfidence: clipSummary?.confidence ?? 0.35,
      summaryVersion: clipSummary ? VISUAL_ANALYSIS_VERSION : "extractive-3",
      summaryModel: clipSummary ? GEMINI_MODEL : null,
      summaryModelVersion: clipSummaryModelVersion,
      visualFacets,
      visualStage: hasFailures ? "failed" : "complete",
      visualError: hasFailures ? `${issues.join("; ")}.` : null,
      visualUpdatedAt: new Date().toISOString(),
    };
    if (!latestClip.visualEditedAt) {
      clipVisualUpdate.description = clipDescription;
      clipVisualUpdate.tags = clipTags;
    }
    await Promise.all([
      clipReference.set(
        clipVisualUpdate,
        { merge: true },
      ),
      completeUsageReservation({
        projectId,
        reservationId: visualReservationId(jobId),
        requestId: batchNames.join(","),
        actualCostUsd,
        operation: "gemini-visual-analysis",
      }),
      jobSnapshot.ref.set(
        {
          state: hasFailures ? "partial" : "complete",
          actualCostUsd,
          error: hasFailures ? `${issues.join("; ")}.` : null,
          summaryError: clipSummaryError,
          updatedAt: new Date().toISOString(),
        },
        { merge: true },
      ),
    ]);
    return {
      state: hasFailures ? "partial" : "complete",
      completed: !hasFailures,
      completedMoments,
      failedMoments,
      summaryFailed,
    };
  },
);
