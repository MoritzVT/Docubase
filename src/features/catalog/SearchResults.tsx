import { FileSearch, Film, Image, MessageSquareText } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  ClipManifest,
  SemanticSearchResult,
  VisualFrame,
} from "../../lib/contracts";
import { listVisualFrames, posterSource, revealClip } from "../../lib/native";
import { clipTimecode } from "../../lib/timecode";

export function SearchResults({
  clips,
  framesByClip,
  projectId,
  query,
  results,
}: {
  clips: ClipManifest[];
  framesByClip: Record<string, VisualFrame[]>;
  projectId: string;
  query: string;
  results: SemanticSearchResult[];
}) {
  const clipsById = useMemo(
    () => new Map(clips.map((clip) => [clip.id, clip])),
    [clips],
  );
  const [loadedFrames, setLoadedFrames] = useState<Record<string, VisualFrame[]>>({});

  useEffect(() => {
    let cancelled = false;
    const missingClipIds = [...new Set(results.map((result) => result.clipId))]
      .filter((clipId) => !framesByClip[clipId] && !loadedFrames[clipId]);
    if (missingClipIds.length === 0) return;
    void Promise.all(missingClipIds.map(async (clipId) => ({
      clipId,
      frames: await listVisualFrames(projectId, clipId),
    }))).then((loaded) => {
      if (!cancelled) {
        setLoadedFrames((current) => Object.fromEntries([
          ...Object.entries(current),
          ...loaded.map((item) => [item.clipId, item.frames]),
        ]));
      }
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [framesByClip, loadedFrames, projectId, results]);

  return (
    <section className="semantic-results" aria-label={`Search results for ${query}`}>
      <div className="semantic-results-heading">
        <div>
          <span className="eyebrow">Semantic results</span>
          <strong>{results.length} result{results.length === 1 ? "" : "s"} for “{query}”</strong>
        </div>
        <span>Best matches first</span>
      </div>
      {results.length === 0 ? (
        <div className="semantic-empty">
          <FileSearch size={22} />
          <span>No matching visual or spoken evidence was found.</span>
        </div>
      ) : (
        <div className="semantic-result-list">
          {results.map((result) => {
            const clip = clipsById.get(result.clipId);
            const availableFrames = framesByClip[result.clipId] ??
              loadedFrames[result.clipId] ?? [];
            const frame = availableFrames.find((item) =>
              result.frameIds.includes(item.id)) ?? nearestFrame(availableFrames, result.startMs);
            return (
              <article className="semantic-result" key={result.id}>
                <ResultThumbnail
                  localPath={frame?.localPath ?? clip?.posterPath ?? null}
                />
                <div className="semantic-result-copy">
                  <div className="semantic-result-meta">
                    <span className={`evidence-kind ${result.kind}`}>
                      {result.kind === "spoken" ? <MessageSquareText size={12} /> :
                        result.kind === "visual" ? <Image size={12} /> : <Film size={12} />}
                      {result.exactFilename ? "Exact filename" : result.kind}
                    </span>
                    <span>{Math.round(result.score * 100)}% match</span>
                  </div>
                  <strong>{result.filename}</strong>
                  <p className={result.kind === "spoken" ? "search-quote" : undefined}>
                    {result.description}
                  </p>
                  {result.tags.length > 0 && (
                    <div className="search-result-tags">
                      {result.tags.slice(0, 8).map((tag) => <span key={tag}>{tag}</span>)}
                    </div>
                  )}
                </div>
                <div className="semantic-result-actions">
                  {clip && (
                    <code>{clipTimecode(
                      result.startMs,
                      clip.frameRate,
                      clip.startTimecodeFrames,
                    )}</code>
                  )}
                  <button
                    className="row-action"
                    disabled={!clip}
                    onClick={() => void revealClip(projectId, result.clipId)}
                    type="button"
                  >
                    Reveal clip
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ResultThumbnail({
  localPath,
}: {
  localPath: string | null;
}) {
  const source = posterSource(localPath);
  return (
    <div className="semantic-thumbnail">
      {source ? <img alt="" src={source} /> : <Film size={20} />}
    </div>
  );
}

function nearestFrame(frames: VisualFrame[], timestampMs: number): VisualFrame | undefined {
  return frames.reduce<VisualFrame | undefined>((nearest, frame) => {
    if (!nearest) return frame;
    return Math.abs(frame.timestampMs - timestampMs) <
      Math.abs(nearest.timestampMs - timestampMs)
      ? frame
      : nearest;
  }, undefined);
}
