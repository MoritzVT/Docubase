import { createHash } from "node:crypto";
import { AggregateField } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import {
  partitionCompleteTranscript,
  type VisualStability,
} from "../analysis-pipeline.js";
import {
  GEMINI_MODEL,
  INTERVIEW_ROUTING,
  REGION,
  VISUAL_ANALYSIS_VERSION,
  arrayStrings,
  database,
  geminiApiKey,
  numeric,
  readableProviderError,
  requireGeminiClient,
  requireId,
  requireMember,
  requireRecord,
  requireUserId,
  type TranscriptEvidence,
  type AnalysisMode,
} from "../shared.js";
import {
  estimateVisualCost,
  releaseReservation,
  reserveVisualUsage,
  resolveVisualJob,
  visualReservationId,
} from "../usage.js";
import {
  groupVisualMoments,
  requireVisualFrame,
  requireVisualFrameManifest,
  transcriptAnalysisRequest,
  transcriptEvidence,
  visualPromptContext,
  visualRoutingRequest,
} from "./requests.js";
import { emptyVisualMoment, isAlreadyExistsError } from "./validation.js";
import {
  analysisMode,
  analysisOperation,
  executeStandardRequests,
} from "./execution.js";

function suppliedStability(value: unknown): VisualStability | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const fields = [
    record.significantChangeCount,
    record.significantChangeRatio,
    record.medianChangeScore,
    record.maximumChangeScore,
  ];
  if (!fields.every((field) => typeof field === "number" && Number.isFinite(field))) {
    return null;
  }
  return {
    significantChangeCount: Math.max(
      0,
      Math.round(record.significantChangeCount as number),
    ),
    significantChangeRatio: Math.min(
      1,
      Math.max(0, record.significantChangeRatio as number),
    ),
    medianChangeScore: Math.min(
      1,
      Math.max(0, record.medianChangeScore as number),
    ),
    maximumChangeScore: Math.min(
      1,
      Math.max(0, record.maximumChangeScore as number),
    ),
  };
}

