use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) database_path: PathBuf,
    pub(crate) cache_directory: PathBuf,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FrameRate {
    pub(crate) numerator: i64,
    pub(crate) denominator: i64,
    pub(crate) drop_frame: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClipManifest {
    pub(crate) id: String,
    pub(crate) project_id: String,
    pub(crate) fingerprint: String,
    pub(crate) filename: String,
    pub(crate) file_extension: String,
    pub(crate) portable_directory_hint: String,
    pub(crate) duration_ms: i64,
    pub(crate) frame_rate: FrameRate,
    pub(crate) start_timecode_frames: Option<i64>,
    pub(crate) recorded_at: Option<String>,
    pub(crate) source_modified_at: Option<String>,
    pub(crate) width: i64,
    pub(crate) height: i64,
    pub(crate) video_codec: String,
    pub(crate) audio_codec: Option<String>,
    pub(crate) has_audio: bool,
    pub(crate) file_size_bytes: i64,
    pub(crate) poster_path: Option<String>,
    pub(crate) stage: String,
    pub(crate) error: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalProject {
    pub(crate) id: String,
    pub(crate) owner_id: String,
    pub(crate) name: String,
    pub(crate) summary: String,
    pub(crate) brief: String,
    pub(crate) known_names: Vec<String>,
    pub(crate) terminology: Vec<String>,
    pub(crate) context_resource_names: Vec<String>,
    pub(crate) context_text: String,
    pub(crate) budget_per_footage_hour: f64,
    pub(crate) member_ids: Vec<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) clip_count: i64,
    pub(crate) total_duration_ms: i64,
    pub(crate) thumbnail_path: Option<String>,
    pub(crate) context_resource_paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerInspection {
    pub(crate) duration_ms: i64,
    pub(crate) frame_rate_numerator: i64,
    pub(crate) frame_rate_denominator: i64,
    pub(crate) drop_frame: bool,
    pub(crate) start_timecode_frames: Option<i64>,
    pub(crate) recorded_at: Option<String>,
    pub(crate) width: i64,
    pub(crate) height: i64,
    pub(crate) video_codec: String,
    pub(crate) audio_codec: Option<String>,
    pub(crate) has_audio: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportProgress {
    pub(crate) completed: usize,
    pub(crate) total: usize,
    pub(crate) current_filename: String,
}

pub(crate) const TRANSCRIPTION_CHUNK_DURATION_MS: i64 = 30 * 60 * 1_000;
pub(crate) const VISUAL_MOMENT_DURATION_MS: i64 = 15 * 1_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerAudioExtraction {
    pub(crate) duration_ms: i64,
    pub(crate) file_size_bytes: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerSpeechTranscription {
    pub(crate) locale: String,
    pub(crate) model: String,
    pub(crate) model_version: String,
    pub(crate) segments: Vec<WorkerSpeechSegment>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerSpeechSegment {
    pub(crate) text: String,
    pub(crate) start_ms: i64,
    pub(crate) end_ms: i64,
    pub(crate) confidence: f64,
    pub(crate) words: Vec<WorkerSpeechWord>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerSpeechWord {
    pub(crate) text: String,
    pub(crate) start_ms: i64,
    pub(crate) end_ms: i64,
    pub(crate) confidence: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerRetainedFrame {
    pub(crate) filename: String,
    pub(crate) timestamp_ms: i64,
    pub(crate) width: i64,
    pub(crate) height: i64,
    pub(crate) file_size_bytes: i64,
    pub(crate) change_score: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerFrameExtraction {
    pub(crate) sampled_frame_count: i64,
    pub(crate) retained_frames: Vec<WorkerRetainedFrame>,
    pub(crate) significant_change_count: i64,
    pub(crate) significant_change_ratio: f64,
    pub(crate) median_change_score: f64,
    pub(crate) maximum_change_score: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VisualFrame {
    pub(crate) id: String,
    pub(crate) project_id: String,
    pub(crate) clip_id: String,
    pub(crate) moment_id: String,
    pub(crate) timestamp_ms: i64,
    pub(crate) local_path: String,
    pub(crate) width: i64,
    pub(crate) height: i64,
    pub(crate) file_size_bytes: i64,
    pub(crate) change_score: f64,
    pub(crate) stage: String,
    pub(crate) storage_path: Option<String>,
    pub(crate) error: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClipVisualSummary {
    pub(crate) clip_id: String,
    pub(crate) stage: String,
    pub(crate) total_frames: i64,
    pub(crate) uploaded_frames: i64,
    pub(crate) moment_count: i64,
    pub(crate) completed_moments: i64,
    pub(crate) significant_change_count: i64,
    pub(crate) significant_change_ratio: f64,
    pub(crate) median_change_score: f64,
    pub(crate) maximum_change_score: f64,
    pub(crate) description: String,
    pub(crate) tags: Vec<String>,
    pub(crate) estimated_cost_usd: f64,
    pub(crate) error: Option<String>,
    pub(crate) updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VisualAnalysisQueueItem {
    pub(crate) run_id: String,
    pub(crate) project_id: String,
    pub(crate) clip_id: String,
    pub(crate) position: i64,
    pub(crate) state: String,
    pub(crate) attempt_count: i64,
    pub(crate) job_id: Option<String>,
    pub(crate) error: Option<String>,
    pub(crate) updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VisualAnalysisRun {
    pub(crate) id: String,
    pub(crate) project_id: String,
    pub(crate) analysis_mode: String,
    pub(crate) state: String,
    pub(crate) estimated_cost_usd: f64,
    pub(crate) total_count: i64,
    pub(crate) queued_count: i64,
    pub(crate) retrying_count: i64,
    pub(crate) submitted_count: i64,
    pub(crate) completed_count: i64,
    pub(crate) failed_count: i64,
    pub(crate) skipped_count: i64,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) items: Vec<VisualAnalysisQueueItem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranscriptionChunk {
    pub(crate) id: String,
    pub(crate) project_id: String,
    pub(crate) clip_id: String,
    pub(crate) chunk_index: i64,
    pub(crate) start_ms: i64,
    pub(crate) duration_ms: i64,
    pub(crate) stage: String,
    pub(crate) attempt_count: i64,
    pub(crate) transcription_id: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) model_version: Option<String>,
    pub(crate) language: Option<String>,
    pub(crate) error: Option<String>,
    pub(crate) updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClipTranscriptSummary {
    pub(crate) clip_id: String,
    pub(crate) stage: String,
    pub(crate) total_chunks: i64,
    pub(crate) completed_chunks: i64,
    pub(crate) utterance_count: i64,
    pub(crate) error: Option<String>,
    pub(crate) updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranscriptWord {
    pub(crate) text: String,
    pub(crate) punctuated_text: String,
    pub(crate) start_ms: i64,
    pub(crate) end_ms: i64,
    pub(crate) confidence: f64,
    pub(crate) speaker: Option<i64>,
    pub(crate) speaker_confidence: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranscriptUtterance {
    pub(crate) id: String,
    pub(crate) project_id: String,
    pub(crate) clip_id: String,
    pub(crate) chunk_index: i64,
    pub(crate) start_ms: i64,
    pub(crate) end_ms: i64,
    pub(crate) speaker: Option<i64>,
    pub(crate) confidence: f64,
    pub(crate) text: String,
    pub(crate) words: Vec<TranscriptWord>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranscriptChunkDocument {
    pub(crate) id: String,
    pub(crate) project_id: String,
    pub(crate) clip_id: String,
    pub(crate) chunk_index: i64,
    pub(crate) start_ms: i64,
    pub(crate) duration_ms: i64,
    pub(crate) request_id: String,
    pub(crate) model: String,
    pub(crate) model_version: Option<String>,
    pub(crate) language: String,
    pub(crate) utterance_count: i64,
    pub(crate) word_count: i64,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranscriptChunkPayload {
    pub(crate) chunk: TranscriptChunkDocument,
    pub(crate) utterances: Vec<TranscriptUtterance>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranscriptSearchMatch {
    pub(crate) clip_id: String,
    pub(crate) utterance_id: String,
    pub(crate) start_ms: i64,
    pub(crate) end_ms: i64,
    pub(crate) speaker: Option<i64>,
    pub(crate) text: String,
}
