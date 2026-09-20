import { LoaderCircle, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Notice } from "../../components/SharedUi";
import type {
  AnalysisMode,
  ClipManifest,
  ClipVisualMetadata,
  ClipVisualSummary,
  VisualFrame,
  VisualMoment,
} from "../../lib/contracts";
import { formatBytes } from "../../lib/format";
import { posterSource } from "../../lib/native";
import { formatUsd } from "../../lib/presentation";
import { clipTimecode } from "../../lib/timecode";

export function VisualPanel({
  clip,
  summary,
  frames,
  moments,
  metadata,
  transcriptReady,
  working,
  onPrepareImages,
  onAnalyze,
  onSaveClip,
  onSaveMoment,
}: {
  clip: ClipManifest;
  summary: ClipVisualSummary | undefined;
  frames: VisualFrame[];
  moments: VisualMoment[];
  metadata: ClipVisualMetadata | undefined;
  transcriptReady: boolean;
  working: boolean;
  onPrepareImages: () => void;
  onAnalyze: () => void;
  onSaveClip: (
    clipId: string,
    description: string,
    tags: string[],
  ) => Promise<void>;
  onSaveMoment: (
    moment: VisualMoment,
    description: string,
    tags: string[],
  ) => Promise<void>;
}) {
  const [editingClip, setEditingClip] = useState(false);
  const [savingClip, setSavingClip] = useState(false);
  const [clipDescription, setClipDescription] = useState(
    metadata?.description ?? "",
  );
  const [clipTags, setClipTags] = useState(
    metadata?.tags.join(", ") ?? "",
  );

  useEffect(() => {
    setClipDescription(metadata?.description ?? "");
    setClipTags(metadata?.tags.join(", ") ?? "");
  }, [metadata]);

  async function saveClip() {
    setSavingClip(true);
    try {
      await onSaveClip(
        clip.id,
        clipDescription,
        clipTags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      );
      setEditingClip(false);
    } finally {
      setSavingClip(false);
    }
  }

  return (
    <div className="visual-panel">
      <div className="visual-heading">
        <div>
          <span className="eyebrow">Evidence-backed visual index</span>
          <h3>{clip.filename}</h3>
          <p>
            Docubase first prepares the complete transcript and local 384px
            images separately. AI then analyzes both sources and merges them
            into one concise clip description and tag set.
          </p>
        </div>
        {(!["batched", "analyzing", "complete"].includes(
          summary?.stage ?? "",
        ) || metadata?.analysisVersion !== "4") && (
          <button
            className="primary-button compact"
            disabled={working || (frames.length > 0 && !transcriptReady)}
            onClick={frames.length > 0 ? onAnalyze : onPrepareImages}
          >
            {working ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Sparkles size={16} />
            )}
            {frames.length === 0
              ? "2. Generate clip images"
              : !transcriptReady
                ? "Transcribe this clip first"
                : metadata?.visualStage === "complete" &&
                    metadata.analysisVersion !== "4"
                  ? "3. Rebuild clip analysis"
                  : "3. Analyze transcript + images"}
          </button>
        )}
      </div>
      {metadata?.visualStage === "complete" && (
        <section className="clip-summary-editor">
          <div>
            <span className="eyebrow">General clip summary</span>
            {editingClip ? (
              <>
                <textarea
                  maxLength={3_000}
                  onChange={(event) =>
                    setClipDescription(event.target.value)
                  }
                  rows={3}
                  value={clipDescription}
                />
                <input
                  onChange={(event) => setClipTags(event.target.value)}
                  placeholder="tags, separated by commas"
                  value={clipTags}
                />
              </>
            ) : (
              <>
                <p>{metadata.description || "No clip description yet."}</p>
                <div className="tag-list">
                  {metadata.tags.map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>
                {metadata.analysisVersion === "4" && (
                  <details className="analysis-provenance">
                    <summary>How this summary was built</summary>
                    <div>
                      <strong>From transcript</strong>
                      <p>
                        {metadata.generatedTranscriptDescription ||
                          "No substantive spoken subject was found."}
                      </p>
                      <div className="tag-list">
                        {metadata.generatedTranscriptTags.map((tag) => (
                          <span key={`transcript-${tag}`}>{tag}</span>
                        ))}
                      </div>
                    </div>
                    <div>
                      <strong>From visuals</strong>
                      <p>
                        {metadata.generatedVisualDescription ||
                          "No visual description was generated."}
                      </p>
                      <div className="tag-list">
                        {metadata.generatedVisualTags.map((tag) => (
                          <span key={`visual-${tag}`}>{tag}</span>
                        ))}
                      </div>
                    </div>
                  </details>
                )}
              </>
            )}
          </div>
          <div className="moment-actions">
            {editingClip ? (
              <>
                <button
                  className="text-button"
                  onClick={() => setEditingClip(false)}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  className="primary-button compact"
                  disabled={savingClip}
                  onClick={() => void saveClip()}
                  type="button"
                >
                  {savingClip && (
                    <LoaderCircle className="spin" size={14} />
                  )}
                  Save clip summary
                </button>
              </>
            ) : (
              <button
                className="text-button"
                onClick={() => setEditingClip(true)}
                type="button"
              >
                Edit clip description and tags
              </button>
            )}
          </div>
        </section>
      )}
      {summary?.error && <Notice tone="error">{summary.error}</Notice>}
      {frames.length === 0 ? (
        <div className="transcript-empty">
          Prepare this clip to create a free local visual timeline before
          approving any Gemini cost.
        </div>
      ) : (
        <>
          <div className="frame-strip">
            {frames.map((frame) => (
              <figure key={frame.id}>
                <img alt="" src={posterSource(frame.localPath) ?? undefined} />
                <figcaption>
                  {clipTimecode(
                    frame.timestampMs,
                    clip.frameRate,
                    clip.startTimecodeFrames,
                  )}
                </figcaption>
              </figure>
            ))}
          </div>
          <div className="visual-stats">
            <span>{frames.length} retained frames</span>
            <span>
              {new Set(frames.map((frame) => frame.momentId)).size} moments
            </span>
            <span>
              {formatBytes(
                frames.reduce(
                  (sum, frame) => sum + frame.fileSizeBytes,
                  0,
                ),
              )}
            </span>
            <span>{summary?.stage ?? "ready"}</span>
            {metadata?.analysisRoute && (
              <span>
                {metadata.analysisRoute === "stableInterview"
                  ? "Interview · one analyzed frame"
                  : "Full visual sequence"}
              </span>
            )}
          </div>
        </>
      )}
      {moments.length > 0 && (
        <div className="moment-grid">
          {moments.map((moment) => (
            <VisualMomentCard
              clip={clip}
              frames={frames}
              key={moment.id}
              moment={moment}
              onSave={onSaveMoment}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function VisualMomentCard({
  clip,
  moment,
  frames,
  onSave,
}: {
  clip: ClipManifest;
  moment: VisualMoment;
  frames: VisualFrame[];
  onSave: (
    moment: VisualMoment,
    description: string,
    tags: string[],
  ) => Promise<void>;
}) {
  const [description, setDescription] = useState(moment.description);
  const [tags, setTags] = useState(moment.tags.join(", "));
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const evidenceFrames = frames.filter((frame) => frame.momentId === moment.id);

  useEffect(() => {
    setDescription(moment.description);
    setTags(moment.tags.join(", "));
  }, [moment]);

  async function save() {
    setSaving(true);
    try {
      await onSave(
        moment,
        description,
        tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      );
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className="moment-card">
      {evidenceFrames.length > 0 && (
        <div className="moment-evidence">
          {evidenceFrames.map((frame) => (
            <figure key={frame.id}>
              <img alt="" src={posterSource(frame.localPath) ?? undefined} />
              <figcaption>
                {clipTimecode(
                  frame.timestampMs,
                  clip.frameRate,
                  clip.startTimecodeFrames,
                )}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      <div className="moment-card-body">
        <div className="moment-time">
          <strong>
            {clipTimecode(
              moment.startMs,
              clip.frameRate,
              clip.startTimecodeFrames,
            )}
          </strong>
          <span className={`status-pill ${moment.stage}`}>{moment.stage}</span>
        </div>
        {editing ? (
          <>
            <textarea
              maxLength={1_000}
              onChange={(event) => setDescription(event.target.value)}
              rows={4}
              value={description}
            />
            <input
              onChange={(event) => setTags(event.target.value)}
              placeholder="tags, separated by commas"
              value={tags}
            />
            <div className="moment-actions">
              <button
                className="text-button"
                onClick={() => setEditing(false)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="primary-button compact"
                disabled={saving}
                onClick={() => void save()}
                type="button"
              >
                {saving && <LoaderCircle className="spin" size={14} />}
                Save
              </button>
            </div>
          </>
        ) : (
          <>
            <p>
              {moment.description ||
                (moment.stage === "failed"
                  ? moment.error || "Visual analysis failed."
                  : moment.stage === "complete"
                    ? "No description generated."
                    : "Waiting for Gemini Batch analysis.")}
            </p>
            <div className="tag-list">
              {moment.tags.map((tag) => (
                <span key={tag}>{tag}</span>
              ))}
            </div>
            {moment.facets && (
              <dl className="facet-list">
                <div>
                  <dt>Type</dt>
                  <dd>{moment.facets.contentType}</dd>
                </div>
                {moment.facets.speechState !== "unknown" && (
                  <div>
                    <dt>Speech</dt>
                    <dd>{moment.facets.speechState}</dd>
                  </div>
                )}
                {moment.facets.actions.length > 0 && (
                  <div>
                    <dt>Action</dt>
                    <dd>{moment.facets.actions.join(", ")}</dd>
                  </div>
                )}
              </dl>
            )}
            {moment.stage === "complete" && (
              <button
                className="text-button moment-edit"
                onClick={() => setEditing(true)}
                type="button"
              >
                Edit description and tags
              </button>
            )}
          </>
        )}
      </div>
    </article>
  );
}

export function VisualAnalysisDialog({
  clipCount,
  frameCount,
  momentCount,
  retainedBytes,
  estimatedCostUsd,
  analysisMode,
  onAnalysisModeChange,
  onCancel,
  onConfirm,
}: {
  clipCount: number;
  frameCount: number;
  momentCount: number;
  retainedBytes: number;
  estimatedCostUsd: number;
  analysisMode: AnalysisMode;
  onAnalysisModeChange: (mode: AnalysisMode) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section
        aria-label="Confirm visual analysis"
        className="modal-card visual-dialog"
      >
        <div>
          <span className="eyebrow">Transcript + visual analysis</span>
          <h2>Analyze clips from both sources?</h2>
          <p>
            Complete transcripts and local image extraction are ready for {" "}
            {clipCount} clip{clipCount === 1 ? "" : "s"}. Original video will
            remain on this Mac.
          </p>
        </div>
        <fieldset className="analysis-mode-picker">
          <legend>Processing mode</legend>
          <label className={analysisMode === "batch" ? "selected" : ""}>
            <input
              checked={analysisMode === "batch"}
              name="analysis-mode"
              onChange={() => onAnalysisModeChange("batch")}
              type="radio"
            />
            <span>
              <strong>Batch (default)</strong>
              <small>Lowest cost; usually completes later.</small>
            </span>
          </label>
          <label className={analysisMode === "fast" ? "selected" : ""}>
            <input
              checked={analysisMode === "fast"}
              name="analysis-mode"
              onChange={() => onAnalysisModeChange("fast")}
              type="radio"
            />
            <span>
              <strong>Fast mode</strong>
              <small>Standard requests; keep Docubase open for faster completion at about 2× the API cost.</small>
            </span>
          </label>
        </fieldset>
        <div className="cost-callout">
          <div>
            <span>
              Estimated Gemini {analysisMode === "fast" ? "Fast" : "Batch"} cost
            </span>
            <strong>{formatUsd(estimatedCostUsd)}</strong>
          </div>
          <p>
            This estimate covers the complete {clipCount.toLocaleString()}-clip run,
            including up to {frameCount.toLocaleString()} retained
            JPEGs ({formatBytes(retainedBytes)}) and {momentCount.toLocaleString()} visual
            moments. The transcript and images are analyzed as separate evidence
            sources, then merged. Each clip first uses one image to identify a
            stable interview; interviews stop there instead of uploading or
            analyzing additional images. Temporary retries reuse the same job IDs
            and do not intentionally create duplicate billable work.
          </p>
        </div>
        <div className="provider-settings">
          <span>Model</span>
          <strong>Gemini 3.5 Flash-Lite</strong>
          <span>Image ceiling</span>
          <strong>384 px / 100 KB</strong>
          <span>Processing</span>
          <strong>
            {analysisMode === "fast" ? "Standard (fast)" : "Batch (economy)"}, minimal thinking
          </strong>
          <span>Evidence</span>
          <strong>Complete transcript + selected images</strong>
        </div>
        <div className="modal-actions">
          <button className="secondary-button" onClick={onCancel} type="button">
            Keep local only
          </button>
          <button className="primary-button" onClick={onConfirm} type="button">
            <Sparkles size={17} />
            Analyze transcript and images
          </button>
        </div>
      </section>
    </div>
  );
}
