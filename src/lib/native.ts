import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  ClipTranscriptSummary,
  ClipManifest,
  ImportProgress,
  LocalProject,
  TranscriptChunkPayload,
  TranscriptSearchMatch,
  TranscriptUtterance,
  TranscriptionChunk,
} from "./contracts";

export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function posterSource(path: string | null): string | null {
  if (!path) return null;
  return isTauri ? convertFileSrc(path) : null;
}

export async function chooseFolder(): Promise<string | null> {
  if (!isTauri) return null;
  const selection = await open({
    directory: true,
    multiple: false,
    title: "Choose a footage folder",
  });
  return typeof selection === "string" ? selection : null;
}

export async function upsertLocalProject(
  project: LocalProject,
): Promise<void> {
  if (!isTauri) return;
  await invoke("upsert_local_project", { project });
}

export async function listLocalProjects(): Promise<LocalProject[]> {
  if (!isTauri) return [];
  return invoke("list_local_projects");
}

export async function listLocalClips(
  projectId: string,
): Promise<ClipManifest[]> {
  if (!isTauri) return [];
  return invoke("list_local_clips", { projectId });
}

export async function scanFolder(
  projectId: string,
  folderPath: string,
): Promise<ClipManifest[]> {
  if (!isTauri) throw new Error("Footage import requires the desktop app.");
  return invoke("scan_folder", { projectId, folderPath });
}

export async function relinkFolder(
  projectId: string,
  folderPath: string,
): Promise<number> {
  if (!isTauri) throw new Error("Relinking requires the desktop app.");
  return invoke("relink_folder", { projectId, folderPath });
}

export async function revealClip(
  projectId: string,
  clipId: string,
): Promise<void> {
  if (!isTauri) throw new Error("Finder integration requires the desktop app.");
  await invoke("reveal_clip", { projectId, clipId });
}

export async function onImportProgress(
  listener: (progress: ImportProgress) => void,
): Promise<UnlistenFn> {
  if (!isTauri) return () => undefined;
  return listen<ImportProgress>("import-progress", (event) =>
    listener(event.payload),
  );
}

export async function prepareTranscription(
  projectId: string,
  clipId: string,
): Promise<TranscriptionChunk[]> {
  if (!isTauri) throw new Error("Transcription requires the desktop app.");
  return invoke("prepare_transcription", { projectId, clipId });
}

export async function listTranscriptionChunks(
  projectId: string,
  clipId: string,
): Promise<TranscriptionChunk[]> {
  if (!isTauri) return [];
  return invoke("list_transcription_chunks", { projectId, clipId });
}

export async function listTranscriptSummaries(
  projectId: string,
): Promise<ClipTranscriptSummary[]> {
  if (!isTauri) return [];
  return invoke("list_transcript_summaries", { projectId });
}

export async function listTranscriptUtterances(
  projectId: string,
  clipId: string,
): Promise<TranscriptUtterance[]> {
  if (!isTauri) return [];
  return invoke("list_transcript_utterances", { projectId, clipId });
}

export async function searchTranscripts(
  projectId: string,
  query: string,
): Promise<TranscriptSearchMatch[]> {
  if (!isTauri) return [];
  return invoke("search_transcripts", { projectId, query });
}

export async function extractTranscriptionChunk(
  projectId: string,
  clipId: string,
  chunkIndex: number,
): Promise<TranscriptionChunk> {
  if (!isTauri) throw new Error("Audio extraction requires the desktop app.");
  return invoke("extract_transcription_chunk", {
    projectId,
    clipId,
    chunkIndex,
  });
}

export async function transcribeAudioChunk(
  projectId: string,
  clipId: string,
  chunkIndex: number,
  accessToken: string,
  reservationId: string,
  estimatedCostUsd: number,
): Promise<TranscriptChunkPayload> {
  if (!isTauri) throw new Error("Transcription requires the desktop app.");
  return invoke("transcribe_audio_chunk", {
    projectId,
    clipId,
    chunkIndex,
    accessToken,
    reservationId,
    estimatedCostUsd,
  });
}

export async function transcriptChunkPayload(
  projectId: string,
  clipId: string,
  chunkIndex: number,
): Promise<TranscriptChunkPayload> {
  if (!isTauri) throw new Error("Transcription requires the desktop app.");
  return invoke("transcript_chunk_payload", {
    projectId,
    clipId,
    chunkIndex,
  });
}

export async function completeTranscriptionChunk(
  projectId: string,
  clipId: string,
  chunkIndex: number,
): Promise<TranscriptionChunk> {
  if (!isTauri) throw new Error("Transcription requires the desktop app.");
  return invoke("complete_transcription_chunk", {
    projectId,
    clipId,
    chunkIndex,
  });
}
