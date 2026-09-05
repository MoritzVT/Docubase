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
      if (chunk.stage === "syncing") {
        setTranscriptionProgress(
          `${clip.filename}: resuming cloud sync (${position + 1}/${chunks.length})`,
        );
        payload = await transcriptChunkPayload(
          project.id,
          clip.id,
          chunk.chunkIndex,
        );
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
          `${clip.filename}: transcribing locally with Apple Speech (${position + 1}/${chunks.length}). The first run may download Apple's language model.`,
        );
        payload = await transcribeAudioChunk(
          project.id,
          clip.id,
          chunk.chunkIndex,
          [...project.knownNames, ...project.terminology],
        );
      }

      setTranscriptionProgress(
        `${clip.filename}: saving the transcript (${position + 1}/${chunks.length})`,
      );
      await syncTranscriptChunk(payload);
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
      for (const clip of remainingTranscribableClips) {
        setTranscribingClipId(clip.id);
        await processClipTranscription(clip);
      }
      setNotice({
        tone: "success",
        message: `${remainingTranscribableClips.length} clip${
          remainingTranscribableClips.length === 1 ? "" : "s"
        } transcribed locally. Temporary audio was removed after safe sync.`,
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
