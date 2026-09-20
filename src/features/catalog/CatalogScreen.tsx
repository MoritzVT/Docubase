import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  AudioLines,
  ChevronDown,
  ChevronUp,
  FileText,
  Film,
  FolderOpen,
  Images,
  LoaderCircle,
  RefreshCw,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";
import type { User } from "firebase/auth";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Brand, LoadingBlock, Metric, Notice } from "../../components/SharedUi";
import { SelectMenu } from "../../components/SelectMenu";
import { ThemeToggle } from "../../components/Theme";
import { syncClipManifests } from "../../lib/cloud";
import type {
  ClipManifest,
  ImportProgress,
  LocalProject,
  TranscriptSearchMatch,
} from "../../lib/contracts";
import {
  formatBytes,
  formatDuration,
  formatFrameRate,
  formatRecordedAt,
} from "../../lib/format";
import {
  chooseFolder,
  isTauri,
  listLocalClips,
  onImportProgress,
  posterSource,
  relinkFolder,
  revealClip,
  scanFolder,
  searchTranscripts,
} from "../../lib/native";
import { formatUsd, readableError } from "../../lib/presentation";
import { estimateVisualAnalysisCost } from "../../lib/visual";
import { TranscriptPanel, TranscriptionDialog } from "../transcription/TranscriptPanels";
import {
  VisualAnalysisDialog,
  VisualPanel,
} from "../visual/VisualPanels";
import { useTranscriptionWorkflow } from "./useTranscriptionWorkflow";
import { useVisualWorkflow } from "./useVisualWorkflow";
import { useSemanticSearch } from "./useSemanticSearch";
import { SearchResults } from "./SearchResults";
import { SearchIndexDialog } from "./SearchIndexDialog";
import type { CatalogNotice } from "./types";

type DateSortField = "recordedAt" | "createdAt" | "sourceModifiedAt";

function projectSummary(project: LocalProject): string {
  return project.summary.trim();
}

const visualFilterOptions = [
  { value: "all", label: "All visual types" },
  { value: "interview", label: "Interview" },
  { value: "b-roll", label: "B-roll" },
  { value: "archive", label: "Archive" },
  { value: "action", label: "Action" },
  { value: "establishing", label: "Establishing" },
  { value: "no-speech", label: "Non-talking" },
  { value: "single-speaker", label: "Single speaker" },
  { value: "multiple-speakers", label: "Multiple speakers" },
  { value: "voice-over", label: "Voice-over" },
] as const;

const dateSortOptions = [
  { value: "recordedAt", label: "Recorded" },
  { value: "createdAt", label: "Date added" },
  { value: "sourceModifiedAt", label: "File modified" },
] as const;

function clipDate(clip: ClipManifest, field: DateSortField): string | null {
  return field === "createdAt" ? clip.createdAt : clip[field];
}

