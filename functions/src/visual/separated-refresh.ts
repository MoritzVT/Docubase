import { HttpsError } from "firebase-functions/v2/https";
import type { GoogleGenAI, InlinedRequest } from "@google/genai";
import {
  calculateVisualStability,
  chooseVisualRoute,
  mergeClipAnalysis,
  sanitizeTranscriptAnalysis,
  sanitizeVisualRoutingAnalysis,
  type VisualStability,
} from "../analysis-pipeline.js";
import { extractGeminiResponseText } from "../gemini-response.js";
import {
  GEMINI_MODEL,
  VISUAL_ANALYSIS_VERSION,
  arrayStrings,
  database,
  numeric,
  readableProviderError,
  requireGeminiClient,
  roundUsd,
  uniqueStrings,
  type SanitizedMomentAnalysis,
  type TranscriptAnalysis,
  type TranscriptEvidence,
  type VisualFrameRecord,
  type VisualRoutingAnalysis,
} from "../shared.js";
import {
  completeUsageReservation,
  observedAnalysisCost,
  visualReservationId,
} from "../usage.js";
import {
  groupVisualMoments,
  partitionVisualMoments,
  requireVisualFrame,
  requireVisualFrameManifest,
  transcriptAnalysisRequest,
  transcriptEvidence,
  transcriptSynthesisRequest,
  visualMomentRequest,
  visualRoutingRequest,
} from "./requests.js";
import {
  momentHasEditorEdits,
  sanitizeMomentAnalysis,
} from "./validation.js";
import {
  analysisMode,
  analysisOperation,
  executeStandardRequests,
  standardResponsesAsBatch,
} from "./execution.js";

interface RefreshInput {
  projectId: string;
  project: FirebaseFirestore.DocumentData;
  jobSnapshot: FirebaseFirestore.DocumentSnapshot;
}

interface SectionRecord {
  index: number;
  utteranceIds: string[];
}

const TERMINAL_BATCH_STATES = new Set([
  "JOB_STATE_SUCCEEDED",
  "JOB_STATE_FAILED",
  "JOB_STATE_CANCELLED",
  "JOB_STATE_EXPIRED",
]);

