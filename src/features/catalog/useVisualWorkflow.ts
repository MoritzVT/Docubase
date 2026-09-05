import { type Dispatch, type SetStateAction, useCallback, useEffect, useState } from "react";
import {
  listCloudClipVisualMetadata,
  listCloudVisualMoments,
  listVisualAnalysisJobs,
  updateClipVisualMetadata,
  updateVisualMomentMetadata,
} from "../../lib/cloud";
import type {
  AnalysisMode,
  ClipManifest,
  ClipTranscriptSummary,
  ClipVisualMetadata,
  ClipVisualSummary,
  LocalProject,
  VisualAnalysisJob,
  VisualFrame,
  VisualMoment,
} from "../../lib/contracts";
import {
  extractVisualIndex,
  listTranscriptUtterances,
  listVisualFrames,
  listVisualSummaries,
  markVisualFrameUploaded,
  readVisualFrame,
  setVisualClipStage,
} from "../../lib/native";
import { readableError } from "../../lib/presentation";
import {
  refreshVisualAnalysis,
  submitVisualAnalysis,
  TRANSCRIPT_SECTION_MAX_CHARACTERS,
  uploadRetainedFrame,
  visualAnalysisProgressStage,
} from "../../lib/visual";
import type { CatalogNotice } from "./types";

function visualJobNeedsRefresh(job: VisualAnalysisJob): boolean {
  return ["pending", "running"].includes(job.state) ||
    (job.kind === "clip" &&
      job.state === "partial" &&
      job.analysisVersion !== "4");
}

function visualJobIsActive(job: VisualAnalysisJob): boolean {
  return job.state === "submitting" || visualJobNeedsRefresh(job);
}

function visualRetryMessage(result: {
  failedMoments: number;
  summaryFailed?: boolean;
}): string {
  const issues = [
    result.failedMoments > 0
      ? `${result.failedMoments} visual moment${result.failedMoments === 1 ? "" : "s"} need retry`
      : "",
    result.summaryFailed ? "the whole-clip summary needs retry" : "",
  ].filter(Boolean);
  return `${issues.join("; ") || "Visual analysis needs retry"}.`;
}

