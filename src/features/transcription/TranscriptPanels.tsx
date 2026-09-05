import { AudioLines, ChevronDown, FileText, LoaderCircle } from "lucide-react";
import { LoadingBlock, Notice } from "../../components/SharedUi";
import type {
  ClipManifest,
  ClipTranscriptSummary,
  TranscriptUtterance,
} from "../../lib/contracts";
import { formatDuration } from "../../lib/format";
import { clipTimecode } from "../../lib/timecode";

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
  return (
    <div className="transcript-panel">
      <div className="transcript-heading">
        <div>
          <span className="eyebrow">Timestamped dialogue</span>
          <h3>{clip.filename}</h3>
          <p>
            Apple Speech runs on this Mac and adds searchable text with word
            timestamps. Audio is never sent to a transcription provider.
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
                    ? "Dialogue"
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
  onCancel,
  onConfirm,
}: {
  clipCount: number;
  durationMs: number;
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
          <span className="eyebrow">On-device transcription</span>
          <h2>Transcribe remaining footage?</h2>
          <p>
            Docubase will process {clipCount} clip{clipCount === 1 ? "" : "s"} (
            {formatDuration(durationMs)}) sequentially.
          </p>
        </div>
        <div className="cost-callout">
          <div>
            <span>Transcription provider cost</span>
            <strong>$0.00</strong>
          </div>
          <p>
            Audio is converted to temporary local chunks and transcribed by
            Apple Speech on this Mac. The chunks are deleted after the text is
            safely stored; neither audio nor original video is uploaded.
          </p>
        </div>
        <div className="provider-settings">
          <span>Model</span>
          <strong>Apple SpeechTranscriber</strong>
          <span>Processing</span>
          <strong>On this Mac</strong>
          <span>Chunk size</span>
          <strong>30 minutes</strong>
          <span>Language</span>
          <strong>English (US)</strong>
        </div>
        <p className="modal-note">
          The first run may take longer while macOS downloads Apple&apos;s speech
          model. Apple Speech does not currently add speaker labels.
        </p>
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
