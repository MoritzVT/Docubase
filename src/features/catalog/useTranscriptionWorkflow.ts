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
import { readableError } from "../../lib/presentation";
import type { CatalogNotice } from "./types";

type TranscriptionProgress = {
  message: string;
  completed: number;
  total: number;
};

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
    TranscriptionProgress | null
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

  async function processClipTranscription(
    clip: ClipManifest,
    clipPosition = 0,
    clipTotal = 1,
  ) {
    const total = Math.max(clipTotal, 1) * 100;
    const clipStart = clipPosition * 100;
    const updateProgress = (message: string, clipFraction: number) => {
      setTranscriptionProgress({
        message,
        completed: clipStart + Math.max(0, Math.min(1, clipFraction)) * 100,
        total,
      });
    };
    updateProgress(`${clip.filename}: preparing transcript`, 0);
    let chunks = await prepareTranscription(project.id, clip.id);
    for (let position = 0; position < chunks.length; position += 1) {
      let chunk = chunks[position];
      if (chunk.stage === "complete") continue;
      const chunkProgress = (phase: number) =>
        (position + phase) / Math.max(chunks.length, 1);

      let payload;
      if (chunk.stage === "syncing") {
        updateProgress(
          `${clip.filename}: finishing transcript save (${position + 1}/${chunks.length})`,
          chunkProgress(0.8),
        );
        payload = await transcriptChunkPayload(
          project.id,
          clip.id,
          chunk.chunkIndex,
        );
      } else {
        updateProgress(
          `${clip.filename}: extracting audio (${position + 1}/${chunks.length})`,
          chunkProgress(0.1),
        );
        chunk = await extractTranscriptionChunk(
          project.id,
          clip.id,
          chunk.chunkIndex,
        );
        updateProgress(
          `${clip.filename}: transcribing locally with Apple Speech (${position + 1}/${chunks.length}). The first run may download Apple's language model.`,
          chunkProgress(0.35),
        );
        payload = await transcribeAudioChunk(
          project.id,
          clip.id,
          chunk.chunkIndex,
          [...project.knownNames, ...project.terminology],
        );
      }

      updateProgress(
        `${clip.filename}: saving the transcript (${position + 1}/${chunks.length})`,
        chunkProgress(0.8),
      );
      await syncTranscriptChunk(payload);
      await completeTranscriptionChunk(
        project.id,
        clip.id,
        chunk.chunkIndex,
      );
      chunks = await listTranscriptionChunks(project.id, clip.id);
      updateProgress(
        `${clip.filename}: ${position + 1} of ${chunks.length} chunks complete`,
        chunkProgress(1),
      );
    }

    const utterances = await listTranscriptUtterances(project.id, clip.id);
    setUtterancesByClip((current) => ({ ...current, [clip.id]: utterances }));
    await refreshTranscriptSummaries();
    updateProgress(`${clip.filename}: transcript complete`, 1);
  }

  async function startClipTranscription(clip: ClipManifest) {
    setTranscribingClipId(clip.id);
    setNotice(null);
    try {
      await processClipTranscription(clip);
      setExpandedTranscriptIds((current) => new Set(current).add(clip.id));
      setNotice({
        tone: "success",
        message: `Transcript ready for ${clip.filename}. It was generated on this Mac, then the temporary audio was deleted.`,
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
      for (let index = 0; index < remainingTranscribableClips.length; index += 1) {
        const clip = remainingTranscribableClips[index];
        setTranscribingClipId(clip.id);
        await processClipTranscription(
          clip,
          index,
          remainingTranscribableClips.length,
        );
      }
      setNotice({
        tone: "success",
        message: `${remainingTranscribableClips.length} clip${
          remainingTranscribableClips.length === 1 ? "" : "s"
        } transcribed locally. Temporary audio was removed after the transcript was saved.`,
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
  };
}
