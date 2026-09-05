import { AudioLines, ChevronDown, FileText, LoaderCircle } from "lucide-react";
import { LoadingBlock, Notice } from "../../components/SharedUi";
import type {
  ClipManifest,
  ClipTranscriptSummary,
  TranscriptUtterance,
} from "../../lib/contracts";
import { formatDuration } from "../../lib/format";
import { formatUsd } from "../../lib/presentation";
import { clipTimecode } from "../../lib/timecode";
import { estimateTranscriptionCost } from "../../lib/transcription";

export function TranscriptPanel({
  clip,
  summary,
  utterances,
  loading,
  transcribing,
  query,
  onTranscribe,
}: {
  clip: ClipManifest;
  summary: ClipTranscriptSummary | undefined;
  utterances: TranscriptUtterance[];
  loading: boolean;
  transcribing: boolean;
  query: string;
  onTranscribe: () => void;
}) {
  const estimatedCost = estimateTranscriptionCost(clip.durationMs);
  return (
    <div className="transcript-panel">
      <div className="transcript-heading">
        <div>
          <span className="eyebrow">Timestamped dialogue</span>
          <h3>{clip.filename}</h3>
          <p>
            Nova-3 English, smart formatting, word timestamps, and speaker
            diarization. Estimated maximum: {formatUsd(estimatedCost)}.
          </p>
        </div>
        {clip.hasAudio && summary?.stage !== "complete" && (
          <button
            className="primary-button compact"
            disabled={transcribing}
            onClick={onTranscribe}
          >
            {transcribing ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <AudioLines size={16} />
            )}
            {summary?.stage === "failed" ? "Retry transcript" : "Transcribe clip"}
          </button>
        )}
      </div>
      {summary?.error && <Notice tone="error">{summary.error}</Notice>}
      {loading ? (
        <LoadingBlock label="Reading the local transcript…" />
      ) : summary?.stage === "complete" && utterances.length === 0 ? (
        <div className="transcript-empty">
          No speech was detected in this clip.
        </div>
      ) : utterances.length === 0 ? (
        <div className="transcript-empty">
          Transcribe this clip to search and review its spoken content.
        </div>
      ) : (
        <div className="utterance-list">
          {utterances.map((utterance) => (
            <div
              className={`utterance ${
                query.trim() &&
                utterance.text
                  .toLocaleLowerCase()
                  .includes(query.trim().toLocaleLowerCase())
                  ? "match"
                  : ""
              }`}
              key={utterance.id}
            >
              <div className="utterance-meta">
                <strong>
                  {utterance.speaker === null
                    ? "Speaker"
                    : `Speaker ${utterance.speaker + 1}`}
                </strong>
                <span>
                  {clipTimecode(
                    utterance.startMs,
                    clip.frameRate,
                    clip.startTimecodeFrames,
                  )}
                </span>
              </div>
              <p>{utterance.text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function TranscriptionDialog({
  clipCount,
  durationMs,
  estimatedCostUsd,
  onCancel,
  onConfirm,
}: {
  clipCount: number;
  durationMs: number;
  estimatedCostUsd: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section
        aria-label="Confirm transcription"
        className="modal-card transcription-dialog"
      >
        <div>
          <span className="eyebrow">Cost-controlled transcription</span>
          <h2>Transcribe remaining footage?</h2>
          <p>
            Docubase will process {clipCount} clip{clipCount === 1 ? "" : "s"} (
            {formatDuration(durationMs)}) sequentially.
          </p>
        </div>
        <div className="cost-callout">
          <div>
            <span>Estimated provider cost</span>
            <strong>{formatUsd(estimatedCostUsd)}</strong>
          </div>
          <p>
            Audio is converted locally to temporary 48 kbps mono chunks, sent
            directly to Deepgram, and deleted after the transcript is safely
            stored. Original video is never uploaded.
          </p>
        </div>
        <div className="provider-settings">
          <span>Model</span>
          <strong>Nova-3 English</strong>
          <span>Chunk size</span>
          <strong>30 minutes</strong>
          <span>Diarization</span>
          <strong>Latest batch model</strong>
        </div>
        <div className="modal-actions">
          <button className="secondary-button" onClick={onCancel} type="button">
            Cancel
          </button>
          <button className="primary-button" onClick={onConfirm} type="button">
            <AudioLines size={17} />
            Start transcription
          </button>
        </div>
      </section>
    </div>
  );
}
