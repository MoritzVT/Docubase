import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  ClipManifest,
  ImportProgress,
  LocalProject,
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
