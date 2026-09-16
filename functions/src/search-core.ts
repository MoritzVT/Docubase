import { createHash } from "node:crypto";

export const SEARCH_EMBEDDING_MODEL = "gemini-embedding-2";
export const SEARCH_EMBEDDING_DIMENSIONS = 768;
export const SEARCH_INDEX_VERSION = "1";
export const SEARCH_PASSAGE_DURATION_MS = 45_000;

export type SearchDocumentKind = "clip" | "visual" | "spoken";
export type SearchScope = "all" | "visual" | "spoken";

export interface SearchUtterance {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
}

export interface TranscriptPassage {
  id: string;
  startMs: number;
  endMs: number;
  utteranceIds: string[];
  text: string;
}

export interface SearchDocumentRecord {
  id: string;
  projectId: string;
  clipId: string;
  kind: SearchDocumentKind;
  filename: string;
  filenameAliases: string[];
  description: string;
  tags: string[];
  startMs: number;
  endMs: number;
  frameIds: string[];
  utteranceIds: string[];
  thumbnailStoragePath: string | null;
  embeddingText: string;
}

export function normalizeFilename(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase();
}

export function filenameAliases(filename: string): string[] {
  const normalized = normalizeFilename(filename);
  const lastDot = normalized.lastIndexOf(".");
  const withoutExtension = lastDot > 0 ? normalized.slice(0, lastDot) : normalized;
  return [...new Set([normalized, withoutExtension].filter(Boolean))];
}

export function prepareSearchDocument(title: string, text: string): string {
  return `title: ${title.trim() || "none"} | text: ${text.trim()}`;
}

export function prepareSearchQuery(query: string): string {
  return `task: search result | query: ${query.trim()}`;
}

export function searchDocumentId(
  kind: SearchDocumentKind,
  clipId: string,
  sourceId: string,
): string {
  const digest = createHash("sha256")
    .update(`${kind}\0${clipId}\0${sourceId}`)
    .digest("hex")
    .slice(0, 24);
  return `${kind}-${digest}`;
}

/**
 * Groups complete-clip transcript evidence into low-cost, non-overlapping
 * 45-second windows. The final short window is extended backwards so normal
 * clips use 30–60 second passages; clips shorter than 30 seconds remain whole.
 */
export function buildTranscriptPassages(
  utterances: SearchUtterance[],
  durationMs: number,
): TranscriptPassage[] {
  const usable = utterances
    .filter(
      (item) =>
        item.text.trim().length > 0 &&
        Number.isFinite(item.startMs) &&
        Number.isFinite(item.endMs) &&
        item.startMs >= 0 &&
        item.endMs >= item.startMs,
    )
    .sort((left, right) => left.startMs - right.startMs);
  if (usable.length === 0) return [];

  const clipEnd = Math.max(
    1,
    durationMs,
    ...usable.map((item) => item.endMs),
  );
  const windows: Array<{ startMs: number; endMs: number }> = [];
  for (let startMs = 0; startMs < clipEnd; startMs += SEARCH_PASSAGE_DURATION_MS) {
    windows.push({
      startMs,
      endMs: Math.min(clipEnd, startMs + SEARCH_PASSAGE_DURATION_MS),
    });
  }
  const last = windows.at(-1);
  if (last && last.endMs - last.startMs < 30_000 && windows.length > 1) {
    last.startMs = Math.max(0, last.endMs - SEARCH_PASSAGE_DURATION_MS);
  }

  return windows.flatMap((window, index) => {
    const evidence = usable.filter(
      (item) => item.endMs >= window.startMs && item.startMs < window.endMs,
    );
    if (evidence.length === 0) return [];
    const text = evidence.map((item) => item.text.trim()).join(" ").trim();
    if (!text) return [];
    return [{
      id: `passage-${index.toString().padStart(6, "0")}`,
      startMs: window.startMs,
      endMs: window.endMs,
      utteranceIds: evidence.map((item) => item.id),
      text,
    }];
  });
}

export function estimateEmbeddingTokens(records: SearchDocumentRecord[]): number {
  return records.reduce(
    (total, record) => total + Math.ceil(record.embeddingText.length / 4),
    0,
  );
}

export function scopeKind(scope: SearchScope): SearchDocumentKind | null {
  if (scope === "visual") return "visual";
  if (scope === "spoken") return "spoken";
  return null;
}