export function useVisualWorkflow(
  project: LocalProject,
  clips: ClipManifest[],
  transcriptSummaries: Record<string, ClipTranscriptSummary>,
  setNotice: Dispatch<SetStateAction<CatalogNotice | null>>,
) {
  const [visualSummaries, setVisualSummaries] = useState<
    Record<string, ClipVisualSummary>
  >({});
  const [visualMetadata, setVisualMetadata] = useState<
    Record<string, ClipVisualMetadata>
  >({});
  const [visualFramesByClip, setVisualFramesByClip] = useState<
    Record<string, VisualFrame[]>
  >({});
  const [visualMomentsByClip, setVisualMomentsByClip] = useState<
    Record<string, VisualMoment[]>
  >({});
  const [visualJobs, setVisualJobs] = useState<VisualAnalysisJob[]>([]);
  const [expandedVisualIds, setExpandedVisualIds] = useState<Set<string>>(
    new Set(),
  );
  const [visualFilter, setVisualFilter] = useState("all");
  const [visualWorkingClipId, setVisualWorkingClipId] = useState<string | null>(
    null,
  );
  const [visualProgress, setVisualProgress] = useState<string | null>(null);
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>("batch");
  const [visualPreflight, setVisualPreflight] = useState<{
    clips: ClipManifest[];
    frameCount: number;
    momentCount: number;
    retainedBytes: number;
    estimatedInputTextTokens: number;
    summaryFrameCount: number;
    summaryInputTextTokens: number;
    transcriptRequestCount: number;
  } | null>(null);
  const refreshVisualState = useCallback(async () => {
    try {
      const [summaries, metadata, jobs] = await Promise.all([
        listVisualSummaries(project.id),
        listCloudClipVisualMetadata(project.id),
        listVisualAnalysisJobs(project.id),
      ]);
      setVisualSummaries(
        Object.fromEntries(summaries.map((summary) => [summary.clipId, summary])),
      );
      setVisualMetadata(
        Object.fromEntries(metadata.map((item) => [item.clipId, item])),
      );
      setVisualJobs(jobs);
      return { summaries, metadata, jobs };
    } catch (error) {
      setNotice({ tone: "error", message: readableError(error) });
      return null;
    }
  }, [project.id]);

  useEffect(() => {
    void refreshVisualState();
  }, [refreshVisualState]);

  async function loadVisualDetail(clipId: string) {
    const [frames, moments] = await Promise.all([
      listVisualFrames(project.id, clipId),
      listCloudVisualMoments(project.id, clipId),
    ]);
    setVisualFramesByClip((current) => ({ ...current, [clipId]: frames }));
    setVisualMomentsByClip((current) => ({ ...current, [clipId]: moments }));
  }

  async function toggleVisual(clipId: string) {
    if (expandedVisualIds.has(clipId)) {
      setExpandedVisualIds((current) => {
        const next = new Set(current);
        next.delete(clipId);
        return next;
      });
      return;
    }
    setExpandedVisualIds((current) => new Set(current).add(clipId));
    try {
      await loadVisualDetail(clipId);
    } catch (error) {
      setNotice({ tone: "error", message: readableError(error) });
    }
  }

  async function extractVisuals(clipsToExtract: ClipManifest[]) {
    const prepared: Array<{ clip: ClipManifest; frames: VisualFrame[] }> = [];
    for (let index = 0; index < clipsToExtract.length; index += 1) {
      const clip = clipsToExtract[index];
      setVisualWorkingClipId(clip.id);
      setVisualProgress(
        `${clip.filename}: sampling locally at one frame per second (${index + 1}/${clipsToExtract.length})`,
      );
      const frames = await extractVisualIndex(project.id, clip.id);
      setVisualFramesByClip((current) => ({ ...current, [clip.id]: frames }));
      prepared.push({ clip, frames });
    }
    await refreshVisualState();
    return prepared;
  }

  async function prepareVisualImages(clipsToExtract: ClipManifest[]) {
    setNotice(null);
    try {
      await extractVisuals(clipsToExtract);
      setNotice({
        tone: "success",
        message:
          `${clipsToExtract.length} clip${clipsToExtract.length === 1 ? "" : "s"} now ${
            clipsToExtract.length === 1 ? "has" : "have"
          } local visual images. No images were uploaded and no AI cost was incurred.`,
      });
    } catch (error) {
      setNotice({ tone: "error", message: readableError(error) });
    } finally {
      setVisualWorkingClipId(null);
      setVisualProgress(null);
      await refreshVisualState();
    }
  }

  async function prepareVisualAnalysis(clipsToPrepare: ClipManifest[]) {
    setNotice(null);
    const clipsMissingTranscripts = clipsToPrepare.filter(
      (clip) =>
        clip.hasAudio && transcriptSummaries[clip.id]?.stage !== "complete",
    );
    if (clipsMissingTranscripts.length > 0) {
      setNotice({
        tone: "warning",
        message:
          `Transcribe ${clipsMissingTranscripts.length} audio clip${
            clipsMissingTranscripts.length === 1 ? "" : "s"
          } before analysis. Docubase waits for both the complete transcript and local images so the final descriptions and tags use both sources.`,
      });
      return;
    }
    try {
      const prepared = await Promise.all(
        clipsToPrepare.map(async (clip) => ({
          clip,
          frames:
            visualFramesByClip[clip.id] ??
            await listVisualFrames(project.id, clip.id),
        })),
      );
      const clipsMissingImages = prepared.filter(
        ({ frames }) => frames.length === 0,
      );
      if (clipsMissingImages.length > 0) {
        setNotice({
          tone: "warning",
          message:
            `Generate visual images for ${clipsMissingImages.length} clip${
              clipsMissingImages.length === 1 ? "" : "s"
            } before starting AI analysis.`,
        });
        return;
      }
      const transcriptForEstimate = new Map(
        await Promise.all(
          prepared.map(async ({ clip }) => [
            clip.id,
            await listTranscriptUtterances(project.id, clip.id),
          ] as const),
        ),
      );
      const momentIds = new Set(
        prepared.flatMap(({ clip, frames }) =>
          frames.map((frame) => `${clip.id}:${frame.momentId}`),
        ),
      );
      const sharedContext = [
        project.brief.slice(0, 800),
        project.knownNames.slice(0, 30).join(", ").slice(0, 500),
        project.terminology.slice(0, 50).join(", ").slice(0, 800),
      ].join("\n");
      setAnalysisMode("batch");
      setVisualPreflight({
        clips: prepared.map(({ clip }) => clip),
        frameCount: prepared.reduce(
          (total, item) => total + item.frames.length,
          0,
        ),
        momentCount: momentIds.size,
        estimatedInputTextTokens: prepared.reduce((total, { clip, frames }) => {
          const momentFrames = new Map<string, VisualFrame>();
          for (const frame of frames) {
            if (!momentFrames.has(frame.momentId)) {
              momentFrames.set(frame.momentId, frame);
            }
          }
          const contextTokens = Math.ceil(
            `${sharedContext}\n${clip.filename.slice(0, 300)}`.length / 4,
          );
          return total + momentFrames.size * contextTokens;
        }, 0),
        summaryFrameCount: prepared.reduce(
          (total, item) => total + Math.min(item.frames.length, 1),
          0,
        ),
        summaryInputTextTokens: prepared.reduce((total, { clip }) => {
          const contextTokens = Math.ceil(
            `${sharedContext}\n${clip.filename.slice(0, 300)}`.length / 4,
          );
          const transcriptCharacters = (
            transcriptForEstimate.get(clip.id) ?? []
          ).reduce(
            (subtotal, utterance) =>
              subtotal + utterance.text.slice(0, 2_000).length,
            0,
          );
          return (
            total +
            contextTokens +
            Math.ceil(transcriptCharacters / 4)
          );
        }, 0),
        transcriptRequestCount: prepared.reduce((total, { clip }) => {
          const transcriptCharacters = (
            transcriptForEstimate.get(clip.id) ?? []
          ).reduce(
            (subtotal, utterance) => subtotal + utterance.text.length,
            0,
          );
          const sections = Math.max(
            1,
            Math.ceil(transcriptCharacters / TRANSCRIPT_SECTION_MAX_CHARACTERS),
          );
          return total + sections + (sections > 1 ? 1 : 0);
        }, 0),
        retainedBytes: prepared.reduce(
          (total, item) =>
            total +
            item.frames.reduce(
              (subtotal, frame) => subtotal + frame.fileSizeBytes,
              0,
            ),
          0,
        ),
      });
    } catch (error) {
      setNotice({ tone: "error", message: readableError(error) });
    } finally {
      setVisualWorkingClipId(null);
      setVisualProgress(null);
      await refreshVisualState();
    }
  }

  async function analyzePreparedVisuals() {
    const preflight = visualPreflight;
    if (!preflight) return;
    setVisualPreflight(null);
    setNotice(null);
    let activeClipId: string | null = null;
    const submittedJobIds: string[] = [];
    try {
      const latestSummaries = Object.fromEntries(
        (await listVisualSummaries(project.id)).map((summary) => [
          summary.clipId,
          summary,
        ]),
      );
      for (let clipIndex = 0; clipIndex < preflight.clips.length; clipIndex += 1) {
        const clip = preflight.clips[clipIndex];
        activeClipId = clip.id;
        setVisualWorkingClipId(clip.id);
        let frames =
          visualFramesByClip[clip.id] ??
          (await listVisualFrames(project.id, clip.id));
        await setVisualClipStage(project.id, clip.id, "uploading");
        const routingFrame = frames[Math.floor((frames.length - 1) / 2)];
        if (!routingFrame.storagePath) {
          setVisualProgress(`${clip.filename}: uploading one routing frame`);
          const bytes = await readVisualFrame(
            project.id,
            clip.id,
            routingFrame.id,
          );
          const document = await uploadRetainedFrame(routingFrame, bytes);
          await markVisualFrameUploaded(
            project.id,
            clip.id,
            routingFrame.id,
            document.storagePath,
          );
        }
        frames = await listVisualFrames(project.id, clip.id);
        setVisualFramesByClip((current) => ({ ...current, [clip.id]: frames }));
        setVisualProgress(
          `${clip.filename}: submitting ${
            analysisMode === "fast" ? "Gemini Fast" : "low-cost Gemini Batch"
          } analysis (${clipIndex + 1}/${preflight.clips.length})`,
        );
        const submission = await submitVisualAnalysis({
          projectId: project.id,
          clipId: clip.id,
          analysisMode,
          frames: frames.map((frame) => ({
            id: frame.id,
            momentId: frame.momentId,
            timestampMs: frame.timestampMs,
            fileSizeBytes: frame.fileSizeBytes,
            changeScore: frame.changeScore,
          })),
          stability: {
            significantChangeCount:
              latestSummaries[clip.id]?.significantChangeCount ?? 0,
            significantChangeRatio:
              latestSummaries[clip.id]?.significantChangeRatio ?? 1,
            medianChangeScore:
              latestSummaries[clip.id]?.medianChangeScore ?? 1,
            maximumChangeScore:
              latestSummaries[clip.id]?.maximumChangeScore ?? 1,
          },
        });
        submittedJobIds.push(submission.jobId);
        await setVisualClipStage(project.id, clip.id, "batched", {
          batchJobId: submission.jobId,
          estimatedCostUsd: submission.estimatedCostUsd,
        });
        if (analysisMode === "fast") {
          await collectVisualJob(submission.jobId, clip.id);
        }
      }
      const refreshed = await refreshVisualState();
      if (!refreshed) {
        throw new Error("Docubase could not read the submitted analysis jobs.");
      }
      const submittedJobs = submittedJobIds.map((jobId) =>
        refreshed.jobs.find((job) => job.id === jobId),
      );
      const completedCount = submittedJobs.filter(
        (job) => job?.state === "complete" || job?.phase === "complete",
      ).length;
      const failedCount = submittedJobs.filter(
        (job) => job?.state === "partial" || job?.state === "failed",
      ).length;
      const remainingCount = Math.max(
        0,
        submittedJobIds.length - completedCount - failedCount,
      );
      if (failedCount > 0) {
        setNotice({
          tone: "error",
          message: `AI analysis stopped: ${failedCount} clip${
            failedCount === 1 ? "" : "s"
          } failed, ${completedCount} finished, and ${remainingCount} remain in progress.`,
        });
      } else if (remainingCount > 0) {
        setNotice({
          tone: "warning",
          message: `AI analysis is in progress: ${completedCount} of ${
            submittedJobIds.length
          } clip${submittedJobIds.length === 1 ? "" : "s"} finished; ${
            remainingCount
          } remaining.`,
        });
      } else {
        setNotice({
          tone: "success",
          message: `AI analysis finished. Descriptions and tags are ready for ${
            completedCount
          } clip${completedCount === 1 ? "" : "s"}.`,
        });
      }
    } catch (error) {
      if (activeClipId) {
        await setVisualClipStage(
          project.id,
          activeClipId,
          "failed",
          { error: readableError(error) },
        ).catch(() => undefined);
      }
      setNotice({ tone: "error", message: readableError(error) });
    } finally {
      setVisualWorkingClipId(null);
      setVisualProgress(null);
      await refreshVisualState();
    }
  }

  async function collectVisualJob(jobId: string, clipId: string) {
    let result = await refreshVisualAnalysis({
      projectId: project.id,
      jobId,
    });
    if (result.route === "fullVisual" && !result.completed) {
      const frames = await listVisualFrames(project.id, clipId);
      const missingFrames = frames.filter((frame) => !frame.storagePath);
      for (let index = 0; index < missingFrames.length; index += 1) {
        const frame = missingFrames[index];
        setVisualProgress(
          `${clipId}: uploading visual frame ${index + 1}/${missingFrames.length}`,
        );
        const bytes = await readVisualFrame(project.id, clipId, frame.id);
        const document = await uploadRetainedFrame(frame, bytes);
        await markVisualFrameUploaded(
          project.id,
          clipId,
          frame.id,
          document.storagePath,
        );
      }
      result = await refreshVisualAnalysis({
        projectId: project.id,
        jobId,
      });
    }
    await setVisualClipStage(
      project.id,
      clipId,
      result.completed
        ? "complete"
        : result.state === "partial"
          ? "failed"
          : "analyzing",
      {
        batchJobId: jobId,
        error: result.state === "partial" ? visualRetryMessage(result) : null,
      },
    );
    if (result.completed) await loadVisualDetail(clipId);
    return result;
  }

  async function refreshPendingVisualAnalysis(silent = false) {
    if (!silent) {
      setNotice(null);
      setVisualProgress("Checking AI analysis jobs…");
    }
    const errors: string[] = [];
    let completedCount = 0;
    let failedCount = 0;
    let remainingCount = 0;
    try {
      const pendingJobs = visualJobs.filter((job) =>
        visualJobNeedsRefresh(job),
      );
      for (const job of pendingJobs) {
        if (job.clipId) {
          try {
            setVisualWorkingClipId(job.clipId);
            const result = await collectVisualJob(job.id, job.clipId);
            if (result.completed) {
              completedCount += 1;
            } else if (result.state === "partial" || result.state === "failed") {
              failedCount += 1;
            } else {
              remainingCount += 1;
            }
          } catch (error) {
            const message = readableError(error);
            errors.push(message);
            await setVisualClipStage(project.id, job.clipId, "failed", {
              batchJobId: job.id,
              error: message,
            }).catch(() => undefined);
          }
        }
      }
      await refreshVisualState();
      if (errors.length > 0) {
        setNotice({
          tone: "error",
          message: errors.length === 1
            ? errors[0]
            : `${errors.length} clips could not be refreshed. ${errors[0]}`,
        });
      } else if (failedCount > 0) {
        setNotice({
          tone: "error",
          message: `AI analysis stopped: ${failedCount} clip${
            failedCount === 1 ? "" : "s"
          } failed, ${completedCount} finished, and ${remainingCount} remain in progress.`,
        });
      } else if (remainingCount > 0) {
        setNotice({
          tone: "warning",
          message: `AI analysis is in progress: ${completedCount} of ${
            pendingJobs.length
          } currently active clip${pendingJobs.length === 1 ? "" : "s"} finished; ${
            remainingCount
          } remaining.`,
        });
      } else if (completedCount > 0) {
        setNotice({
          tone: "success",
          message: `AI analysis finished. Descriptions and tags are ready for ${
            completedCount
          } clip${completedCount === 1 ? "" : "s"}.`,
        });
      } else if (!silent) {
        setNotice({
          tone: "success",
          message: "There are no AI analysis jobs in progress.",
        });
      }
    } catch (error) {
      setNotice({ tone: "error", message: readableError(error) });
    } finally {
      setVisualWorkingClipId(null);
      setVisualProgress(null);
      await refreshVisualState();
    }
  }

  async function saveMomentMetadata(
    moment: VisualMoment,
    description: string,
    tags: string[],
  ) {
    await updateVisualMomentMetadata(moment, description, tags);
    await loadVisualDetail(moment.clipId);
    await refreshVisualState();
  }

  async function saveClipVisualMetadata(
    clipId: string,
    description: string,
    tags: string[],
  ) {
    await updateClipVisualMetadata(
      project.id,
      clipId,
      description,
      tags,
    );
    await refreshVisualState();
  }

  const activeVisualClipIds = new Set(
    visualJobs
      .filter(
        (job) =>
          job.clipId && visualJobIsActive(job),
      )
      .map((job) => job.clipId),
  );
  const remainingVisualImageClips = clips.filter(
    (clip) =>
      (visualSummaries[clip.id]?.totalFrames ?? 0) === 0 &&
      !activeVisualClipIds.has(clip.id),
  );
  const remainingVisualClips = clips.filter(
    (clip) =>
      (!clip.hasAudio ||
        transcriptSummaries[clip.id]?.stage === "complete") &&
      (visualSummaries[clip.id]?.totalFrames ?? 0) > 0 &&
      (visualMetadata[clip.id]?.visualStage !== "complete" ||
        visualMetadata[clip.id]?.analysisVersion !== "4") &&
      !activeVisualClipIds.has(clip.id),
  );
  const activeVisualJobs = visualJobs.filter(visualJobNeedsRefresh);
  const pendingVisualJobCount = activeVisualJobs.length;
  const activeStages = activeVisualJobs.map(visualAnalysisProgressStage);
  const leastAdvancedStage = [...activeStages].sort(
    (left, right) => left.percent - right.percent,
  )[0];
  const latestTrackedJobByClip = new Map<string, VisualAnalysisJob>();
  for (const job of visualJobs) {
    if (
      job.clipId &&
      job.analysisVersion === "4" &&
      !latestTrackedJobByClip.has(job.clipId) &&
      (visualJobIsActive(job) || job.state === "complete")
    ) {
      latestTrackedJobByClip.set(job.clipId, job);
    }
  }
  const trackedJobs = [...latestTrackedJobByClip.values()];
  const trackedStages = trackedJobs.map(visualAnalysisProgressStage);
  const analysisProgress = leastAdvancedStage
    ? {
        percent: Math.round(
          trackedStages.reduce((total, stage) => total + stage.percent, 0) /
            trackedStages.length,
        ),
        label: leastAdvancedStage.label,
        activeClipCount: new Set(
          activeVisualJobs.flatMap((job) => job.clipId ? [job.clipId] : []),
        ).size,
        readyClipCount: trackedJobs.filter(
          (job) => job.state === "complete" || job.phase === "complete",
        ).length,
        totalClipCount: trackedJobs.length,
      }
    : null;
  const recordedVisualCost = visualJobs.reduce(
    (total, job) =>
      total +
      (job.actualCostUsd ??
        (job.state === "complete" ? job.estimatedCostUsd : 0)),
    0,
  );

  useEffect(() => {
    if (pendingVisualJobCount === 0 || visualWorkingClipId) return;
    const hasFastJob = activeVisualJobs.some(
      (job) => job.analysisMode === "fast",
    );
    const timer = window.setTimeout(() => {
      void refreshPendingVisualAnalysis(true);
    }, hasFastJob ? 5_000 : 45_000);
    return () => window.clearTimeout(timer);
  }, [pendingVisualJobCount, visualJobs, visualWorkingClipId]);

  return {
    visualSummaries,
    visualMetadata,
    visualFramesByClip,
    visualMomentsByClip,
    expandedVisualIds,
    visualFilter,
    setVisualFilter,
    visualWorkingClipId,
    visualProgress,
    visualPreflight,
    setVisualPreflight,
    analysisMode,
    setAnalysisMode,
    toggleVisual,
    prepareVisualImages,
    prepareVisualAnalysis,
    analyzePreparedVisuals,
    saveMomentMetadata,
    saveClipVisualMetadata,
    remainingVisualClips,
    remainingVisualImageClips,
    pendingVisualJobCount,
    analysisProgress,
    recordedVisualCost,
  };
}
