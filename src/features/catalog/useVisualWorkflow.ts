import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
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
  VisualAnalysisRun,
  VisualAnalysisJob,
  VisualFrame,
  VisualMoment,
} from "../../lib/contracts";
import {
  createVisualAnalysisRun,
  extractVisualIndex,
  finishVisualAnalysisRun,
  getActiveVisualAnalysisRun,
  listTranscriptUtterances,
  listVisualFrames,
  listVisualSummaries,
  markVisualFrameUploaded,
  readVisualFrame,
  setVisualClipStage,
  updateVisualAnalysisQueueItem,
} from "../../lib/native";
import { readableError } from "../../lib/presentation";
import {
  refreshVisualAnalysis,
  estimateVisualAnalysisCost,
  submitVisualAnalysis,
  TRANSCRIPT_SECTION_MAX_CHARACTERS,
  uploadRetainedFrame,
  visualAnalysisProgressStage,
} from "../../lib/visual";
import type { CatalogNotice } from "./types";

type VisualProgress = {
  message: string;
  completed: number;
  total: number;
  kind: "images" | "analysis";
};

const ANALYSIS_SUBMISSION_CONCURRENCY = 3;
const ANALYSIS_MAX_SUBMISSION_ATTEMPTS = 5;
const ANALYSIS_POLL_BATCH_SIZE = 25;

function isTransientAnalysisError(message: string): boolean {
  if (/no new paid request|project allows|invalid|permission|unauthorized/i.test(message)) {
    return false;
  }
  return /\b429\b|\b500\b|\b502\b|\b503\b|\b504\b|unavailable|deadline|timeout|timed out|network|fetch|temporar|too many requests|quota/i.test(
    message,
  );
}

