import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  ClipTranscriptSummary,
  ClipManifest,
  ClipVisualSummary,
  ImportProgress,
  LocalProject,
  TranscriptChunkPayload,
  TranscriptSearchMatch,
  TranscriptUtterance,
  TranscriptionChunk,
  VisualFrame,
  VisualAnalysisRun,
  VisualStage,
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

export async function chooseProjectThumbnail(): Promise<string | null> {
  if (!isTauri) return null;
  const selection = await open({
    multiple: false,
    title: "Choose a project thumbnail",
    filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp"] }],
  });
  return typeof selection === "string" ? selection : null;
}

export async function chooseContextTextFiles(): Promise<string[]> {
  if (!isTauri) return [];
  const selection = await open({
    multiple: true,
    title: "Add contextual text files",
    filters: [{ name: "Plain text", extensions: ["txt"] }],
  });
  if (Array.isArray(selection)) return selection;
  return typeof selection === "string" ? [selection] : [];
}

export async function importProjectAsset(
  projectId: string,
  sourcePath: string,
  assetType: "thumbnail" | "context_text",
): Promise<string> {
  if (!isTauri) throw new Error("Project file attachments require the desktop app.");
  return invoke("import_project_asset", { projectId, sourcePath, assetType });
}

export async function readProjectContext(
  projectId: string,
  paths: string[],
): Promise<string> {
  if (!isTauri) return "";
  return invoke("read_project_context", { projectId, paths });
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

export async function deleteLocalProject(projectId: string): Promise<void> {
  if (!isTauri) return;
  await invoke("delete_local_project", { projectId });
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
  contextualTerms: string[],
): Promise<TranscriptChunkPayload> {
  if (!isTauri) throw new Error("Transcription requires the desktop app.");
  return invoke("transcribe_audio_chunk", {
    projectId,
    clipId,
    chunkIndex,
    contextualTerms,
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

export async function extractVisualIndex(
  projectId: string,
  clipId: string,
): Promise<VisualFrame[]> {
  if (!isTauri) throw new Error("Visual extraction requires the desktop app.");
  return invoke("extract_visual_index", { projectId, clipId });
}

export async function listVisualFrames(
  projectId: string,
  clipId: string,
): Promise<VisualFrame[]> {
  if (!isTauri) return [];
  return invoke("list_visual_frames", { projectId, clipId });
}

export async function listVisualSummaries(
  projectId: string,
): Promise<ClipVisualSummary[]> {
  if (!isTauri) return [];
  return invoke("list_visual_summaries", { projectId });
}

export async function readVisualFrame(
  projectId: string,
  clipId: string,
  frameId: string,
): Promise<Uint8Array> {
  if (!isTauri) throw new Error("Visual frames require the desktop app.");
  const bytes = await invoke<number[]>("read_visual_frame", {
    projectId,
    clipId,
    frameId,
  });
  return Uint8Array.from(bytes);
}

export async function markVisualFrameUploaded(
  projectId: string,
  clipId: string,
  frameId: string,
  storagePath: string,
): Promise<VisualFrame> {
  if (!isTauri) throw new Error("Visual upload requires the desktop app.");
  return invoke("mark_visual_frame_uploaded", {
    projectId,
    clipId,
    frameId,
    storagePath,
  });
}

export async function setVisualClipStage(
  projectId: string,
  clipId: string,
  stage: Exclude<VisualStage, "not_started" | "extracting">,
  options?: {
    batchJobId?: string | null;
    estimatedCostUsd?: number | null;
    error?: string | null;
  },
): Promise<void> {
  if (!isTauri) return;
  await invoke("set_visual_clip_stage", {
    projectId,
    clipId,
    stage,
    batchJobId: options?.batchJobId ?? null,
    estimatedCostUsd: options?.estimatedCostUsd ?? null,
    error: options?.error ?? null,
  });
}

export async function createVisualAnalysisRun(input: {
  runId: string;
  projectId: string;
  clipIds: string[];
  analysisMode: "batch" | "fast";
  estimatedCostUsd: number;
}): Promise<VisualAnalysisRun> {
  if (!isTauri) throw new Error("Bulk analysis requires the desktop app.");
  return invoke("create_visual_analysis_run", input);
}

export async function getActiveVisualAnalysisRun(
  projectId: string,
): Promise<VisualAnalysisRun | null> {
  if (!isTauri) return null;
  return invoke("get_active_visual_analysis_run", { projectId });
}

export async function updateVisualAnalysisQueueItem(input: {
  runId: string;
  clipId: string;
  itemState: VisualAnalysisRun["items"][number]["state"];
  jobId?: string | null;
  error?: string | null;
  incrementAttempt?: boolean;
}): Promise<VisualAnalysisRun> {
  if (!isTauri) throw new Error("Bulk analysis requires the desktop app.");
  return invoke("update_visual_analysis_queue_item", {
    ...input,
    jobId: input.jobId ?? null,
    error: input.error ?? null,
    incrementAttempt: input.incrementAttempt ?? false,
  });
}

export async function finishVisualAnalysisRun(
  runId: string,
): Promise<VisualAnalysisRun> {
  if (!isTauri) throw new Error("Bulk analysis requires the desktop app.");
  return invoke("finish_visual_analysis_run", { runId });
}