export function CatalogScreen({
  project,
  user,
  onBack,
}: {
  project: LocalProject;
  user: User;
  onBack: () => void;
}) {
  const [clips, setClips] = useState<ClipManifest[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [query, setQuery] = useState("");
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [transcriptMatches, setTranscriptMatches] = useState<
    TranscriptSearchMatch[]
  >([]);
  const [notice, setNotice] = useState<CatalogNotice | null>(null);
  const [dateSortDirection, setDateSortDirection] = useState<"ascending" | "descending">(
    "ascending",
  );
  const [dateSortField, setDateSortField] = useState<DateSortField>("recordedAt");
  const [searchIndexDialogOpen, setSearchIndexDialogOpen] = useState(false);

  const {
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
  } = useTranscriptionWorkflow(project, clips, setNotice);

  const {
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
    analysisProgress,
    recordedVisualCost,
  } = useVisualWorkflow(project, clips, transcriptSummaries, setNotice);

  const semanticSearch = useSemanticSearch(project.id, setNotice);

  const refreshClips = useCallback(async () => {
    setLoading(true);
    try {
      setClips(await listLocalClips(project.id));
    } catch (error) {
      setNotice({ tone: "error", message: readableError(error) });
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  useEffect(() => {
    void refreshClips();
  }, [refreshClips]);

  useEffect(() => {
    let cleanup: () => void = () => {};
    void onImportProgress(setProgress).then((unlisten) => {
      cleanup = unlisten;
    });
    return () => cleanup();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const normalized = query.trim();
    if (normalized.length < 2) {
      setTranscriptMatches([]);
      return;
    }
    const timeout = window.setTimeout(() => {
      void searchTranscripts(project.id, normalized)
        .then((matches) => {
          if (!cancelled) setTranscriptMatches(matches);
        })
        .catch((error) => {
          if (!cancelled) {
            setNotice({ tone: "error", message: readableError(error) });
          }
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [project.id, query]);

  const visibleClips = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const transcriptClipIds = new Set(
      transcriptMatches.map((match) => match.clipId),
    );
    const semanticClipIds = new Set(
      semanticSearch.submittedQuery === query.trim()
        ? semanticSearch.results.map((result) => result.clipId)
        : [],
    );
    const filtered = !normalized && visualFilter === "all" ? clips : clips.filter((clip) => {
      const visual = visualMetadata[clip.id];
      const matchesVisualFilter =
        visualFilter === "all" ||
        visual?.visualFacets.contentTypes.includes(visualFilter) ||
        visual?.visualFacets.speechStates.includes(visualFilter);
      if (!matchesVisualFilter) return false;
      return (
        [
          clip.filename,
          clip.videoCodec,
          clip.audioCodec ?? "",
          clip.portableDirectoryHint,
          visual?.description ?? "",
          ...(visual?.tags ?? []),
          ...(visual?.visualFacets.settings ?? []),
          ...(visual?.visualFacets.weather ?? []),
          ...(visual?.visualFacets.colors ?? []),
          ...(visual?.visualFacets.moods ?? []),
          ...(visual?.visualFacets.actions ?? []),
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalized) ||
        transcriptClipIds.has(clip.id) ||
        semanticClipIds.has(clip.id)
      );
    });
    return [...filtered].sort((left, right) => {
      const leftDate = clipDate(left, dateSortField);
      const rightDate = clipDate(right, dateSortField);
      if (!leftDate && !rightDate) {
        return left.filename.localeCompare(right.filename);
      }
      if (!leftDate) return 1;
      if (!rightDate) return -1;
      const chronological = leftDate.localeCompare(rightDate);
      return dateSortDirection === "ascending" ? chronological : -chronological;
    });
  }, [
    clips,
    dateSortField,
    query,
    dateSortDirection,
    transcriptMatches,
    visualFilter,
    visualMetadata,
    semanticSearch.results,
    semanticSearch.submittedQuery,
  ]);

  const totalDuration = clips.reduce(
    (sum, clip) => sum + clip.durationMs,
    0,
  );
  const totalBytes = clips.reduce(
    (sum, clip) => sum + clip.fileSizeBytes,
    0,
  );
  const recordedTotalCost =
    recordedVisualCost + (semanticSearch.status?.recordedCostUsd ?? 0);

  async function importFolder() {
    const folderPath = await chooseFolder();
    if (!folderPath) return;
    setWorking(true);
    setNotice(null);
    try {
      const imported = await scanFolder(project.id, folderPath);
      await syncClipManifests(imported);
      await refreshClips();
      setNotice({
        tone: "success",
        message: `${imported.length} clip${imported.length === 1 ? "" : "s"} cataloged. Source footage remains on this Mac.`,
      });
    } catch (error) {
      setNotice({ tone: "error", message: readableError(error) });
    } finally {
      setWorking(false);
      setProgress(null);
    }
  }

  async function relink() {
    const folderPath = await chooseFolder();
    if (!folderPath) return;
    setWorking(true);
    setNotice(null);
    try {
      const count = await relinkFolder(project.id, folderPath);
      setNotice({
        tone: "success",
        message: `${count} catalog entr${count === 1 ? "y" : "ies"} relinked by content fingerprint.`,
      });
      await refreshClips();
    } catch (error) {
      setNotice({ tone: "error", message: readableError(error) });
    } finally {
      setWorking(false);
    }
  }

  return (
    <main className="catalog-shell">
      <header className="catalog-topbar">
        <div className="catalog-title">
          <button
            aria-label="Back to projects"
            className="icon-button"
            onClick={onBack}
          >
            <ArrowLeft size={19} />
          </button>
          <Brand />
          <span className="title-divider" />
          <div>
            <strong>{project.name}</strong>
            <span>{user.email}</span>
          </div>
        </div>
        <div className="topbar-actions">
          <ThemeToggle />
          <button
            className="secondary-button compact"
            disabled={
              working ||
              Boolean(transcribingClipId) ||
              Boolean(visualWorkingClipId) ||
              !isTauri ||
              remainingTranscribableClips.length === 0
            }
            onClick={() => setTranscriptionDialogOpen(true)}
          >
            <AudioLines size={16} />
            1. Transcribe footage
          </button>
          <button
            className="secondary-button compact"
            disabled={
              working ||
              Boolean(transcribingClipId) ||
              Boolean(visualWorkingClipId) ||
              !isTauri ||
              remainingVisualImageClips.length === 0
            }
            onClick={() => void prepareVisualImages(remainingVisualImageClips)}
          >
            <Images size={16} />
            2. Generate clip images
            {skippedVisualImageClipCount > 0 && (
              <span className="button-count">
                {skippedVisualImageClipCount} skipped
              </span>
            )}
          </button>
          <button
            className="secondary-button compact"
            disabled={
              working ||
              Boolean(transcribingClipId) ||
              Boolean(visualWorkingClipId) ||
              analysisRun?.state === "active" ||
              !isTauri ||
              remainingVisualClips.length === 0
            }
            onClick={() => void prepareVisualAnalysis(remainingVisualClips)}
          >
            <Images size={16} />
            {analysisRun?.state === "complete_with_errors"
              ? "Retry failed clips"
              : "3. Analyze clips"}
          </button>
          <button
            className="secondary-button compact"
            disabled={
              working ||
              Boolean(transcribingClipId) ||
              Boolean(visualWorkingClipId) ||
              !isTauri
            }
            onClick={() => void relink()}
          >
            <RefreshCw size={16} />
            Relink folder
          </button>
          <button
            className="primary-button compact"
            disabled={
              working ||
              Boolean(transcribingClipId) ||
              Boolean(visualWorkingClipId) ||
              !isTauri
            }
            onClick={() => void importFolder()}
          >
            {working ? (
              <LoaderCircle className="spin" size={17} />
            ) : (
              <FolderOpen size={17} />
            )}
            Import folder
          </button>
        </div>
      </header>

      <section className="catalog-summary">
        <div>
          <span className="eyebrow">{projectSummary(project)}</span>
          <h1>{project.name}</h1>
          <p>{project.brief || "No production brief yet."}</p>
        </div>
        <div className="metric-row">
          <Metric value={clips.length.toLocaleString()} label="clips" />
          <Metric value={formatDuration(totalDuration)} label="footage" />
          <Metric value={formatBytes(totalBytes)} label="source drives" />
          <Metric value={formatUsd(recordedTotalCost)} label="total cost" />
        </div>
      </section>

      {notice && <Notice tone={notice.tone}>{notice.message}</Notice>}
      {working && progress && (
        <div className="progress-panel">
          <div>
            <LoaderCircle className="spin" size={17} />
            <span>
              Inspecting {progress.currentFilename || "catalog metadata"}
            </span>
          </div>
          <strong>
            {progress.completed} / {progress.total} · {progress.total > 0
              ? Math.round(progress.completed / progress.total * 100)
              : 0}%
          </strong>
          <progress max={Math.max(progress.total, 1)} value={progress.completed} />
        </div>
      )}
      {transcribingClipId && transcriptionProgress && (
        <div className="progress-panel transcription">
          <div>
            <AudioLines className="pulse" size={17} />
            <span>{transcriptionProgress.message}</span>
          </div>
          <strong>
            {Math.round(
              transcriptionProgress.completed /
              Math.max(transcriptionProgress.total, 1) * 100,
            )}%
          </strong>
          <progress
            aria-label="Transcription progress"
            max={Math.max(transcriptionProgress.total, 1)}
            value={transcriptionProgress.completed}
          />
        </div>
      )}
      {visualProgress && (
        <div className="progress-panel visual">
          <div>
            <Images className="pulse" size={17} />
            <span>{visualProgress.message}</span>
          </div>
          <strong>
            {Math.round(
              visualProgress.completed / Math.max(visualProgress.total, 1) * 100,
            )}%
          </strong>
          <progress
            aria-label={visualProgress.kind === "images"
              ? "Clip image generation progress"
              : "AI analysis submission progress"}
            max={Math.max(visualProgress.total, 1)}
            value={visualProgress.completed}
          />
        </div>
      )}
      {analysisRun?.state === "active" && (
        <div className="progress-panel analysis-progress">
          <div>
            <Images className="pulse" size={17} />
            <span>Analyzing the complete project queue</span>
          </div>
          <strong>
            {analysisRun.completedCount + analysisRun.failedCount + analysisRun.skippedCount}
            {" "}of {analysisRun.totalCount} finished
          </strong>
          <progress
            aria-label="Complete project analysis progress"
            max={Math.max(analysisRun.totalCount, 1)}
            value={
              analysisRun.completedCount +
              analysisRun.failedCount +
              analysisRun.skippedCount
            }
          />
          <small>
            {analysisRun.completedCount} complete · {analysisRun.submittedCount} processing · {analysisRun.queuedCount} queued · {analysisRun.retryingCount} retrying · {analysisRun.failedCount} failed · {analysisRun.skippedCount} skipped. Estimated full-run ceiling: {formatUsd(analysisRun.estimatedCostUsd)}.
          </small>
        </div>
      )}
      {analysisProgress && analysisRun?.state !== "active" && (
        <div className="progress-panel analysis-progress">
          <div>
            <Images className="pulse" size={17} />
            <span>{analysisProgress.label}</span>
          </div>
          <strong>
            {analysisProgress.percent}% complete · {100 - analysisProgress.percent}% left
          </strong>
          <progress
            aria-label={`${analysisProgress.percent}% of AI analysis complete`}
            max={100}
            value={analysisProgress.percent}
          />
          <small>
            {analysisProgress.activeClipCount} clip
            {analysisProgress.activeClipCount === 1 ? " is" : "s are"} still in
            AI analysis. {analysisProgress.readyClipCount} of {analysisProgress.totalClipCount}
            {" "}tracked clip descriptions are finished. Progress is based on
            completed pipeline stages and refreshes automatically.
          </small>
        </div>
      )}

      <section className="catalog-panel">
        <div className="catalog-toolbar">
          <form
            className="semantic-search-form"
            onSubmit={(event) => {
              event.preventDefault();
              void semanticSearch.runSearch(query);
            }}
          >
            <label className="search-box">
              <Search size={17} />
              <input
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Describe a shot, topic, quote, or filename"
                value={query}
              />
            </label>
            <div className="search-scopes" aria-label="Search scope">
              {(["all", "visual", "spoken"] as const).map((scope) => (
                <button
                  aria-pressed={semanticSearch.scope === scope}
                  key={scope}
                  onClick={() => semanticSearch.setScope(scope)}
                  type="button"
                >
                  {scope}
                </button>
              ))}
            </div>
            <button
              className="primary-button compact semantic-search-button"
              disabled={
                semanticSearch.searching ||
                semanticSearch.status?.state !== "complete" ||
                query.trim().length < 2
              }
              type="submit"
            >
              {semanticSearch.searching ? "Searching…" : "Search"}
            </button>
          </form>
          <div className="catalog-filters">
            <button
              className="secondary-button compact"
              disabled={
                semanticSearch.indexing ||
                ["pending", "running"].includes(semanticSearch.status?.state ?? "")
              }
              onClick={() => {
                setSearchIndexDialogOpen(true);
                void semanticSearch.prepareIndex();
              }}
              type="button"
            >
              {semanticSearch.indexing ? <LoaderCircle className="spin" size={14} /> : null}
              {semanticSearch.status?.state === "complete" ? "Update search index" :
                semanticSearch.status?.state === "failed" ? "Retry search index" :
                  ["pending", "running"].includes(semanticSearch.status?.state ?? "")
                    ? "Indexing…"
                    : "Build search index"}
            </button>
            <SelectMenu
              ariaLabel="Visual category"
              className="catalog-filter-menu"
              onChange={setVisualFilter}
              options={visualFilterOptions}
              value={visualFilter}
            />
            <span>
              {visibleClips.length} of {clips.length} clips
            </span>
          </div>
        </div>

        {semanticSearch.status && ["pending", "running"].includes(semanticSearch.status.state) && (
          <div className="search-index-progress">
            <span>
              {semanticSearch.status.mode === "fast"
                ? `Fast indexing: ${semanticSearch.status.embeddedRecords} of ${semanticSearch.status.totalRecords} search records embedded`
                : `Batch indexing: ${semanticSearch.status.completedBatches} of ${semanticSearch.status.totalBatches} embedding batches complete`}
            </span>
            <div className="search-index-progress-actions">
              <strong>
                {semanticSearch.status.mode === "fast" && semanticSearch.status.totalRecords > 0
                ? Math.round(
                    semanticSearch.status.embeddedRecords /
                    semanticSearch.status.totalRecords * 100,
                  )
                : semanticSearch.status.totalBatches > 0
                ? Math.round(
                    semanticSearch.status.completedBatches /
                    semanticSearch.status.totalBatches * 100,
                  )
                  : 0}%
              </strong>
              <button
                className="secondary-button compact"
                disabled={semanticSearch.canceling}
                onClick={() => void semanticSearch.cancelIndex()}
                type="button"
              >
                {semanticSearch.canceling
                  ? <LoaderCircle className="spin" size={13} />
                  : <X size={13} />}
                Cancel indexing
              </button>
            </div>
            <progress
              max={Math.max(
                semanticSearch.status.mode === "fast"
                  ? semanticSearch.status.totalRecords
                  : semanticSearch.status.totalBatches,
                1,
              )}
              value={semanticSearch.status.mode === "fast"
                ? semanticSearch.status.embeddedRecords
                : semanticSearch.status.completedBatches}
            />
          </div>
        )}
        {semanticSearch.status?.state === "failed" && (
          <div className="search-index-error">{semanticSearch.status.error}</div>
        )}
        {semanticSearch.submittedQuery && semanticSearch.submittedQuery === query.trim() && (
          <SearchResults
            clips={clips}
            framesByClip={visualFramesByClip}
            projectId={project.id}
            query={semanticSearch.submittedQuery}
            results={semanticSearch.results}
          />
        )}

        {loading ? (
          <LoadingBlock label="Reading the local catalog…" />
        ) : clips.length === 0 ? (
          <div className="table-empty">
            <span className="empty-icon">
              <FolderOpen size={25} />
            </span>
            <h2>Attach the first footage folder</h2>
            <p>
              Docubase reads MOV, MP4, M4V, and ProRes-in-MOV files in place.
              No source video is uploaded or copied.
            </p>
            <button
              className="primary-button"
              disabled={!isTauri}
              onClick={() => void importFolder()}
            >
              <FolderOpen size={17} />
              Choose folder
            </button>
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Clip</th>
                  <th>Duration</th>
                  <th>Video</th>
                  <th>Resolution</th>
                  <th>
                    <div className="date-sort-header">
                      <SelectMenu
                        ariaLabel="Date used to sort clips"
                        className="date-sort-menu"
                        onChange={setDateSortField}
                        options={dateSortOptions}
                        value={dateSortField}
                      />
                      <button
                        aria-label={`Sort selected date ${
                          dateSortDirection === "ascending" ? "descending" : "ascending"
                        }`}
                        className="sort-header"
                        onClick={() =>
                          setDateSortDirection((current) =>
                            current === "ascending" ? "descending" : "ascending",
                          )
                        }
                        title={dateSortDirection === "ascending" ? "Oldest first" : "Newest first"}
                        type="button"
                      >
                        {dateSortDirection === "ascending" ? (
                          <ArrowUp size={13} />
                        ) : (
                          <ArrowDown size={13} />
                        )}
                      </button>
                    </div>
                  </th>
                  <th>Size</th>
                  <th>Status</th>
                  <th>Visual</th>
                  <th>Transcript</th>
                  <th>
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleClips.map((clip) => {
                  const source = posterSource(clip.posterPath);
                  const transcriptSummary = transcriptSummaries[clip.id];
                  const transcriptMatch = transcriptMatches.find(
                    (match) => match.clipId === clip.id,
                  );
                  const transcriptOpen = expandedTranscriptIds.has(clip.id);
                  const visualSummary = visualSummaries[clip.id];
                  const clipVisualMetadata = visualMetadata[clip.id];
                  const visualOpen = expandedVisualIds.has(clip.id);
                  return (
                    <Fragment key={clip.id}>
                    <tr>
                      <td>
                        <div className="clip-cell">
                          <div className="poster">
                            {source ? (
                              <img alt="" src={source} />
                            ) : (
                              <Film size={19} />
                            )}
                          </div>
                          <div>
                            <strong title={clip.filename}>
                              {clip.filename}
                            </strong>
                            <span>
                              {clip.portableDirectoryHint || "Footage"}
                            </span>
                            {transcriptMatch && (
                              <span className="spoken-match">
                                “{transcriptMatch.text}”
                              </span>
                            )}
                            {clipVisualMetadata?.description && (
                              <span className="visual-description">
                                {clipVisualMetadata.description}
                              </span>
                            )}
                            {(clipVisualMetadata?.tags.length ?? 0) > 0 && (
                              <span className="mini-tags">
                                {clipVisualMetadata?.tags
                                  .slice(0, 3)
                                  .map((tag) => (
                                    <em key={tag}>{tag}</em>
                                  ))}
                              </span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td>{formatDuration(clip.durationMs)}</td>
                      <td>
                        <strong>{clip.videoCodec}</strong>
                        <span className="table-subline">
                          {formatFrameRate(
                            clip.frameRate.numerator,
                            clip.frameRate.denominator,
                          )}{" "}
                          fps
                        </span>
                      </td>
                      <td>
                        {clip.width > 0
                          ? `${clip.width} × ${clip.height}`
                          : "—"}
                      </td>
                      <td className="catalog-date">
                        {formatRecordedAt(clipDate(clip, dateSortField))}
                      </td>
                      <td>{formatBytes(clip.fileSizeBytes)}</td>
                      <td>
                        <span
                          className={`status-pill ${clip.stage}`}
                          title={clip.error ?? undefined}
                        >
                          {clip.stage === "failed" && (
                            <TriangleAlert size={12} />
                          )}
                          {clip.stage}
                        </span>
                      </td>
                      <td>
                        <button
                          className={`transcript-toggle visual ${
                            clipVisualMetadata?.visualStage ??
                            visualSummary?.stage ??
                            "not_started"
                          }`}
                          onClick={() => void toggleVisual(clip.id)}
                        >
                          <Images size={13} />
                          {clipVisualMetadata?.visualStage === "complete"
                            ? `${visualSummary?.totalFrames ?? "Visual"} frames`
                            : visualSummary?.stage === "failed"
                              ? "Retry"
                              : visualSummary?.totalFrames
                                ? `${visualSummary.totalFrames} ready`
                                : "Not started"}
                          {visualOpen ? (
                            <ChevronUp size={13} />
                          ) : (
                            <ChevronDown size={13} />
                          )}
                        </button>
                      </td>
                      <td>
                        <button
                          className={`transcript-toggle ${
                            transcriptSummary?.stage ?? "not_started"
                          }`}
                          disabled={!clip.hasAudio}
                          onClick={() => void toggleTranscript(clip.id)}
                        >
                          <FileText size={13} />
                          {!clip.hasAudio
                            ? "No audio"
                            : transcriptSummary?.stage === "complete"
                              ? `${transcriptSummary.utteranceCount} lines`
                              : transcriptSummary?.stage === "failed"
                                ? "Retry"
                                : transcriptSummary?.stage === "not_started" ||
                                    !transcriptSummary
                                  ? "Not started"
                                  : transcriptSummary.stage}
                          {transcriptOpen ? (
                            <ChevronUp size={13} />
                          ) : (
                            <ChevronDown size={13} />
                          )}
                        </button>
                      </td>
                      <td>
                        <button
                          className="row-action"
                          onClick={() =>
                            void revealClip(project.id, clip.id).catch(
                              (error) =>
                                setNotice({
                                  tone: "error",
                                  message: readableError(error),
                                }),
                            )
                          }
                        >
                          Reveal
                        </button>
                      </td>
                    </tr>
                    {visualOpen && (
                      <tr className="visual-row">
                        <td colSpan={10}>
                          <VisualPanel
                            clip={clip}
                            frames={visualFramesByClip[clip.id] ?? []}
                            moments={visualMomentsByClip[clip.id] ?? []}
                            metadata={clipVisualMetadata}
                            onPrepareImages={() =>
                              void prepareVisualImages([clip])
                            }
                            onAnalyze={() =>
                              void prepareVisualAnalysis([clip])
                            }
                            onSaveClip={saveClipVisualMetadata}
                            onSaveMoment={saveMomentMetadata}
                            summary={visualSummary}
                            transcriptReady={
                              !clip.hasAudio || transcriptSummary?.stage === "complete"
                            }
                            working={visualWorkingClipId === clip.id}
                          />
                        </td>
                      </tr>
                    )}
                    {transcriptOpen && (
                      <tr className="transcript-row">
                        <td colSpan={10}>
                          <TranscriptPanel
                            clip={clip}
                            loading={loadingTranscriptIds.has(clip.id)}
                            onTranscribe={() => void startClipTranscription(clip)}
                            query={query}
                            summary={transcriptSummary}
                            transcribing={transcribingClipId === clip.id}
                            utterances={utterancesByClip[clip.id] ?? []}
                          />
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {transcriptionDialogOpen && (
        <TranscriptionDialog
          clipCount={remainingTranscribableClips.length}
          durationMs={remainingTranscribableClips.reduce(
            (sum, clip) => sum + clip.durationMs,
            0,
          )}
          onCancel={() => setTranscriptionDialogOpen(false)}
          onConfirm={() => void transcribeRemainingClips()}
        />
      )}
      {visualPreflight && (
        <VisualAnalysisDialog
          analysisMode={analysisMode}
          clipCount={visualPreflight.clips.length}
          estimatedCostUsd={estimateVisualAnalysisCost(
            visualPreflight.frameCount,
            visualPreflight.momentCount,
            visualPreflight.estimatedInputTextTokens,
            visualPreflight.transcriptRequestCount,
            visualPreflight.summaryFrameCount,
            visualPreflight.summaryInputTextTokens,
            analysisMode,
          )}
          frameCount={visualPreflight.frameCount}
          momentCount={visualPreflight.momentCount}
          onCancel={() => setVisualPreflight(null)}
          onAnalysisModeChange={setAnalysisMode}
          onConfirm={() => void analyzePreparedVisuals()}
          retainedBytes={visualPreflight.retainedBytes}
        />
      )}
      {searchIndexDialogOpen && (
        <SearchIndexDialog
          estimate={semanticSearch.estimate}
          estimating={semanticSearch.estimating}
          mode={semanticSearch.indexMode}
          onCancel={() => setSearchIndexDialogOpen(false)}
          onConfirm={() => {
            setSearchIndexDialogOpen(false);
            void semanticSearch.buildIndex(semanticSearch.indexMode);
          }}
          onModeChange={semanticSearch.setIndexMode}
        />
      )}
    </main>
  );
}