export async function refreshSeparatedVisualAnalysis({
  projectId,
  project,
  jobSnapshot,
}: RefreshInput): Promise<{
  state: string;
  completed: boolean;
  completedMoments: number;
  failedMoments: number;
  summaryFailed: boolean;
  route?: "stableInterview" | "fullVisual";
}> {
  const job = jobSnapshot.data() ?? {};
  const mode = analysisMode(job.analysisMode);
  const clipId = String(job.clipId ?? "");
  if (!clipId) throw new HttpsError("failed-precondition", "Clip ID is missing.");
  const projectReference = database.doc(`projects/${projectId}`);
  const clipReference = projectReference.collection("clips").doc(clipId);
  if (job.state === "complete") {
    return {
      state: "complete",
      completed: true,
      completedMoments: arrayStrings(job.momentIds).length,
      failedMoments: 0,
      summaryFailed: false,
      route: job.route === "stableInterview" ? "stableInterview" : "fullVisual",
    };
  }

  const batchNames = arrayStrings(job.batchNames);
  if (mode === "batch" && batchNames.length === 0) {
    throw new HttpsError("failed-precondition", "The Gemini batch is missing.");
  }
  const ai = requireGeminiClient();
  const batches = mode === "fast"
    ? [await standardResponsesAsBatch(jobSnapshot.ref)]
    : await Promise.all(batchNames.map((name) => ai.batches.get({ name })));
  if (!batches.every((batch) => TERMINAL_BATCH_STATES.has(String(batch.state)))) {
    await jobSnapshot.ref.set(
      { state: "running", updatedAt: new Date().toISOString() },
      { merge: true },
    );
    return {
      state: "running",
      completed: false,
      completedMoments: 0,
      failedMoments: 0,
      summaryFailed: false,
    };
  }

  const [clipSnapshot, frameSnapshot, transcriptSnapshot, momentSnapshot] =
    await Promise.all([
      clipReference.get(),
      clipReference.collection("visualFrames").get(),
      clipReference.collection("transcriptUtterances").get(),
      clipReference.collection("visualMoments").get(),
    ]);
  if (!clipSnapshot.exists) {
    throw new HttpsError("not-found", "Clip metadata is no longer available.");
  }
  const clip = { id: clipId, ...(clipSnapshot.data() ?? {}) };
  const uploadedFrames = frameSnapshot.docs
    .map((snapshot) =>
      requireVisualFrame(snapshot.id, snapshot.data(), projectId, clipId))
    .sort((left, right) => left.timestampMs - right.timestampMs);
  const frames = Array.isArray(job.frameManifest)
    ? job.frameManifest.map((frame: unknown) =>
        requireVisualFrameManifest(frame, projectId, clipId))
      .sort((left: VisualFrameRecord, right: VisualFrameRecord) =>
        left.timestampMs - right.timestampMs)
    : uploadedFrames;
  const transcript = transcriptSnapshot.docs
    .map((snapshot) => transcriptEvidence(snapshot.id, snapshot.data()))
    .filter((value): value is TranscriptEvidence => value !== null)
    .sort((left, right) => left.startMs - right.startMs);
  const momentById = new Map(momentSnapshot.docs.map((snapshot) => [
    snapshot.id,
    snapshot.data(),
  ]));
  const successfulResponses = batches
    .filter((batch) => String(batch.state) === "JOB_STATE_SUCCEEDED")
    .flatMap((batch) => batch.dest?.inlinedResponses ?? []);
  const failedBatches = batches.filter(
    (batch) => String(batch.state) !== "JOB_STATE_SUCCEEDED",
  );
  const phase = String(job.phase ?? "foundation");

  if (
    phase === "foundation" ||
    phase === "transcriptSynthesis" ||
    phase === "awaitingVisualUploads"
  ) {
    const sectionRecords = transcriptSectionRecords(job.transcriptSections);
    if (phase === "foundation") {
      const completedSectionIndexes = new Set<number>();
      const invalidSectionIndexes = new Set<number>();
      for (const section of sectionRecords) {
        const requestType = sectionRecords.length > 1
          ? "transcriptSection"
          : "transcript";
        const valid = responseTranscriptAnalysis(
          successfulResponses,
          requestType,
          section.utteranceIds,
          section.index,
        );
        if (valid) {
          completedSectionIndexes.add(section.index);
        } else if (hasTranscriptResponse(
          successfulResponses,
          requestType,
          section.index,
        )) {
          invalidSectionIndexes.add(section.index);
        }
      }
      const routing = responseVisualRouting(
        successfulResponses,
        String(job.routingFrameId ?? ""),
      );
      const hasRoutingResponse = successfulResponses.some(
        (response) => response.metadata?.requestType === "visualRouting",
      );
      const routingIsInvalid = hasRoutingResponse && !routing;
      if (
        (invalidSectionIndexes.size > 0 && numeric(job.transcriptValidationRetries) >= 1) ||
        (routingIsInvalid && numeric(job.routingValidationRetries) >= 1)
      ) {
        return failFoundation(
          projectId,
          clipReference,
          jobSnapshot,
          batchNames,
          batches,
          invalidSectionIndexes.size > 0
            ? "Gemini twice returned transcript analysis without valid utterance evidence. Rebuild this clip's analysis to try again."
            : "Gemini twice returned visual routing without valid frame evidence. Rebuild this clip's analysis to try again.",
        );
      }
      const utteranceById = new Map(transcript.map((item) => [item.id, item]));
      const missingRequests = sectionRecords
        .filter((section) => !completedSectionIndexes.has(section.index))
        .map((section) => transcriptAnalysisRequest(
          project,
          clip,
          section.utteranceIds.flatMap((id) => {
            const utterance = utteranceById.get(id);
            return utterance ? [utterance] : [];
          }),
          section.index,
          sectionRecords.length,
        ));
      if (!routing) {
        const routingFrame = frames.find(
          (frame) => frame.id === String(job.routingFrameId ?? ""),
        );
        if (!routingFrame) {
          throw new HttpsError("failed-precondition", "The routing frame is missing.");
        }
        missingRequests.push(await visualRoutingRequest(project, clip, routingFrame));
      }
      if (missingRequests.length > 0) {
        const nextBatchNames = [...batchNames];
        const nextDescriptors = rawBatchDescriptors(job.batchDescriptors);
        for (let index = 0; index < missingRequests.length; index += 4) {
          const workName = await submitProviderWork(
            ai,
            jobSnapshot.ref,
            mode,
            missingRequests.slice(index, index + 4),
            `Docubase ${clipId} resumed foundation`,
          );
          if (mode === "batch") nextBatchNames.push(workName);
          nextDescriptors.push({
            name: workName,
            requestType: "foundation",
            momentIds: [],
          });
          await jobSnapshot.ref.set({
            batchName: mode === "fast" ? workName : nextBatchNames[0],
            batchNames: nextBatchNames,
            batchDescriptors: nextDescriptors,
            state: "pending",
            error: null,
            transcriptValidationRetries:
              numeric(job.transcriptValidationRetries) +
              (invalidSectionIndexes.size > 0 ? 1 : 0),
            routingValidationRetries:
              numeric(job.routingValidationRetries) +
              (routingIsInvalid ? 1 : 0),
            updatedAt: new Date().toISOString(),
          }, { merge: true });
        }
        if (mode === "fast") {
          return continueFast({ projectId, project, jobSnapshot });
        }
        return {
          state: "pending",
          completed: false,
          completedMoments: 0,
          failedMoments: 0,
          summaryFailed: false,
        };
      }
    }
    const routing = storedOrResponseRouting(
      job.routingAnalysis,
      successfulResponses,
      String(job.routingFrameId ?? ""),
    );
    let transcriptAnalysis: TranscriptAnalysis | null = null;

    if (phase === "awaitingVisualUploads") {
      transcriptAnalysis = sanitizeTranscriptAnalysis(
        job.transcriptAnalysis,
        transcript.map((utterance) => utterance.id),
      );
    } else if (phase === "transcriptSynthesis") {
      transcriptAnalysis = responseTranscriptAnalysis(
        successfulResponses,
        "transcriptSynthesis",
        transcript.map((utterance) => utterance.id),
      );
      if (!transcriptAnalysis) {
        if (numeric(job.transcriptSynthesisRetries) >= 1) {
          return failFoundation(
            projectId,
            clipReference,
            jobSnapshot,
            batchNames,
            batches,
            "Gemini twice returned a clip summary without valid transcript evidence. Rebuild this clip's analysis to try again.",
          );
        }
        const sectionAnalyses = Array.isArray(job.sectionAnalyses)
          ? job.sectionAnalyses.map((analysis: unknown) =>
              sanitizeTranscriptAnalysis(
                analysis,
                transcript.map((utterance) => utterance.id),
              ))
          : [];
        const retryName = await submitProviderWork(
          ai,
          jobSnapshot.ref,
          mode,
          [transcriptSynthesisRequest(project, clip, sectionAnalyses)],
          `Docubase ${clipId} transcript synthesis retry`,
        );
        await jobSnapshot.ref.set({
          batchName: mode === "fast" ? retryName : job.batchName,
          batchNames: mode === "batch" ? [...batchNames, retryName] : batchNames,
          batchDescriptors: [
            ...rawBatchDescriptors(job.batchDescriptors),
            { name: retryName, requestType: "transcriptSynthesis", momentIds: [] },
          ],
          transcriptSynthesisRetries: 1,
          state: "pending",
          error: null,
          updatedAt: new Date().toISOString(),
        }, { merge: true });
        if (mode === "fast") {
          return continueFast({ projectId, project, jobSnapshot });
        }
        return {
          state: "pending",
          completed: false,
          completedMoments: 0,
          failedMoments: 0,
          summaryFailed: false,
        };
      }
    } else if (sectionRecords.length <= 1) {
      transcriptAnalysis = responseTranscriptAnalysis(
        successfulResponses,
        "transcript",
        transcript.map((utterance) => utterance.id),
      );
    } else {
      const sectionAnalyses = sectionRecords.map((section) =>
        responseTranscriptAnalysis(
          successfulResponses,
          "transcriptSection",
          section.utteranceIds,
          section.index,
        )).filter((analysis): analysis is TranscriptAnalysis => analysis !== null);
      const synthesisName = await submitProviderWork(
        ai,
        jobSnapshot.ref,
        mode,
        [transcriptSynthesisRequest(project, clip, sectionAnalyses)],
        `Docubase ${clipId} transcript synthesis`,
      );
      await jobSnapshot.ref.set({
        phase: "transcriptSynthesis",
        state: "pending",
        batchName: mode === "fast" ? synthesisName : job.batchName,
        batchNames: mode === "batch" ? [...batchNames, synthesisName] : batchNames,
        batchDescriptors: [
          ...rawBatchDescriptors(job.batchDescriptors),
          { name: synthesisName, requestType: "transcriptSynthesis", momentIds: [] },
        ],
        sectionAnalyses,
        routingAnalysis: routing,
        updatedAt: new Date().toISOString(),
      }, { merge: true });
      if (mode === "fast") {
        return continueFast({ projectId, project, jobSnapshot });
      }
      return {
        state: "pending",
        completed: false,
        completedMoments: 0,
        failedMoments: 0,
        summaryFailed: false,
      };
    }

    if (!transcriptAnalysis || !routing) {
      return failFoundation(
        projectId,
        clipReference,
        jobSnapshot,
        batchNames,
        batches,
        failedBatches[0]?.error?.message ?? "The separated analysis result was incomplete.",
      );
    }
    const stability = job.stability
      ? stabilityFromStored(job.stability)
      : stabilityFromFrames(frames);
    const route = job.route === "fullVisual"
      ? "fullVisual"
      : chooseVisualRoute(transcriptAnalysis, routing, stability);
    if (route === "stableInterview") {
      return finalizeStableInterview({
        projectId,
        clip,
        clipReference,
        jobSnapshot,
        batches,
        batchNames,
        frames,
        moments: momentById,
        transcriptAnalysis,
        routing,
        stability,
      });
    }

    const uploadedFrameIds = new Set(uploadedFrames.map((frame) => frame.id));
    if (frames.some((frame) => !uploadedFrameIds.has(frame.id))) {
      await jobSnapshot.ref.set({
        phase: "awaitingVisualUploads",
        route,
        transcriptAnalysis,
        routingAnalysis: routing,
        stability,
        state: "pending",
        updatedAt: new Date().toISOString(),
      }, { merge: true });
      return {
        state: "pending",
        completed: false,
        completedMoments: 0,
        failedMoments: 0,
        summaryFailed: false,
        route,
      };
    }

    const routingFrameId = String(job.routingFrameId ?? "");
    const groupedMoments = groupVisualMoments(frames);
    const routingOnlyMomentIds: string[] = [];
    const moments = groupedMoments.flatMap((moment) => {
      const remainingFrames = moment.frames.filter(
        (frame) => frame.id !== routingFrameId,
      );
      if (remainingFrames.length === 0) {
        routingOnlyMomentIds.push(moment.id);
        return [];
      }
      return [{ ...moment, frames: remainingFrames }];
    });
    const momentWriter = database.bulkWriter();
    for (const moment of moments) {
      momentWriter.set(clipReference.collection("visualMoments").doc(moment.id), {
        frameIds: moment.frames.map((frame) => frame.id),
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    }
    for (const momentId of routingOnlyMomentIds) {
      const previous = momentById.get(momentId) ?? {};
      const update: Record<string, unknown> = {
        stage: "complete",
        generatedDescription: routing.description,
        generatedTags: routing.keywords,
        evidenceFrameIds: routing.evidenceFrameIds,
        evidenceUtteranceIds: [],
        confidence: routing.confidence,
        error: null,
        updatedAt: new Date().toISOString(),
      };
      if (!momentHasEditorEdits(previous)) {
        update.description = routing.description;
        update.tags = routing.keywords;
      }
      momentWriter.set(
        clipReference.collection("visualMoments").doc(momentId),
        update,
        { merge: true },
      );
    }
    await momentWriter.close();
    if (moments.length === 0) {
      return finalizeClip({
        projectId,
        clipReference,
        jobSnapshot,
        batches,
        batchNames,
        transcriptAnalysis,
        routing,
        stability,
        route,
        visualDescriptions: [routing.description],
        visualKeywords: routing.keywords,
        evidenceFrameIds: routing.evidenceFrameIds,
        completedAnalyses: [],
        completedMoments: routingOnlyMomentIds.length,
        failedMoments: 0,
        momentIds: routingOnlyMomentIds,
      });
    }
    const batchDescriptors = rawBatchDescriptors(job.batchDescriptors);
    const nextBatchNames = [...batchNames];
    for (const [groupIndex, group] of partitionVisualMoments(moments).entries()) {
      const workName = await submitProviderWork(
        ai,
        jobSnapshot.ref,
        mode,
        await Promise.all(
          group.map((moment) => visualMomentRequest(project, clip, moment)),
        ),
        `Docubase ${clipId} visuals ${groupIndex + 1}`,
      );
      if (mode === "batch") nextBatchNames.push(workName);
      batchDescriptors.push({
        name: workName,
        requestType: "moments",
        momentIds: group.map((moment) => moment.id),
      });
      await jobSnapshot.ref.set({
        phase: "visual",
        route,
        state: "pending",
        batchNames: nextBatchNames,
        batchDescriptors,
        transcriptAnalysis,
        routingAnalysis: routing,
        stability,
        routingMomentIds: routingOnlyMomentIds,
        momentIds: [...routingOnlyMomentIds, ...moments.map((moment) => moment.id)],
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    }
    if (mode === "fast") {
      return continueFast({ projectId, project, jobSnapshot });
    }
    return {
      state: "pending",
      completed: false,
      completedMoments: 0,
      failedMoments: 0,
      summaryFailed: false,
      route,
    };
  }

  if (phase !== "visual") {
    throw new HttpsError("failed-precondition", `Unknown analysis phase: ${phase}`);
  }
  const transcriptAnalysis = sanitizeTranscriptAnalysis(
    job.transcriptAnalysis,
    transcript.map((utterance) => utterance.id),
  );
  const routing = sanitizeVisualRoutingAnalysis(
    job.routingAnalysis,
    [String(job.routingFrameId ?? "")],
  );
  const descriptors = rawBatchDescriptors(job.batchDescriptors);
  const routingMomentIds = arrayStrings(job.routingMomentIds);
  const submittedMomentIds = new Set(
    descriptors.flatMap((descriptor) => descriptor.momentIds),
  );
  const missingMomentIds = arrayStrings(job.momentIds).filter(
    (momentId) =>
      !routingMomentIds.includes(momentId) && !submittedMomentIds.has(momentId),
  );
  if (missingMomentIds.length > 0) {
    const routingFrameId = String(job.routingFrameId ?? "");
    const missingSet = new Set(missingMomentIds);
    const missingMoments = groupVisualMoments(frames)
      .filter((moment) => missingSet.has(moment.id))
      .map((moment) => ({
        ...moment,
        frames: moment.frames.filter((frame) => frame.id !== routingFrameId),
      }))
      .filter((moment) => moment.frames.length > 0);
    const nextBatchNames = [...batchNames];
    const nextDescriptors = [...descriptors];
    for (const [index, group] of partitionVisualMoments(missingMoments).entries()) {
      const workName = await submitProviderWork(
        ai,
        jobSnapshot.ref,
        mode,
        await Promise.all(
          group.map((moment) => visualMomentRequest(project, clip, moment)),
        ),
        `Docubase ${clipId} resumed visuals ${index + 1}`,
      );
      if (mode === "batch") nextBatchNames.push(workName);
      nextDescriptors.push({
        name: workName,
        requestType: "moments",
        momentIds: group.map((moment) => moment.id),
      });
      await jobSnapshot.ref.set({
        batchNames: nextBatchNames,
        batchDescriptors: nextDescriptors,
        state: "pending",
        error: null,
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    }
    if (mode === "fast") {
      return continueFast({ projectId, project, jobSnapshot });
    }
    return {
      state: "pending",
      completed: false,
      completedMoments: routingMomentIds.length,
      failedMoments: 0,
      summaryFailed: false,
      route: "fullVisual",
    };
  }
  const processed = new Set<string>(routingMomentIds);
  const completedAnalyses: SanitizedMomentAnalysis[] = [];
  let completedMoments = routingMomentIds.length;
  let failedMoments = 0;
  const writer = database.bulkWriter();

  for (const batch of failedBatches) {
    const descriptor = descriptors.find((item) => item.name === batch.name);
    for (const momentId of descriptor?.momentIds ?? []) {
      processed.add(momentId);
      failedMoments += 1;
      writer.set(clipReference.collection("visualMoments").doc(momentId), {
        stage: "failed",
        error: batch.error?.message ?? `Gemini batch ended in ${String(batch.state)}.`,
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    }
  }
  for (const inline of successfulResponses) {
    if (inline.metadata?.requestType !== "moment") continue;
    const momentId = String(inline.metadata?.momentId ?? "");
    const source = momentById.get(momentId);
    if (!source || processed.has(momentId)) continue;
    processed.add(momentId);
    try {
      if (!inline.response || inline.error) throw new Error(
        inline.error?.message ?? "Gemini returned no visual result.",
      );
      const analysis = sanitizeMomentAnalysis(
        JSON.parse(extractGeminiResponseText(inline.response)),
        arrayStrings(source.frameIds),
      );
      const update: Record<string, unknown> = {
        stage: "complete",
        generatedDescription: analysis.description,
        generatedTags: analysis.tags,
        facets: analysis.facets,
        evidenceFrameIds: analysis.evidenceFrameIds,
        evidenceUtteranceIds: [],
        confidence: analysis.confidence,
        model: GEMINI_MODEL,
        modelVersion: inline.response.modelVersion ?? null,
        error: null,
        updatedAt: new Date().toISOString(),
      };
      if (!momentHasEditorEdits(source)) {
        update.description = analysis.description;
        update.tags = analysis.tags;
      }
      writer.set(
        clipReference.collection("visualMoments").doc(momentId),
        update,
        { merge: true },
      );
      completedAnalyses.push(analysis);
      completedMoments += 1;
    } catch (error) {
      failedMoments += 1;
      writer.set(clipReference.collection("visualMoments").doc(momentId), {
        stage: "failed",
        error: `Invalid visual analysis: ${readableProviderError(error)}`,
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    }
  }
  for (const momentId of arrayStrings(job.momentIds)) {
    if (processed.has(momentId)) continue;
    failedMoments += 1;
    writer.set(clipReference.collection("visualMoments").doc(momentId), {
      stage: "failed",
      error: "Gemini returned no result for this visual moment.",
      updatedAt: new Date().toISOString(),
    }, { merge: true });
  }
  await writer.close();
  return finalizeClip({
    projectId,
    clipReference,
    jobSnapshot,
    batches,
    batchNames,
    transcriptAnalysis,
    routing,
    stability: stabilityFromStored(job.stability),
    route: "fullVisual",
    visualDescriptions: [
      routing.description,
      ...completedAnalyses.map((analysis) => analysis.description),
    ],
    visualKeywords: [
      ...routing.keywords,
      ...completedAnalyses.flatMap((analysis) => analysis.tags),
    ],
    evidenceFrameIds: uniqueStrings([
      ...routing.evidenceFrameIds,
      ...completedAnalyses.flatMap((analysis) => analysis.evidenceFrameIds),
    ], 100),
    completedAnalyses,
    completedMoments,
    failedMoments,
  });
}

function storedOrResponseRouting(
  stored: unknown,
  responses: Array<{ metadata?: Record<string, string>; response?: unknown; error?: { message?: string } }>,
  frameId: string,
): VisualRoutingAnalysis {
  if (stored) return sanitizeVisualRoutingAnalysis(stored, [frameId]);
  const routing = responseVisualRouting(responses, frameId);
  if (routing) return routing;
  throw new HttpsError(
    "unavailable",
    "Gemini returned visual routing without valid frame evidence. The existing job was preserved; refresh to retry that stage.",
  );
}

function responseVisualRouting(
  responses: Array<{ metadata?: Record<string, string>; response?: unknown; error?: { message?: string } }>,
  frameId: string,
): VisualRoutingAnalysis | null {
  const candidates = responses.filter(
    (response) => response.metadata?.requestType === "visualRouting",
  ).reverse();
  for (const inline of candidates) {
    if (!inline.response || inline.error) continue;
    try {
      return sanitizeVisualRoutingAnalysis(
        JSON.parse(extractGeminiResponseText(inline.response as never)),
        [frameId],
      );
    } catch {
      // A later retry may contain a valid grounded response.
    }
  }
  return null;
}

function responseTranscriptAnalysis(
  responses: Array<{ metadata?: Record<string, string>; response?: unknown; error?: { message?: string } }>,
  requestType: string,
  utteranceIds: string[],
  sectionIndex?: number,
): TranscriptAnalysis | null {
  const candidates = responses.filter((response) =>
    response.metadata?.requestType === requestType &&
    (sectionIndex === undefined ||
      Number(response.metadata?.sectionIndex) === sectionIndex)).reverse();
  for (const inline of candidates) {
    if (!inline.response || inline.error) continue;
    try {
      return sanitizeTranscriptAnalysis(
        JSON.parse(extractGeminiResponseText(inline.response as never)),
        utteranceIds,
      );
    } catch {
      // A later retry may contain a valid grounded response.
    }
  }
  return null;
}

function hasTranscriptResponse(
  responses: Array<{ metadata?: Record<string, string> }>,
  requestType: string,
  sectionIndex: number,
): boolean {
  return responses.some((response) =>
    response.metadata?.requestType === requestType &&
    Number(response.metadata?.sectionIndex) === sectionIndex);
}

function transcriptSectionRecords(value: unknown): SectionRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const index = Math.round(numeric(record.index));
    return [{ index, utteranceIds: arrayStrings(record.utteranceIds) }];
  }).sort((left, right) => left.index - right.index);
}

function rawBatchDescriptors(value: unknown): Array<{
  name: string;
  requestType: string;
  momentIds: string[];
}> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const name = String(record.name ?? "");
    if (!name) return [];
    return [{
      name,
      requestType: String(record.requestType ?? ""),
      momentIds: arrayStrings(record.momentIds),
    }];
  });
}

function stabilityFromFrames(frames: VisualFrameRecord[]): VisualStability {
  const meaningfulScores = frames
    .slice(frames.length > 1 ? 1 : 0)
    .map((frame) => frame.changeScore);
  return calculateVisualStability(meaningfulScores);
}

function stabilityFromStored(value: unknown): VisualStability {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return calculateVisualStability([]);
  }
  const record = value as Record<string, unknown>;
  return {
    significantChangeCount: Math.max(0, Math.round(numeric(record.significantChangeCount))),
    significantChangeRatio: Math.min(1, Math.max(0, numeric(record.significantChangeRatio))),
    medianChangeScore: Math.min(1, Math.max(0, numeric(record.medianChangeScore))),
    maximumChangeScore: Math.min(1, Math.max(0, numeric(record.maximumChangeScore))),
  };
}

async function finalizeStableInterview(input: {
  projectId: string;
  clip: FirebaseFirestore.DocumentData;
  clipReference: FirebaseFirestore.DocumentReference;
  jobSnapshot: FirebaseFirestore.DocumentSnapshot;
  batches: Parameters<typeof observedAnalysisCost>[1];
  batchNames: string[];
  frames: VisualFrameRecord[];
  moments: Map<string, FirebaseFirestore.DocumentData>;
  transcriptAnalysis: TranscriptAnalysis;
  routing: VisualRoutingAnalysis;
  stability: VisualStability;
}) {
  const routingFrame = input.frames.find(
    (frame) => frame.id === input.routing.evidenceFrameIds[0],
  ) ?? input.frames[Math.floor((input.frames.length - 1) / 2)];
  const momentId = routingFrame.momentId;
  const previous = input.moments.get(momentId) ?? {};
  const writer = database.bulkWriter();
  for (const existingMomentId of input.moments.keys()) {
    if (existingMomentId !== momentId) {
      writer.delete(input.clipReference.collection("visualMoments").doc(existingMomentId));
    }
  }
  const momentUpdate: Record<string, unknown> = {
    id: momentId,
    projectId: input.projectId,
    clipId: String(input.clip.id),
    startMs: 0,
    endMs: Math.max(0, Math.round(numeric(input.clip.durationMs))),
    frameIds: [routingFrame.id],
    stage: "complete",
    generatedDescription: input.routing.description,
    generatedTags: input.routing.keywords,
    facets: {
      setting: [],
      weather: [],
      timeOfDay: [],
      dominantColors: [],
      mood: [],
      objects: [],
      actions: [],
      visiblePeople: [],
      contentType: "interview",
      speechState: "unknown",
    },
    evidenceFrameIds: [routingFrame.id],
    evidenceUtteranceIds: [],
    confidence: input.routing.confidence,
    model: GEMINI_MODEL,
    modelVersion: null,
    batchJobId: input.jobSnapshot.id,
    error: null,
    createdAt: String(previous.createdAt ?? new Date().toISOString()),
    updatedAt: new Date().toISOString(),
  };
  if (!momentHasEditorEdits(previous)) {
    momentUpdate.description = input.routing.description;
    momentUpdate.tags = input.routing.keywords;
  }
  writer.set(
    input.clipReference.collection("visualMoments").doc(momentId),
    momentUpdate,
    { merge: true },
  );
  await writer.close();
  return finalizeClip({
    projectId: input.projectId,
    clipReference: input.clipReference,
    jobSnapshot: input.jobSnapshot,
    batches: input.batches,
    batchNames: input.batchNames,
    transcriptAnalysis: input.transcriptAnalysis,
    routing: input.routing,
    stability: input.stability,
    route: "stableInterview",
    visualDescriptions: [input.routing.description],
    visualKeywords: input.routing.keywords,
    evidenceFrameIds: [routingFrame.id],
    completedAnalyses: [],
    completedMoments: 1,
    failedMoments: 0,
    momentIds: [momentId],
  });
}

async function finalizeClip(input: {
  projectId: string;
  clipReference: FirebaseFirestore.DocumentReference;
  jobSnapshot: FirebaseFirestore.DocumentSnapshot;
  batches: Parameters<typeof observedAnalysisCost>[1];
  batchNames: string[];
  transcriptAnalysis: TranscriptAnalysis;
  routing: VisualRoutingAnalysis;
  stability: VisualStability;
  route: "stableInterview" | "fullVisual";
  visualDescriptions: string[];
  visualKeywords: string[];
  evidenceFrameIds: string[];
  completedAnalyses: SanitizedMomentAnalysis[];
  completedMoments: number;
  failedMoments: number;
  momentIds?: string[];
}) {
  const merged = mergeClipAnalysis(
    input.transcriptAnalysis,
    input.visualDescriptions,
    input.visualKeywords,
    input.evidenceFrameIds,
  );
  const mode = analysisMode(input.jobSnapshot.data()?.analysisMode);
  const actualCostUsd = observedAnalysisCost(mode, input.batches);
  const hasFailures = input.failedMoments > 0;
  const latestClip = (await input.clipReference.get()).data() ?? {};
  const visualFacets = {
    contentTypes: uniqueStrings([
      input.route === "stableInterview" ? "interview" : "",
      ...input.completedAnalyses.map((analysis) => analysis.facets.contentType),
    ], 10),
    speechStates: [],
    settings: uniqueStrings(input.completedAnalyses.flatMap(
      (analysis) => analysis.facets.setting,
    ), 20),
    weather: uniqueStrings(input.completedAnalyses.flatMap(
      (analysis) => analysis.facets.weather,
    ), 20),
    colors: uniqueStrings(input.completedAnalyses.flatMap(
      (analysis) => analysis.facets.dominantColors,
    ), 20),
    moods: uniqueStrings(input.completedAnalyses.flatMap(
      (analysis) => analysis.facets.mood,
    ), 20),
    actions: uniqueStrings(input.completedAnalyses.flatMap(
      (analysis) => analysis.facets.actions,
    ), 30),
  };
  const clipUpdate: Record<string, unknown> = {
    generatedDescription: merged.description,
    generatedTags: merged.tags,
    generatedTranscriptDescription: input.transcriptAnalysis.summary,
    generatedVisualDescription: input.visualDescriptions.find(Boolean) ?? "",
    generatedTranscriptTags: merged.generatedTranscriptTags,
    generatedVisualTags: merged.generatedVisualTags,
    keywordProvenance: merged.keywordProvenance,
    transcriptAnalysis: input.transcriptAnalysis,
    visualRoutingAnalysis: input.routing,
    visualStability: input.stability,
    analysisRoute: input.route,
    analysisVersion: VISUAL_ANALYSIS_VERSION,
    summaryEvidenceFrameIds: input.evidenceFrameIds,
    summaryEvidenceUtteranceIds: input.transcriptAnalysis.evidenceUtteranceIds,
    summaryConfidence: Math.min(
      input.transcriptAnalysis.confidence,
      input.routing.confidence,
    ),
    summaryVersion: VISUAL_ANALYSIS_VERSION,
    summaryModel: GEMINI_MODEL,
    visualFacets,
    visualStage: hasFailures ? "failed" : "complete",
    visualError: hasFailures
      ? `${input.failedMoments} visual moment${input.failedMoments === 1 ? "" : "s"} need retry.`
      : null,
    visualUpdatedAt: new Date().toISOString(),
  };
  if (!latestClip.visualEditedAt) {
    clipUpdate.description = merged.description;
    clipUpdate.tags = merged.tags;
  }
  await Promise.all([
    input.clipReference.set(clipUpdate, { merge: true }),
    completeUsageReservation({
      projectId: input.projectId,
      reservationId: visualReservationId(input.jobSnapshot.id),
      requestId: mode === "fast"
        ? `standard:${input.jobSnapshot.id}`
        : input.batchNames.join(","),
      actualCostUsd,
      operation: analysisOperation(mode),
    }),
    input.jobSnapshot.ref.set({
      phase: "complete",
      route: input.route,
      transcriptAnalysis: input.transcriptAnalysis,
      routingAnalysis: input.routing,
      stability: input.stability,
      state: hasFailures ? "partial" : "complete",
      momentIds: input.momentIds ?? arrayStrings(input.jobSnapshot.data()?.momentIds),
      actualCostUsd: roundUsd(actualCostUsd),
      error: hasFailures ? `${input.failedMoments} visual moments need retry.` : null,
      updatedAt: new Date().toISOString(),
    }, { merge: true }),
  ]);
  return {
    state: hasFailures ? "partial" : "complete",
    completed: !hasFailures,
    completedMoments: input.completedMoments,
    failedMoments: input.failedMoments,
    summaryFailed: false,
    route: input.route,
  };
}

async function failFoundation(
  projectId: string,
  clipReference: FirebaseFirestore.DocumentReference,
  jobSnapshot: FirebaseFirestore.DocumentSnapshot,
  batchNames: string[],
  batches: Parameters<typeof observedAnalysisCost>[1],
  message: string,
): Promise<never> {
  const mode = analysisMode(jobSnapshot.data()?.analysisMode);
  const actualCostUsd = observedAnalysisCost(mode, batches);
  await Promise.all([
    clipReference.set({
      visualStage: "failed",
      visualError: message,
      visualUpdatedAt: new Date().toISOString(),
    }, { merge: true }),
    jobSnapshot.ref.set({
      state: "failed",
      actualCostUsd,
      error: message,
      updatedAt: new Date().toISOString(),
    }, { merge: true }),
    completeUsageReservation({
      projectId,
      reservationId: visualReservationId(jobSnapshot.id),
      requestId: mode === "fast"
        ? `standard:${jobSnapshot.id}`
        : batchNames.join(","),
      actualCostUsd,
      operation: analysisOperation(mode),
    }),
  ]);
  throw new HttpsError("unavailable", message);
}

async function submitProviderWork(
  ai: GoogleGenAI,
  jobReference: FirebaseFirestore.DocumentReference,
  mode: "batch" | "fast",
  requests: InlinedRequest[],
  displayName: string,
): Promise<string> {
  if (mode === "fast") {
    return executeStandardRequests(ai, jobReference, requests, displayName);
  }
  const batch = await ai.batches.create({
    model: GEMINI_MODEL,
    src: requests,
    config: { displayName },
  });
  if (!batch.name) {
    throw new HttpsError("unavailable", "Gemini did not create the analysis batch.");
  }
  return batch.name;
}

async function continueFast(input: RefreshInput) {
  const freshSnapshot = await input.jobSnapshot.ref.get();
  return refreshSeparatedVisualAnalysis({
    ...input,
    jobSnapshot: freshSnapshot,
  });
}