function retryDelayMs(attempt: number): number {
  return Math.min(30_000, 1_500 * 2 ** Math.max(0, attempt - 1));
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

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
  const [visualProgress, setVisualProgress] = useState<VisualProgress | null>(null);
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>("batch");
  const [analysisRun, setAnalysisRun] = useState<VisualAnalysisRun | null>(null);
  const processingRunId = useRef<string | null>(null);
  const pollCursor = useRef(0);
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

  useEffect(() => {
    let cancelled = false;
    void getActiveVisualAnalysisRun(project.id)
      .then((run) => {
        if (!cancelled) setAnalysisRun(run);
      })
      .catch((error) => {
        if (!cancelled) {
          setNotice({ tone: "error", message: readableError(error) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [project.id]);

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
    const skipped: Array<{ clip: ClipManifest; error: string }> = [];
    for (let index = 0; index < clipsToExtract.length; index += 1) {
      const clip = clipsToExtract[index];
      setVisualWorkingClipId(clip.id);
      setVisualProgress({
        message: `${clip.filename}: sampling locally at one frame per second (${index + 1}/${clipsToExtract.length}, ${skipped.length} skipped)`,
        completed: index,
        total: clipsToExtract.length,
        kind: "images",
      });
      try {
        const frames = await extractVisualIndex(project.id, clip.id);
        setVisualFramesByClip((current) => ({ ...current, [clip.id]: frames }));
        prepared.push({ clip, frames });
      } catch (error) {
        skipped.push({ clip, error: readableError(error) });
      }
      setVisualProgress({
        message: `${index + 1} of ${clipsToExtract.length} clips checked (${skipped.length} skipped)`,
        completed: index + 1,
        total: clipsToExtract.length,
        kind: "images",
      });
    }
    await refreshVisualState();
    return { prepared, skipped };
  }

  async function prepareVisualImages(clipsToExtract: ClipManifest[]) {
    setNotice(null);
    try {
      const { prepared, skipped } = await extractVisuals(clipsToExtract);
      setNotice({
        tone: skipped.length > 0 ? "warning" : "success",
        message: `${prepared.length} clip${prepared.length === 1 ? "" : "s"} generated. ${
          skipped.length > 0
            ? `${skipped.length} unreadable or unsupported file${skipped.length === 1 ? " was" : "s were"} skipped; processing continued.`
            : "No files were skipped."
        } No images were uploaded and no AI cost was incurred.`,
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
    if (analysisRun?.state === "active") {
      setNotice({
        tone: "warning",
        message: "The current project-wide analysis run is still active.",
      });
      return;
    }
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
      const preparationTotal = Math.max(clipsToPrepare.length * 2, 1);
      let preparationCompleted = 0;
      setVisualProgress({
        message: "Preparing clip images for analysis…",
        completed: 0,
        total: preparationTotal,
        kind: "analysis",
      });
      const prepared = await Promise.all(
        clipsToPrepare.map(async (clip) => {
          const item = {
            clip,
            frames:
            visualFramesByClip[clip.id] ??
            await listVisualFrames(project.id, clip.id),
          };
          preparationCompleted += 1;
          setVisualProgress({
            message: `Preparing images: ${preparationCompleted} of ${clipsToPrepare.length} clips`,
            completed: preparationCompleted,
            total: preparationTotal,
            kind: "analysis",
          });
          return item;
        }),
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
          prepared.map(async ({ clip }) => {
            const utterances = await listTranscriptUtterances(project.id, clip.id);
            preparationCompleted += 1;
            setVisualProgress({
              message: `Preparing transcripts: ${preparationCompleted - clipsToPrepare.length} of ${clipsToPrepare.length} clips`,
              completed: preparationCompleted,
              total: preparationTotal,
              kind: "analysis",
            });
            return [clip.id, utterances] as const;
          }),
        ),
      );
      const momentIds = new Set(
        prepared.flatMap(({ clip, frames }) =>
          frames.map((frame) => `${clip.id}:${frame.momentId}`),
        ),
      );
      const sharedContext = [
        `Project brief: ${project.brief.slice(0, 800) || "Not provided"}`,
        `Known names: ${project.knownNames.slice(0, 30).join(", ").slice(0, 500) || "None"}`,
        `Terminology: ${project.terminology.slice(0, 50).join(", ").slice(0, 800) || "None"}`,
        "Project background may clarify names, terminology, and subject matter, but it is not evidence that anything is said or visible in this clip.",
        `Project background: ${project.contextText.slice(0, 12_000) || "Not provided"}`,
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
            `${sharedContext}\nClip: ${clip.filename.slice(0, 300)}`.length / 4,
          );
          return total + momentFrames.size * contextTokens;
        }, 0),
        summaryFrameCount: prepared.reduce(
          (total, item) => total + Math.min(item.frames.length, 1),
          0,
        ),
        summaryInputTextTokens: prepared.reduce((total, { clip }) => {
          const contextTokens = Math.ceil(
            `${sharedContext}\nClip: ${clip.filename.slice(0, 300)}`.length / 4,
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
    try {
      const estimatedCostUsd = estimateVisualAnalysisCost(
        preflight.frameCount,
        preflight.momentCount,
        preflight.estimatedInputTextTokens,
        preflight.transcriptRequestCount,
        preflight.summaryFrameCount,
        preflight.summaryInputTextTokens,
        analysisMode,
      );
      const run = await createVisualAnalysisRun({
        runId: crypto.randomUUID(),
        projectId: project.id,
        clipIds: preflight.clips.map((clip) => clip.id),
        analysisMode,
        estimatedCostUsd,
      });
      pollCursor.current = 0;
      setAnalysisRun(run);
      setNotice({
        tone: "warning",
        message: `${run.totalCount} clips queued for analysis. Docubase will continue past individual errors and resume this run if reopened.`,
      });
    } catch (error) {
      setNotice({ tone: "error", message: readableError(error) });
    }
  }

  async function submitAnalysisQueueItem(
    run: VisualAnalysisRun,
    initialItem: VisualAnalysisRun["items"][number],
    clip: ClipManifest | undefined,
    summaries: Record<string, ClipVisualSummary>,
  ) {
    if (!clip) {
      const updated = await updateVisualAnalysisQueueItem({
        runId: run.id,
        clipId: initialItem.clipId,
        itemState: "skipped",
        error: "Clip is no longer in the local catalog.",
      });
      setAnalysisRun(updated);
      return;
    }
    let item = initialItem;
    while (item.attemptCount < ANALYSIS_MAX_SUBMISSION_ATTEMPTS) {
      const attempting = await updateVisualAnalysisQueueItem({
        runId: run.id,
        clipId: clip.id,
        itemState: "retrying",
        error: null,
        incrementAttempt: true,
      });
      setAnalysisRun(attempting);
      item = attempting.items.find((candidate) => candidate.clipId === clip.id) ?? item;
      setVisualWorkingClipId(clip.id);
      setVisualProgress({
        message: `${clip.filename}: submitting analysis (attempt ${item.attemptCount}/${ANALYSIS_MAX_SUBMISSION_ATTEMPTS})`,
        completed: attempting.completedCount + attempting.failedCount + attempting.skippedCount,
        total: attempting.totalCount,
        kind: "analysis",
      });
      try {
        let frames =
          visualFramesByClip[clip.id] ??
          (await listVisualFrames(project.id, clip.id));
        if (frames.length === 0) {
          const updated = await updateVisualAnalysisQueueItem({
            runId: run.id,
            clipId: clip.id,
            itemState: "skipped",
            error: "No local clip images are available.",
          });
          setAnalysisRun(updated);
          return;
        }
        await setVisualClipStage(project.id, clip.id, "uploading");
        const routingFrame = frames[Math.floor((frames.length - 1) / 2)];
        if (!routingFrame.storagePath) {
          const bytes = await readVisualFrame(project.id, clip.id, routingFrame.id);
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
        const submission = await submitVisualAnalysis({
          projectId: project.id,
          clipId: clip.id,
          analysisMode: run.analysisMode,
          frames: frames.map((frame) => ({
            id: frame.id,
            momentId: frame.momentId,
            timestampMs: frame.timestampMs,
            fileSizeBytes: frame.fileSizeBytes,
            changeScore: frame.changeScore,
          })),
          stability: {
            significantChangeCount: summaries[clip.id]?.significantChangeCount ?? 0,
            significantChangeRatio: summaries[clip.id]?.significantChangeRatio ?? 1,
            medianChangeScore: summaries[clip.id]?.medianChangeScore ?? 1,
            maximumChangeScore: summaries[clip.id]?.maximumChangeScore ?? 1,
          },
        });
        await setVisualClipStage(project.id, clip.id, "batched", {
          batchJobId: submission.jobId,
          estimatedCostUsd: submission.estimatedCostUsd,
        });
        let itemState: "submitted" | "complete" | "failed" = "submitted";
        let itemError: string | null = null;
        if (run.analysisMode === "fast") {
          const result = await collectVisualJob(submission.jobId, clip.id);
          if (result.completed) itemState = "complete";
          else if (result.state === "partial" || result.state === "failed") {
            itemState = "failed";
            itemError = visualRetryMessage(result);
          }
        }
        const updated = await updateVisualAnalysisQueueItem({
          runId: run.id,
          clipId: clip.id,
          itemState,
          jobId: submission.jobId,
          error: itemError,
        });
        setAnalysisRun(updated);
        return;
      } catch (error) {
        const message = readableError(error);
        const canRetry =
          item.attemptCount < ANALYSIS_MAX_SUBMISSION_ATTEMPTS &&
          isTransientAnalysisError(message);
        const updated = await updateVisualAnalysisQueueItem({
          runId: run.id,
          clipId: clip.id,
          itemState: canRetry ? "retrying" : "failed",
          error: message,
        });
        setAnalysisRun(updated);
        if (!canRetry) {
          await setVisualClipStage(project.id, clip.id, "failed", { error: message })
            .catch(() => undefined);
          return;
        }
        item = updated.items.find((candidate) => candidate.clipId === clip.id) ?? item;
        await wait(retryDelayMs(item.attemptCount));
      }
    }
  }

  async function refreshSubmittedQueueItems(run: VisualAnalysisRun) {
    const submitted = run.items.filter(
      (item) => item.state === "submitted" && item.jobId,
    );
    if (submitted.length === 0) return false;
    let changed = false;
    const start = pollCursor.current % submitted.length;
    const selected = Array.from(
      { length: Math.min(ANALYSIS_POLL_BATCH_SIZE, submitted.length) },
      (_, offset) => submitted[(start + offset) % submitted.length],
    );
    pollCursor.current = (start + selected.length) % submitted.length;
    for (const item of selected) {
      try {
        const result = await collectVisualJob(item.jobId!, item.clipId);
        if (result.completed || result.state === "partial" || result.state === "failed") {
          const updated = await updateVisualAnalysisQueueItem({
            runId: run.id,
            clipId: item.clipId,
            itemState: result.completed ? "complete" : "failed",
            jobId: item.jobId,
            error: result.completed ? null : visualRetryMessage(result),
          });
          setAnalysisRun(updated);
          changed = true;
        }
      } catch (error) {
        if (!isTransientAnalysisError(readableError(error))) {
          const updated = await updateVisualAnalysisQueueItem({
            runId: run.id,
            clipId: item.clipId,
            itemState: "failed",
            jobId: item.jobId,
            error: readableError(error),
          });
          setAnalysisRun(updated);
          changed = true;
        }
      }
    }
    return changed;
  }

  async function processVisualAnalysisRun(run: VisualAnalysisRun) {
    if (processingRunId.current) return;
    processingRunId.current = run.id;
    try {
      const current = await getActiveVisualAnalysisRun(project.id);
      if (!current || current.id !== run.id) return;
      setAnalysisRun(current);
      const summaries = Object.fromEntries(
        (await listVisualSummaries(project.id)).map((summary) => [
          summary.clipId,
          summary,
        ]),
      );
      const clipsById = new Map(clips.map((clip) => [clip.id, clip]));
      const waiting = current.items.filter(
        (item) => item.state === "queued" || item.state === "retrying",
      );
      let nextIndex = 0;
      const workers = Array.from(
        { length: Math.min(ANALYSIS_SUBMISSION_CONCURRENCY, waiting.length) },
        async () => {
          while (nextIndex < waiting.length) {
            const item = waiting[nextIndex];
            nextIndex += 1;
            await submitAnalysisQueueItem(
              current,
              item,
              clipsById.get(item.clipId),
              summaries,
            );
          }
        },
      );
      await Promise.all(workers);
      let latest = await getActiveVisualAnalysisRun(project.id);
      if (!latest) return;
      const queueChanged = await refreshSubmittedQueueItems(latest);
      latest = await getActiveVisualAnalysisRun(project.id);
      if (!latest) return;
      const finished = await finishVisualAnalysisRun(latest.id);
      setAnalysisRun(finished);
      if (finished.state !== "active") {
        setNotice({
          tone: finished.failedCount > 0 ? "warning" : "success",
          message: `AI analysis run finished: ${finished.completedCount} complete, ${finished.failedCount} failed, and ${finished.skippedCount} skipped.`,
        });
      }
      if (waiting.length > 0 || queueChanged || finished.state !== "active") {
        await refreshVisualState();
      }
    } catch (error) {
      setNotice({ tone: "error", message: readableError(error) });
    } finally {
      processingRunId.current = null;
      setVisualWorkingClipId(null);
      setVisualProgress(null);
    }
  }

  async function collectVisualJob(
    jobId: string,
    clipId: string,
    progress?: { completed: number; total: number; label: string },
  ) {
    let result = await refreshVisualAnalysis({
      projectId: project.id,
      jobId,
    });
    if (result.route === "fullVisual" && !result.completed) {
      const frames = await listVisualFrames(project.id, clipId);
      const missingFrames = frames.filter((frame) => !frame.storagePath);
      for (let index = 0; index < missingFrames.length; index += 1) {
        const frame = missingFrames[index];
        setVisualProgress({
          message: `${progress?.label ?? clipId}: uploading visual frame ${index + 1}/${missingFrames.length}`,
          completed: progress
            ? progress.completed + (index / Math.max(missingFrames.length, 1)) * 0.6
            : index,
          total: progress?.total ?? missingFrames.length,
          kind: "analysis",
        });
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
    }
    const errors: string[] = [];
    let completedCount = 0;
    let failedCount = 0;
    let remainingCount = 0;
    try {
      const pendingJobs = visualJobs.filter((job) =>
        visualJobNeedsRefresh(job),
      );
      if (!silent) {
        setVisualProgress({
          message: "Checking AI analysis jobs…",
          completed: 0,
          total: Math.max(pendingJobs.length, 1),
          kind: "analysis",
        });
      }
      for (let index = 0; index < pendingJobs.length; index += 1) {
        const job = pendingJobs[index];
        if (job.clipId) {
          try {
            setVisualWorkingClipId(job.clipId);
            const result = await collectVisualJob(job.id, job.clipId, {
              completed: index,
              total: pendingJobs.length,
              label: job.clipId,
            });
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
        if (!silent) {
          setVisualProgress({
            message: `${index + 1} of ${pendingJobs.length} AI jobs checked`,
            completed: index + 1,
            total: pendingJobs.length,
            kind: "analysis",
          });
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
  const queuedAnalysisClipIds = new Set(
    analysisRun?.state === "active"
      ? analysisRun.items
        .filter((item) => !["complete", "failed", "skipped"].includes(item.state))
        .map((item) => item.clipId)
      : [],
  );
  const remainingVisualImageClips = clips.filter(
    (clip) =>
      (visualSummaries[clip.id]?.totalFrames ?? 0) === 0 &&
      clip.stage !== "failed" &&
      visualSummaries[clip.id]?.stage !== "failed" &&
      !activeVisualClipIds.has(clip.id),
  );
  const skippedVisualImageClipCount = clips.filter(
    (clip) =>
      (visualSummaries[clip.id]?.totalFrames ?? 0) === 0 &&
      (clip.stage === "failed" || visualSummaries[clip.id]?.stage === "failed"),
  ).length;
  const remainingVisualClips = clips.filter(
    (clip) =>
      (!clip.hasAudio ||
        transcriptSummaries[clip.id]?.stage === "complete") &&
      (visualSummaries[clip.id]?.totalFrames ?? 0) > 0 &&
      (visualMetadata[clip.id]?.visualStage !== "complete" ||
        visualMetadata[clip.id]?.analysisVersion !== "4") &&
      !queuedAnalysisClipIds.has(clip.id) &&
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
    if (
      analysisRun?.state === "active" ||
      pendingVisualJobCount === 0 ||
      visualWorkingClipId
    ) return;
    const hasFastJob = activeVisualJobs.some(
      (job) => job.analysisMode === "fast",
    );
    const timer = window.setTimeout(() => {
      void refreshPendingVisualAnalysis(true);
    }, hasFastJob ? 5_000 : 45_000);
    return () => window.clearTimeout(timer);
  }, [analysisRun?.state, pendingVisualJobCount, visualJobs, visualWorkingClipId]);

  useEffect(() => {
    if (analysisRun?.state !== "active" || clips.length === 0) return;
    const hasWaiting = analysisRun.queuedCount + analysisRun.retryingCount > 0;
    const delay = hasWaiting
      ? 100
      : analysisRun.analysisMode === "fast"
        ? 5_000
        : 30_000;
    const timer = window.setTimeout(() => {
      void processVisualAnalysisRun(analysisRun);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [analysisRun?.id, analysisRun?.state, analysisRun?.updatedAt, clips.length]);

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
    analysisRun,
    toggleVisual,
    prepareVisualImages,
    prepareVisualAnalysis,
    analyzePreparedVisuals,
    saveMomentMetadata,
    saveClipVisualMetadata,
    remainingVisualClips,
    remainingVisualImageClips,
    skippedVisualImageClipCount,
    pendingVisualJobCount,
    analysisProgress,
    recordedVisualCost,
  };
}
