import { type Dispatch, type SetStateAction, useCallback, useEffect, useState } from "react";
import { syncTranscriptChunk } from "../../lib/cloud";
import type {
  ClipManifest,
  ClipTranscriptSummary,
  LocalProject,
  TranscriptUtterance,
} from "../../lib/contracts";
import {
  completeTranscriptionChunk,
  extractTranscriptionChunk,
  listTranscriptSummaries,
  listTranscriptUtterances,
  listTranscriptionChunks,
  prepareTranscription,
  transcriptChunkPayload,
  transcribeAudioChunk,
} from "../../lib/native";
import { formatUsd, readableError } from "../../lib/presentation";
import {
  beginTranscriptionChunk,
  completeCloudTranscriptionChunk,
  estimateTranscriptionCost,
} from "../../lib/transcription";
import type { CatalogNotice } from "./types";

export function useTranscriptionWorkflow(
  project: LocalProject,
  clips: ClipManifest[],
  setNotice: Dispatch<SetStateAction<CatalogNotice | null>>,
) {
  const [transcriptSummaries, setTranscriptSummaries] = useState<
    Record<string, ClipTranscriptSummary>
  >({});
  const [utterancesByClip, setUtterancesByClip] = useState<
    Record<string, TranscriptUtterance[]>
  >({});
  const [expandedTranscriptIds, setExpandedTranscriptIds] = useState<
    Set<string>
  >(new Set());
  const [loadingTranscriptIds, setLoadingTranscriptIds] = useState<Set<string>>(
    new Set(),
  );
  const [transcribingClipId, setTranscribingClipId] = useState<string | null>(
    null,
  );
  const [transcriptionProgress, setTranscriptionProgress] = useState<
    string | null
  >(null);
  const [transcriptionDialogOpen, setTranscriptionDialogOpen] = useState(false);

  const refreshTranscriptSummaries = useCallback(async () => {
    try {
      const summaries = await listTranscriptSummaries(project.id);
      setTranscriptSummaries(
        Object.fromEntries(summaries.map((summary) => [summary.clipId, summary])),
      );
    } catch (error) {
      setNotice({ tone: "error", message: readableError(error) });
    }
  }, [project.id]);

  useEffect(() => {
    void refreshTranscriptSummaries();
  }, [refreshTranscriptSummaries]);

  async function toggleTranscript(clipId: string) {
    if (expandedTranscriptIds.has(clipId)) {
      setExpandedTranscriptIds((current) => {
        const next = new Set(current);
        next.delete(clipId);
        return next;
      });
      return;
    }

    setExpandedTranscriptIds((current) => new Set(current).add(clipId));
    if (utterancesByClip[clipId]) return;
    setLoadingTranscriptIds((current) => new Set(current).add(clipId));
    try {
      const utterances = await listTranscriptUtterances(project.id, clipId);
      setUtterancesByClip((current) => ({ ...current, [clipId]: utterances }));
    } catch (error) {
      setNotice({ tone: "error", message: readableError(error) });
    } finally {
      setLoadingTranscriptIds((current) => {
        const next = new Set(current);
        next.delete(clipId);
        return next;
      });
    }
  }

  async function processClipTranscription(clip: ClipManifest) {
    let chunks = await prepareTranscription(project.id, clip.id);
    for (let position = 0; position < chunks.length; position += 1) {
      let chunk = chunks[position];
      if (chunk.stage === "complete") continue;

      let payload;
      let reservationId = chunk.reservationId;
      if (chunk.stage === "syncing") {
        setTranscriptionProgress(
          `${clip.filename}: resuming cloud sync (${position + 1}/${chunks.length})`,
        );
        payload = await transcriptChunkPayload(
          project.id,
          clip.id,
          chunk.chunkIndex,
        );
        if (!reservationId) {
          throw new Error(
            "The saved transcript is missing its usage reservation. Retry the clip.",
          );
        }
      } else {
        setTranscriptionProgress(
          `${clip.filename}: extracting audio (${position + 1}/${chunks.length})`,
        );
        chunk = await extractTranscriptionChunk(
          project.id,
          clip.id,
          chunk.chunkIndex,
        );
        setTranscriptionProgress(
          `${clip.filename}: reserving ${formatUsd(
            estimateTranscriptionCost(chunk.durationMs),
          )} and requesting a temporary Deepgram token`,
        );
        const grant = await beginTranscriptionChunk({
          projectId: project.id,
          clipId: clip.id,
          chunkIndex: chunk.chunkIndex,
        });
        if (grant.alreadyCompleted) {
          throw new Error(
            "This chunk is complete in the cloud but missing locally. Cloud recovery will be added before multi-device collaboration.",
          );
        }
        if (!grant.accessToken) {
          throw new Error("Firebase did not return a temporary Deepgram token.");
        }
        reservationId = grant.reservationId;
        setTranscriptionProgress(
          `${clip.filename}: transcribing with Nova-3 (${position + 1}/${chunks.length})`,
        );
        payload = await transcribeAudioChunk(
          project.id,
          clip.id,
          chunk.chunkIndex,
          grant.accessToken,
          grant.reservationId,
          grant.estimatedCostUsd,
        );
      }

      setTranscriptionProgress(
        `${clip.filename}: saving the transcript (${position + 1}/${chunks.length})`,
      );
      await syncTranscriptChunk(payload);
      await completeCloudTranscriptionChunk({
        projectId: project.id,
        reservationId,
        requestId: payload.chunk.requestId,
      });
      await completeTranscriptionChunk(
        project.id,
        clip.id,
        chunk.chunkIndex,
      );
      chunks = await listTranscriptionChunks(project.id, clip.id);
    }

    const utterances = await listTranscriptUtterances(project.id, clip.id);
    setUtterancesByClip((current) => ({ ...current, [clip.id]: utterances }));
    await refreshTranscriptSummaries();
  }

  async function startClipTranscription(clip: ClipManifest) {
    setTranscribingClipId(clip.id);
    setNotice(null);
    try {
      await processClipTranscription(clip);
      setExpandedTranscriptIds((current) => new Set(current).add(clip.id));
      setNotice({
        tone: "success",
        message: `Transcript ready for ${clip.filename}. Temporary audio chunks were deleted.`,
      });
    } catch (error) {
      await refreshTranscriptSummaries();
      setNotice({ tone: "error", message: readableError(error) });
    } finally {
      setTranscribingClipId(null);
      setTranscriptionProgress(null);
    }
  }

  async function transcribeRemainingClips() {
    setTranscriptionDialogOpen(false);
    setNotice(null);
    try {
      for (const clip of remainingTranscribableClips) {
        setTranscribingClipId(clip.id);
        await processClipTranscription(clip);
      }
      setNotice({
        tone: "success",
        message: `${remainingTranscribableClips.length} clip${
          remainingTranscribableClips.length === 1 ? "" : "s"
        } transcribed. Audio derivatives were removed after safe sync.`,
      });
    } catch (error) {
      await refreshTranscriptSummaries();
      setNotice({ tone: "error", message: readableError(error) });
    } finally {
      setTranscribingClipId(null);
      setTranscriptionProgress(null);
    }
  }

  const remainingTranscribableClips = clips.filter(
    (clip) =>
      clip.hasAudio && transcriptSummaries[clip.id]?.stage !== "complete",
  );
  const remainingTranscriptionCost = remainingTranscribableClips.reduce(
    (sum, clip) => {
      const summary = transcriptSummaries[clip.id];
      const remainingRatio =
        summary && summary.totalChunks > 0
          ? Math.max(
              0,
              (summary.totalChunks - summary.completedChunks) /
                summary.totalChunks,
            )
          : 1;
      return sum + estimateTranscriptionCost(clip.durationMs * remainingRatio);
    },
    0,
  );
  const recordedTranscriptionCost = Object.values(transcriptSummaries).reduce(
    (sum, summary) => sum + summary.estimatedCostUsd,
    0,
  );

  return {
    transcriptSummaries,
    utterancesByClip,
    expandedTranscriptIds,
    loadingTranscriptIds,
    transcribingClipId,
    transcriptionProgress,
    transcriptionDialogOpen,
    setTranscriptionDialogOpen,
    toggleTranscript,
    startClipTranscription,
    transcribeRemainingClips,
    remainingTranscribableClips,
    remainingTranscriptionCost,
    recordedTranscriptionCost,
  };
}