export const submitVisualAnalysis = onCall(
  {
    region: REGION,
    memory: "1GiB",
    maxInstances: 3,
    timeoutSeconds: 540,
    secrets: [geminiApiKey],
  },
  async (request) => {
    const userId = requireUserId(request.auth?.uid);
    const data = requireRecord(request.data);
    const projectId = requireId(data.projectId, "projectId");
    const clipId = requireId(data.clipId, "clipId");
    const mode: AnalysisMode = analysisMode(data.analysisMode);
    const stability = suppliedStability(data.stability);
    const projectReference = database.doc(`projects/${projectId}`);
    const clipReference = projectReference.collection("clips").doc(clipId);
    const [
      projectSnapshot,
      clipSnapshot,
      frameSnapshot,
      transcriptSnapshot,
      existingMomentSnapshot,
      durationSnapshot,
    ] = await Promise.all([
      projectReference.get(),
      clipReference.get(),
      clipReference.collection("visualFrames").get(),
      clipReference.collection("transcriptUtterances").get(),
      clipReference.collection("visualMoments").get(),
      projectReference.collection("clips").aggregate({
        totalDurationMs: AggregateField.sum("durationMs"),
        totalClipCount: AggregateField.count(),
      }).get(),
    ]);
    const project = requireMember(projectSnapshot.data(), userId);
    if (!clipSnapshot.exists) {
      throw new HttpsError("not-found", "Clip metadata is not synced yet.");
    }
    const clip = { id: clipId, ...(clipSnapshot.data() ?? {}) };
    const uploadedFrames = frameSnapshot.docs
      .map((snapshot) =>
        requireVisualFrame(snapshot.id, snapshot.data(), projectId, clipId))
      .sort((left, right) => left.timestampMs - right.timestampMs);
    const frames = Array.isArray(data.frames)
      ? data.frames.map((frame) =>
          requireVisualFrameManifest(frame, projectId, clipId))
        .sort((left, right) => left.timestampMs - right.timestampMs)
      : uploadedFrames;
    if (frames.length < 1) {
      throw new HttpsError(
        "failed-precondition",
        "Upload retained visual frames before scheduling analysis.",
      );
    }
    if (frames.length > 10_000) {
      throw new HttpsError(
        "resource-exhausted",
        "This clip has too many retained frames. Re-extract it with the adaptive limit.",
      );
    }
    const transcript = transcriptSnapshot.docs
      .map((snapshot) => transcriptEvidence(snapshot.id, snapshot.data()))
      .filter((value): value is TranscriptEvidence => value !== null)
      .sort((left, right) => left.startMs - right.startMs);
    const moments = groupVisualMoments(frames);
    const routingFrame = frames[Math.floor((frames.length - 1) / 2)];
    if (!uploadedFrames.some((frame) => frame.id === routingFrame.id)) {
      throw new HttpsError(
        "failed-precondition",
        "Upload the representative routing frame before scheduling analysis.",
      );
    }
    const transcriptSections = partitionCompleteTranscript(transcript);
    const sections = transcriptSections.length > 0
      ? transcriptSections
      : [{
          index: 0,
          utterances: [],
          text: "",
          estimatedTokens: 0,
          byteLength: 0,
        }];

    const transcriptSetHash = createHash("sha256")
      .update(
        transcript.map((utterance) =>
          `${utterance.id}:${utterance.startMs}:${utterance.endMs}:${utterance.text}`,
        ).join("|"),
      )
      .digest("hex")
      .slice(0, 20);
    const frameSetHash = createHash("sha256")
      .update(frames.map((frame) =>
        `${frame.id}:${frame.fileSizeBytes}:${frame.changeScore}`,
      ).join("|"))
      .digest("hex")
      .slice(0, 20);
    const contextSetHash = createHash("sha256")
      .update(visualPromptContext(project, clip))
      .digest("hex")
      .slice(0, 20);
    const baseJobId = `clip-${createHash("sha256")
      .update(
        `${projectId}:${clipId}:${frameSetHash}:${transcriptSetHash}:${contextSetHash}:${VISUAL_ANALYSIS_VERSION}:${mode}:${JSON.stringify(INTERVIEW_ROUTING)}`,
      )
      .digest("hex")
      .slice(0, 36)}`;
    const resolvedJob = await resolveVisualJob(projectReference, baseJobId);
    const jobId = resolvedJob.jobId;
    const jobReference = resolvedJob.reference;
    if (resolvedJob.existing) {
      const job = resolvedJob.existing.data() ?? {};
      return {
        jobId,
        batchName: String(job.batchName ?? arrayStrings(job.batchNames)[0] ?? ""),
        momentCount: moments.length,
        estimatedCostUsd: numeric(job.estimatedCostUsd),
        alreadySubmitted: true,
      };
    }

    const repeatedVisualContextTokens =
      Math.ceil(visualPromptContext(project, clip).length / 4) * moments.length;
    const transcriptTokens = sections.reduce(
      (total, section) => total + section.estimatedTokens,
      0,
    );
    const possibleSynthesisCount = sections.length > 1 ? 1 : 0;
    const estimatedCostUsd = estimateVisualCost(
      frames.length + 1,
      moments.length,
      repeatedVisualContextTokens,
      0,
      transcriptTokens + Math.ceil(visualPromptContext(project, clip).length / 4),
      sections.length + possibleSynthesisCount,
      mode,
    );
    const timestamp = new Date().toISOString();
    await reserveVisualUsage({
      projectId,
      jobId,
      clipId,
      durationMs: numeric(clipSnapshot.data()?.durationMs),
      projectDurationMs: numeric(durationSnapshot.data().totalDurationMs),
      projectClipCount: numeric(durationSnapshot.data().totalClipCount),
      estimatedCostUsd,
      userId,
      operation: analysisOperation(mode),
    });

    try {
      await jobReference.create({
        id: jobId,
        projectId,
        clipId,
        kind: "clip",
        analysisMode: mode,
        phase: "foundation",
        route: null,
        batchName: "not-created",
        batchNames: [],
        batchDescriptors: [],
        routingFrameId: routingFrame.id,
        frameManifest: frames,
        transcriptSections: sections.map((section) => ({
          index: section.index,
          utteranceIds: section.utterances.map((utterance) => utterance.id),
        })),
        transcriptAnalysis: null,
        routingAnalysis: null,
        stability,
        analysisVersion: VISUAL_ANALYSIS_VERSION,
        state: "submitting",
        momentIds: moments.map((moment) => moment.id),
        estimatedCostUsd,
        actualCostUsd: null,
        error: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      const concurrentJob = (await jobReference.get()).data() ?? {};
      return {
        jobId,
        batchName: String(
          concurrentJob.batchName ?? arrayStrings(concurrentJob.batchNames)[0] ?? "",
        ),
        momentCount: moments.length,
        estimatedCostUsd: numeric(concurrentJob.estimatedCostUsd ?? estimatedCostUsd),
        alreadySubmitted: true,
      };
    }

    const previousMoments = new Map(existingMomentSnapshot.docs.map((snapshot) => [
      snapshot.id,
      snapshot.data(),
    ]));
    const writer = database.bulkWriter();
    for (const moment of moments) {
      writer.set(
        clipReference.collection("visualMoments").doc(moment.id),
        emptyVisualMoment(
          projectId,
          clipId,
          moment,
          jobId,
          timestamp,
          previousMoments.get(moment.id) ?? {},
        ),
        { merge: true },
      );
    }
    await writer.close();

    const createdWorkNames: string[] = [];
    try {
      const ai = requireGeminiClient();
      const foundationRequests = [
        ...sections.map((section) => transcriptAnalysisRequest(
          project,
          clip,
          section.utterances,
          section.index,
          sections.length,
        )),
        await visualRoutingRequest(project, clip, routingFrame),
      ];
      const requestGroups = mode === "fast"
        ? [foundationRequests]
        : Array.from(
            { length: Math.ceil(foundationRequests.length / 4) },
            (_, index) => foundationRequests.slice(index * 4, index * 4 + 4),
          );
      for (const [index, group] of requestGroups.entries()) {
        const displayName =
          `Docubase ${clipId} foundation ${index + 1}/${requestGroups.length}`;
        let workName: string;
        if (mode === "fast") {
          workName = await executeStandardRequests(
            ai,
            jobReference,
            group,
            displayName,
          );
        } else {
          const batch = await ai.batches.create({
            model: GEMINI_MODEL,
            src: group,
            config: { displayName },
          });
          if (!batch.name) {
            throw new Error("Gemini did not return a foundation batch name.");
          }
          workName = batch.name;
        }
        createdWorkNames.push(workName);
        await jobReference.set({
          batchName: createdWorkNames[0],
          batchNames: mode === "batch" ? createdWorkNames : [],
          batchDescriptors: createdWorkNames.map((name) => ({
            name,
            requestType: "foundation",
            momentIds: [],
          })),
          state: "pending",
          updatedAt: new Date().toISOString(),
        }, { merge: true });
      }
      return {
        jobId,
        batchName: createdWorkNames[0],
        momentCount: moments.length,
        estimatedCostUsd,
        alreadySubmitted: false,
      };
    } catch (error) {
      if (createdWorkNames.length > 0) {
        await jobReference.set({
          state: "pending",
          error:
            `Foundation submission paused after ${createdWorkNames.length} provider request group(s): ${readableProviderError(error)}`,
          updatedAt: new Date().toISOString(),
        }, { merge: true });
        throw new HttpsError(
          "unavailable",
          "The initial analysis submission was interrupted after paid work started. Docubase will collect it automatically before retrying.",
        );
      }
      await releaseReservation(projectId, visualReservationId(jobId));
      await jobReference.set({
        state: "failed",
        error: readableProviderError(error),
        updatedAt: new Date().toISOString(),
      }, { merge: true });
      throw new HttpsError(
        "unavailable",
        `Gemini ${mode === "fast" ? "Fast" : "Batch"} submission failed: ${readableProviderError(error)}`,
      );
    }
  },
);
