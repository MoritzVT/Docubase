use chrono::Utc;
use reqwest::header::CONTENT_TYPE;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::ShellExt;
use walkdir::WalkDir;

#[derive(Clone)]
struct AppState {
    database_path: PathBuf,
    cache_directory: PathBuf,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrameRate {
    numerator: i64,
    denominator: i64,
    drop_frame: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClipManifest {
    id: String,
    project_id: String,
    fingerprint: String,
    filename: String,
    file_extension: String,
    portable_directory_hint: String,
    duration_ms: i64,
    frame_rate: FrameRate,
    start_timecode_frames: Option<i64>,
    width: i64,
    height: i64,
    video_codec: String,
    audio_codec: Option<String>,
    has_audio: bool,
    file_size_bytes: i64,
    poster_path: Option<String>,
    stage: String,
    error: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalProject {
    id: String,
    owner_id: String,
    name: String,
    brief: String,
    known_names: Vec<String>,
    terminology: Vec<String>,
    budget_per_footage_hour: f64,
    member_ids: Vec<String>,
    created_at: String,
    updated_at: String,
    clip_count: i64,
    total_duration_ms: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerInspection {
    duration_ms: i64,
    frame_rate_numerator: i64,
    frame_rate_denominator: i64,
    drop_frame: bool,
    start_timecode_frames: Option<i64>,
    width: i64,
    height: i64,
    video_codec: String,
    audio_codec: Option<String>,
    has_audio: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportProgress {
    completed: usize,
    total: usize,
    current_filename: String,
}

const TRANSCRIPTION_CHUNK_DURATION_MS: i64 = 30 * 60 * 1_000;
const DEEPGRAM_API_BASE: &str = "https://api.deepgram.com";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerAudioExtraction {
    duration_ms: i64,
    file_size_bytes: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptionChunk {
    id: String,
    project_id: String,
    clip_id: String,
    chunk_index: i64,
    start_ms: i64,
    duration_ms: i64,
    stage: String,
    attempt_count: i64,
    reservation_id: Option<String>,
    deepgram_request_id: Option<String>,
    model: Option<String>,
    model_version: Option<String>,
    estimated_cost_usd: f64,
    error: Option<String>,
    updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipTranscriptSummary {
    clip_id: String,
    stage: String,
    total_chunks: i64,
    completed_chunks: i64,
    utterance_count: i64,
    estimated_cost_usd: f64,
    error: Option<String>,
    updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptWord {
    text: String,
    punctuated_text: String,
    start_ms: i64,
    end_ms: i64,
    confidence: f64,
    speaker: Option<i64>,
    speaker_confidence: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptUtterance {
    id: String,
    project_id: String,
    clip_id: String,
    chunk_index: i64,
    start_ms: i64,
    end_ms: i64,
    speaker: Option<i64>,
    confidence: f64,
    text: String,
    words: Vec<TranscriptWord>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptChunkDocument {
    id: String,
    project_id: String,
    clip_id: String,
    chunk_index: i64,
    start_ms: i64,
    duration_ms: i64,
    request_id: String,
    model: String,
    model_version: Option<String>,
    language: String,
    utterance_count: i64,
    word_count: i64,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptChunkPayload {
    chunk: TranscriptChunkDocument,
    utterances: Vec<TranscriptUtterance>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptSearchMatch {
    clip_id: String,
    utterance_id: String,
    start_ms: i64,
    end_ms: i64,
    speaker: Option<i64>,
    text: String,
}

#[derive(Debug, Deserialize)]
struct DeepgramResponse {
    metadata: DeepgramMetadata,
    #[serde(default)]
    results: DeepgramResults,
}

#[derive(Debug, Deserialize)]
struct DeepgramMetadata {
    request_id: String,
    #[serde(default)]
    models: Vec<String>,
    #[serde(default)]
    model_info: HashMap<String, DeepgramModelInfo>,
}

#[derive(Debug, Deserialize)]
struct DeepgramModelInfo {
    name: Option<String>,
    version: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct DeepgramResults {
    #[serde(default)]
    channels: Vec<DeepgramChannel>,
    #[serde(default)]
    utterances: Vec<DeepgramUtterance>,
}

#[derive(Debug, Deserialize)]
struct DeepgramChannel {
    #[serde(default)]
    alternatives: Vec<DeepgramAlternative>,
}

#[derive(Debug, Deserialize)]
struct DeepgramAlternative {
    #[serde(default)]
    transcript: String,
    #[serde(default)]
    confidence: f64,
    #[serde(default)]
    words: Vec<DeepgramWord>,
}

#[derive(Debug, Deserialize)]
struct DeepgramUtterance {
    id: Option<String>,
    start: f64,
    end: f64,
    #[serde(default)]
    confidence: f64,
    #[serde(default)]
    transcript: String,
    speaker: Option<i64>,
    #[serde(default)]
    words: Vec<DeepgramWord>,
}

#[derive(Debug, Clone, Deserialize)]
struct DeepgramWord {
    #[serde(default)]
    word: String,
    punctuated_word: Option<String>,
    start: f64,
    end: f64,
    #[serde(default)]
    confidence: f64,
    speaker: Option<i64>,
    speaker_confidence: Option<f64>,
}

fn initialize_database(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(string_error)?;
    }
    let connection = Connection::open(path).map_err(string_error)?;
    connection
        .execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                owner_id TEXT NOT NULL,
                name TEXT NOT NULL,
                brief TEXT NOT NULL,
                known_names_json TEXT NOT NULL,
                terminology_json TEXT NOT NULL,
                budget_per_footage_hour REAL NOT NULL,
                member_ids_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS clips (
                id TEXT NOT NULL,
                project_id TEXT NOT NULL,
                fingerprint TEXT NOT NULL,
                filename TEXT NOT NULL,
                file_extension TEXT NOT NULL,
                source_path TEXT NOT NULL,
                portable_directory_hint TEXT NOT NULL,
                duration_ms INTEGER NOT NULL,
                frame_rate_numerator INTEGER NOT NULL,
                frame_rate_denominator INTEGER NOT NULL,
                drop_frame INTEGER NOT NULL,
                start_timecode_frames INTEGER,
                width INTEGER NOT NULL,
                height INTEGER NOT NULL,
                video_codec TEXT NOT NULL,
                audio_codec TEXT,
                has_audio INTEGER NOT NULL,
                file_size_bytes INTEGER NOT NULL,
                poster_path TEXT,
                stage TEXT NOT NULL,
                error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (project_id, id),
                UNIQUE (project_id, fingerprint),
                FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS clips_project_filename
            ON clips(project_id, filename COLLATE NOCASE);

            CREATE TABLE IF NOT EXISTS transcription_jobs (
                project_id TEXT NOT NULL,
                clip_id TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                start_ms INTEGER NOT NULL,
                duration_ms INTEGER NOT NULL,
                audio_path TEXT,
                stage TEXT NOT NULL,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                reservation_id TEXT,
                deepgram_request_id TEXT,
                model TEXT,
                model_version TEXT,
                estimated_cost_usd REAL NOT NULL DEFAULT 0,
                error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (project_id, clip_id, chunk_index),
                FOREIGN KEY (project_id, clip_id)
                    REFERENCES clips(project_id, id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS transcript_utterances (
                id TEXT NOT NULL,
                project_id TEXT NOT NULL,
                clip_id TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                start_ms INTEGER NOT NULL,
                end_ms INTEGER NOT NULL,
                speaker INTEGER,
                confidence REAL NOT NULL,
                text TEXT NOT NULL,
                words_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (project_id, clip_id, id),
                FOREIGN KEY (project_id, clip_id, chunk_index)
                    REFERENCES transcription_jobs(project_id, clip_id, chunk_index)
                    ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS transcript_utterances_clip_time
            ON transcript_utterances(project_id, clip_id, start_ms);

            CREATE INDEX IF NOT EXISTS transcript_utterances_project_text
            ON transcript_utterances(project_id, text COLLATE NOCASE);
            ",
        )
        .map_err(string_error)
}

fn connection(state: &AppState) -> Result<Connection, String> {
    let connection = Connection::open(&state.database_path).map_err(string_error)?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(string_error)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(string_error)?;
    Ok(connection)
}

#[tauri::command]
fn upsert_local_project(state: State<'_, AppState>, project: LocalProject) -> Result<(), String> {
    let connection = connection(&state)?;
    connection
        .execute(
            "
            INSERT INTO projects (
                id, owner_id, name, brief, known_names_json,
                terminology_json, budget_per_footage_hour, member_ids_json,
                created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            ON CONFLICT(id) DO UPDATE SET
                owner_id = excluded.owner_id,
                name = excluded.name,
                brief = excluded.brief,
                known_names_json = excluded.known_names_json,
                terminology_json = excluded.terminology_json,
                budget_per_footage_hour = excluded.budget_per_footage_hour,
                member_ids_json = excluded.member_ids_json,
                updated_at = excluded.updated_at
            ",
            params![
                project.id,
                project.owner_id,
                project.name,
                project.brief,
                serde_json::to_string(&project.known_names).map_err(string_error)?,
                serde_json::to_string(&project.terminology).map_err(string_error)?,
                project.budget_per_footage_hour,
                serde_json::to_string(&project.member_ids).map_err(string_error)?,
                project.created_at,
                project.updated_at,
            ],
        )
        .map_err(string_error)?;
    Ok(())
}

#[tauri::command]
fn list_local_projects(state: State<'_, AppState>) -> Result<Vec<LocalProject>, String> {
    let connection = connection(&state)?;
    let mut statement = connection
        .prepare(
            "
            SELECT
                p.id, p.owner_id, p.name, p.brief, p.known_names_json,
                p.terminology_json, p.budget_per_footage_hour,
                p.member_ids_json, p.created_at, p.updated_at,
                COUNT(c.id), COALESCE(SUM(c.duration_ms), 0)
            FROM projects p
            LEFT JOIN clips c ON c.project_id = p.id
            GROUP BY p.id
            ORDER BY p.updated_at DESC
            ",
        )
        .map_err(string_error)?;

    let projects = statement
        .query_map([], |row| {
            Ok(LocalProject {
                id: row.get(0)?,
                owner_id: row.get(1)?,
                name: row.get(2)?,
                brief: row.get(3)?,
                known_names: json_array(row.get::<_, String>(4)?),
                terminology: json_array(row.get::<_, String>(5)?),
                budget_per_footage_hour: row.get(6)?,
                member_ids: json_array(row.get::<_, String>(7)?),
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
                clip_count: row.get(10)?,
                total_duration_ms: row.get(11)?,
            })
        })
        .map_err(string_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(string_error)?;

    Ok(projects)
}

#[tauri::command]
fn list_local_clips(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<ClipManifest>, String> {
    let connection = connection(&state)?;
    let mut statement = connection
        .prepare(
            "
            SELECT
                id, project_id, fingerprint, filename, file_extension,
                portable_directory_hint, duration_ms, frame_rate_numerator,
                frame_rate_denominator, drop_frame, start_timecode_frames,
                width, height, video_codec, audio_codec, has_audio,
                file_size_bytes, poster_path, stage, error, created_at, updated_at
            FROM clips
            WHERE project_id = ?1
            ORDER BY filename COLLATE NOCASE
            ",
        )
        .map_err(string_error)?;
    let clips = statement
        .query_map(params![project_id], clip_from_row)
        .map_err(string_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(string_error)?;
    Ok(clips)
}

#[tauri::command]
async fn scan_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    folder_path: String,
) -> Result<Vec<ClipManifest>, String> {
    let directory = PathBuf::from(&folder_path);
    if !directory.is_dir() {
        return Err("Choose a readable folder containing video files.".to_string());
    }

    let files: Vec<PathBuf> = WalkDir::new(&directory)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .filter(|path| is_supported_video(path))
        .collect();

    let mut manifests = Vec::with_capacity(files.len());
    for (index, media_path) in files.iter().enumerate() {
        let filename = media_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("Untitled clip")
            .to_string();
        let _ = app.emit(
            "import-progress",
            ImportProgress {
                completed: index,
                total: files.len(),
                current_filename: filename.clone(),
            },
        );

        let fingerprint = sampled_fingerprint(media_path)?;
        if let Some(cached) = existing_clip(&state, &project_id, &fingerprint)? {
            let poster_is_cached = cached
                .poster_path
                .as_deref()
                .is_some_and(|path| Path::new(path).is_file());
            if cached.stage == "ready" && poster_is_cached {
                update_clip_location(&state, &project_id, &fingerprint, media_path)?;
                manifests.push(ClipManifest {
                    filename,
                    portable_directory_hint: directory_hint(media_path),
                    updated_at: now(),
                    ..cached
                });
                continue;
            }
        }

        let poster_path = state
            .cache_directory
            .join("posters")
            .join(format!("{fingerprint}.jpg"));
        let created_at = now();
        let metadata = std::fs::metadata(media_path).map_err(string_error)?;
        let inspection = inspect_media(&app, media_path, &poster_path).await;

        let manifest = match inspection {
            Ok(inspection) => ClipManifest {
                id: fingerprint.clone(),
                project_id: project_id.clone(),
                fingerprint,
                filename,
                file_extension: file_extension(media_path),
                portable_directory_hint: directory_hint(media_path),
                duration_ms: inspection.duration_ms,
                frame_rate: FrameRate {
                    numerator: inspection.frame_rate_numerator,
                    denominator: inspection.frame_rate_denominator,
                    drop_frame: inspection.drop_frame,
                },
                start_timecode_frames: inspection.start_timecode_frames.map(|frames| frames.max(0)),
                width: inspection.width,
                height: inspection.height,
                video_codec: inspection.video_codec,
                audio_codec: inspection.audio_codec,
                has_audio: inspection.has_audio,
                file_size_bytes: metadata.len() as i64,
                poster_path: Some(poster_path.to_string_lossy().into_owned()),
                stage: "ready".to_string(),
                error: None,
                created_at: created_at.clone(),
                updated_at: created_at,
            },
            Err(error) => ClipManifest {
                id: fingerprint.clone(),
                project_id: project_id.clone(),
                fingerprint,
                filename,
                file_extension: file_extension(media_path),
                portable_directory_hint: directory_hint(media_path),
                duration_ms: 0,
                frame_rate: FrameRate {
                    numerator: 25,
                    denominator: 1,
                    drop_frame: false,
                },
                start_timecode_frames: None,
                width: 0,
                height: 0,
                video_codec: "unknown".to_string(),
                audio_codec: None,
                has_audio: false,
                file_size_bytes: metadata.len() as i64,
                poster_path: None,
                stage: "failed".to_string(),
                error: Some(error),
                created_at: created_at.clone(),
                updated_at: created_at,
            },
        };

        upsert_clip(&state, &manifest, media_path)?;
        manifests.push(manifest);
    }

    let _ = app.emit(
        "import-progress",
        ImportProgress {
            completed: files.len(),
            total: files.len(),
            current_filename: String::new(),
        },
    );
    Ok(manifests)
}

#[tauri::command]
fn relink_folder(
    state: State<'_, AppState>,
    project_id: String,
    folder_path: String,
) -> Result<usize, String> {
    let directory = PathBuf::from(folder_path);
    if !directory.is_dir() {
        return Err("Choose a readable folder containing the moved files.".to_string());
    }

    let connection = connection(&state)?;
    let mut relinked = 0;
    for entry in WalkDir::new(directory)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .filter(|entry| is_supported_video(entry.path()))
    {
        let fingerprint = sampled_fingerprint(entry.path())?;
        relinked += connection
            .execute(
                "
                UPDATE clips
                SET source_path = ?1, portable_directory_hint = ?2, updated_at = ?3
                WHERE project_id = ?4 AND fingerprint = ?5
                ",
                params![
                    entry.path().to_string_lossy(),
                    directory_hint(entry.path()),
                    now(),
                    project_id,
                    fingerprint,
                ],
            )
            .map_err(string_error)?;
    }
    Ok(relinked)
}

#[tauri::command]
fn reveal_clip(
    state: State<'_, AppState>,
    project_id: String,
    clip_id: String,
) -> Result<(), String> {
    let connection = connection(&state)?;
    let source_path: Option<String> = connection
        .query_row(
            "SELECT source_path FROM clips WHERE project_id = ?1 AND id = ?2",
            params![project_id, clip_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(string_error)?;
    let source_path = source_path.ok_or_else(|| "Clip not found locally.".to_string())?;
    if !Path::new(&source_path).exists() {
        return Err("The source file has moved. Use Relink folder first.".to_string());
    }
    let status = Command::new("/usr/bin/open")
        .args(["-R", &source_path])
        .status()
        .map_err(string_error)?;
    if status.success() {
        Ok(())
    } else {
        Err("Finder could not reveal the source file.".to_string())
    }
}

#[tauri::command]
fn prepare_transcription(
    state: State<'_, AppState>,
    project_id: String,
    clip_id: String,
) -> Result<Vec<TranscriptionChunk>, String> {
    let mut connection = connection(&state)?;
    let clip: Option<(i64, bool)> = connection
        .query_row(
            "SELECT duration_ms, has_audio FROM clips WHERE project_id = ?1 AND id = ?2",
            params![project_id, clip_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(string_error)?;
    let (duration_ms, has_audio) =
        clip.ok_or_else(|| "Clip not found in the local catalog.".to_string())?;
    if !has_audio {
        return Err("This clip does not contain an audio track.".to_string());
    }
    if duration_ms <= 0 {
        return Err("This clip does not have a transcribable duration.".to_string());
    }

    let timestamp = now();
    let transaction = connection.transaction().map_err(string_error)?;
    for (chunk_index, (start_ms, chunk_duration_ms)) in transcription_chunk_ranges(duration_ms)
        .into_iter()
        .enumerate()
    {
        let chunk_index = chunk_index as i64;
        let audio_path = audio_chunk_path(&state, &project_id, &clip_id, chunk_index);
        transaction
            .execute(
                "
                INSERT OR IGNORE INTO transcription_jobs (
                    project_id, clip_id, chunk_index, start_ms, duration_ms,
                    audio_path, stage, attempt_count, estimated_cost_usd,
                    created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'queued', 0, 0, ?7, ?7)
                ",
                params![
                    project_id,
                    clip_id,
                    chunk_index,
                    start_ms,
                    chunk_duration_ms,
                    audio_path.to_string_lossy(),
                    timestamp,
                ],
            )
            .map_err(string_error)?;
    }
    transaction.commit().map_err(string_error)?;
    list_transcription_chunks_inner(&state, &project_id, &clip_id)
}

#[tauri::command]
fn list_transcription_chunks(
    state: State<'_, AppState>,
    project_id: String,
    clip_id: String,
) -> Result<Vec<TranscriptionChunk>, String> {
    list_transcription_chunks_inner(&state, &project_id, &clip_id)
}

#[tauri::command]
fn list_transcript_summaries(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<ClipTranscriptSummary>, String> {
    let connection = connection(&state)?;
    let mut statement = connection
        .prepare(
            "
            SELECT
                c.id,
                COUNT(j.chunk_index),
                COALESCE(SUM(CASE WHEN j.stage = 'complete' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN j.stage = 'failed' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN j.stage = 'syncing' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN j.stage = 'transcribing' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN j.stage = 'extracting' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN j.stage = 'ready' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN j.stage = 'queued' THEN 1 ELSE 0 END), 0),
                (
                    SELECT COUNT(*)
                    FROM transcript_utterances u
                    WHERE u.project_id = c.project_id AND u.clip_id = c.id
                ),
                COALESCE(SUM(j.estimated_cost_usd), 0),
                MAX(j.error),
                MAX(j.updated_at)
            FROM clips c
            LEFT JOIN transcription_jobs j
                ON j.project_id = c.project_id AND j.clip_id = c.id
            WHERE c.project_id = ?1
            GROUP BY c.project_id, c.id
            ORDER BY c.filename COLLATE NOCASE
            ",
        )
        .map_err(string_error)?;

    let summaries = statement
        .query_map(params![project_id], |row| {
            let total_chunks: i64 = row.get(1)?;
            let completed_chunks: i64 = row.get(2)?;
            let failed_chunks: i64 = row.get(3)?;
            let syncing_chunks: i64 = row.get(4)?;
            let transcribing_chunks: i64 = row.get(5)?;
            let extracting_chunks: i64 = row.get(6)?;
            let ready_chunks: i64 = row.get(7)?;
            let queued_chunks: i64 = row.get(8)?;
            let stage = if total_chunks == 0 {
                "not_started"
            } else if completed_chunks == total_chunks {
                "complete"
            } else if failed_chunks > 0 {
                "failed"
            } else if syncing_chunks > 0 {
                "syncing"
            } else if transcribing_chunks > 0 {
                "transcribing"
            } else if extracting_chunks > 0 {
                "extracting"
            } else if ready_chunks > 0 {
                "ready"
            } else if queued_chunks > 0 {
                "queued"
            } else {
                "not_started"
            };
            Ok(ClipTranscriptSummary {
                clip_id: row.get(0)?,
                stage: stage.to_string(),
                total_chunks,
                completed_chunks,
                utterance_count: row.get(9)?,
                estimated_cost_usd: row.get(10)?,
                error: row.get(11)?,
                updated_at: row.get(12)?,
            })
        })
        .map_err(string_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(string_error)?;
    Ok(summaries)
}

#[tauri::command]
fn list_transcript_utterances(
    state: State<'_, AppState>,
    project_id: String,
    clip_id: String,
) -> Result<Vec<TranscriptUtterance>, String> {
    list_transcript_utterances_inner(&state, &project_id, &clip_id, None)
}

#[tauri::command]
fn search_transcripts(
    state: State<'_, AppState>,
    project_id: String,
    query: String,
) -> Result<Vec<TranscriptSearchMatch>, String> {
    let normalized = query.trim();
    if normalized.len() < 2 {
        return Ok(Vec::new());
    }
    let escaped = normalized
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let pattern = format!("%{escaped}%");
    let connection = connection(&state)?;
    let mut statement = connection
        .prepare(
            "
            SELECT clip_id, id, start_ms, end_ms, speaker, text
            FROM transcript_utterances
            WHERE project_id = ?1
                AND text LIKE ?2 ESCAPE '\\' COLLATE NOCASE
            ORDER BY start_ms
            LIMIT 100
            ",
        )
        .map_err(string_error)?;
    let matches = statement
        .query_map(params![project_id, pattern], |row| {
            Ok(TranscriptSearchMatch {
                clip_id: row.get(0)?,
                utterance_id: row.get(1)?,
                start_ms: row.get(2)?,
                end_ms: row.get(3)?,
                speaker: row.get(4)?,
                text: row.get(5)?,
            })
        })
        .map_err(string_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(string_error)?;
    Ok(matches)
}

#[tauri::command]
async fn extract_transcription_chunk(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    clip_id: String,
    chunk_index: i64,
) -> Result<TranscriptionChunk, String> {
    let chunk = transcription_chunk(&state, &project_id, &clip_id, chunk_index)?
        .ok_or_else(|| "Prepare the clip for transcription first.".to_string())?;
    if matches!(chunk.stage.as_str(), "complete" | "syncing") {
        return Ok(chunk);
    }

    let (source_path, audio_path): (String, String) = {
        let connection = connection(&state)?;
        connection
            .query_row(
                "
                SELECT c.source_path, j.audio_path
                FROM transcription_jobs j
                JOIN clips c
                    ON c.project_id = j.project_id AND c.id = j.clip_id
                WHERE j.project_id = ?1 AND j.clip_id = ?2 AND j.chunk_index = ?3
                ",
                params![project_id, clip_id, chunk_index],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(string_error)?
    };
    if !Path::new(&source_path).is_file() {
        return Err("The source file has moved. Use Relink folder first.".to_string());
    }

    if std::fs::metadata(&audio_path).is_ok_and(|metadata| metadata.len() > 0) {
        update_transcription_job(&state, &project_id, &clip_id, chunk_index, "ready", None)?;
        return transcription_chunk(&state, &project_id, &clip_id, chunk_index)?
            .ok_or_else(|| "Transcription chunk disappeared.".to_string());
    }

    update_transcription_job(
        &state,
        &project_id,
        &clip_id,
        chunk_index,
        "extracting",
        None,
    )?;
    let extraction = extract_audio(
        &app,
        Path::new(&source_path),
        Path::new(&audio_path),
        chunk.start_ms,
        chunk.duration_ms,
    )
    .await;
    match extraction {
        Ok(extraction) if extraction.file_size_bytes > 0 => {
            let connection = connection(&state)?;
            connection
                .execute(
                    "
                    UPDATE transcription_jobs
                    SET duration_ms = ?1, stage = 'ready',
                        attempt_count = attempt_count + 1,
                        error = NULL, updated_at = ?2
                    WHERE project_id = ?3 AND clip_id = ?4 AND chunk_index = ?5
                    ",
                    params![
                        extraction.duration_ms,
                        now(),
                        project_id,
                        clip_id,
                        chunk_index,
                    ],
                )
                .map_err(string_error)?;
        }
        Ok(_) => {
            let message = "The extracted audio chunk was empty.".to_string();
            update_transcription_job(
                &state,
                &project_id,
                &clip_id,
                chunk_index,
                "failed",
                Some(&message),
            )?;
            return Err(message);
        }
        Err(error) => {
            update_transcription_job(
                &state,
                &project_id,
                &clip_id,
                chunk_index,
                "failed",
                Some(&error),
            )?;
            return Err(error);
        }
    }
    transcription_chunk(&state, &project_id, &clip_id, chunk_index)?
        .ok_or_else(|| "Transcription chunk disappeared.".to_string())
}

#[tauri::command]
async fn transcribe_audio_chunk(
    state: State<'_, AppState>,
    project_id: String,
    clip_id: String,
    chunk_index: i64,
    access_token: String,
    reservation_id: String,
    estimated_cost_usd: f64,
) -> Result<TranscriptChunkPayload, String> {
    if access_token.trim().is_empty() {
        return Err("Deepgram access token is missing.".to_string());
    }
    let chunk = transcription_chunk(&state, &project_id, &clip_id, chunk_index)?
        .ok_or_else(|| "Prepare the clip for transcription first.".to_string())?;
    if matches!(chunk.stage.as_str(), "syncing" | "complete") {
        return transcript_chunk_payload_inner(&state, &project_id, &clip_id, chunk_index);
    }

    let audio_path: String = {
        let connection = connection(&state)?;
        connection
            .query_row(
                "
                SELECT audio_path FROM transcription_jobs
                WHERE project_id = ?1 AND clip_id = ?2 AND chunk_index = ?3
                ",
                params![project_id, clip_id, chunk_index],
                |row| row.get(0),
            )
            .map_err(string_error)?
    };
    if !Path::new(&audio_path).is_file() {
        return Err("Extract the audio chunk before transcribing it.".to_string());
    }

    {
        let connection = connection(&state)?;
        connection
            .execute(
                "
                UPDATE transcription_jobs
                SET stage = 'transcribing', reservation_id = ?1,
                    estimated_cost_usd = ?2, error = NULL, updated_at = ?3
                WHERE project_id = ?4 AND clip_id = ?5 AND chunk_index = ?6
                ",
                params![
                    reservation_id,
                    estimated_cost_usd.max(0.0),
                    now(),
                    project_id,
                    clip_id,
                    chunk_index,
                ],
            )
            .map_err(string_error)?;
    }

    let audio = std::fs::read(&audio_path).map_err(string_error)?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(30 * 60))
        .build()
        .map_err(string_error)?;
    let request = client
        .post(format!("{DEEPGRAM_API_BASE}/v1/listen"))
        .bearer_auth(access_token)
        .header(CONTENT_TYPE, "audio/mp4")
        .query(&[
            ("model", "nova-3"),
            ("language", "en"),
            ("smart_format", "true"),
            ("utterances", "true"),
            ("diarize_model", "latest"),
            ("mip_opt_out", "true"),
        ])
        .body(audio)
        .send()
        .await;

    let response = match request {
        Ok(response) => response,
        Err(error) => {
            let message = format!("Deepgram request failed: {error}");
            update_transcription_job(
                &state,
                &project_id,
                &clip_id,
                chunk_index,
                "failed",
                Some(&message),
            )?;
            return Err(message);
        }
    };
    let status = response.status();
    let response_body = match response.bytes().await {
        Ok(body) => body,
        Err(error) => {
            let message = format!("Deepgram response could not be read: {error}");
            update_transcription_job(
                &state,
                &project_id,
                &clip_id,
                chunk_index,
                "failed",
                Some(&message),
            )?;
            return Err(message);
        }
    };
    if !status.is_success() {
        let provider_message = String::from_utf8_lossy(&response_body);
        let message = format!(
            "Deepgram returned {}: {}",
            status.as_u16(),
            provider_message.trim()
        );
        update_transcription_job(
            &state,
            &project_id,
            &clip_id,
            chunk_index,
            "failed",
            Some(&message),
        )?;
        return Err(message);
    }

    let provider_response: DeepgramResponse = match serde_json::from_slice(&response_body) {
        Ok(response) => response,
        Err(error) => {
            let message = format!("Deepgram returned an unreadable transcription: {error}");
            update_transcription_job(
                &state,
                &project_id,
                &clip_id,
                chunk_index,
                "failed",
                Some(&message),
            )?;
            return Err(message);
        }
    };
    let saved = save_deepgram_transcript(
        &state,
        &project_id,
        &clip_id,
        chunk_index,
        provider_response,
    );
    if let Err(error) = &saved {
        let _ = update_transcription_job(
            &state,
            &project_id,
            &clip_id,
            chunk_index,
            "failed",
            Some(error),
        );
    }
    saved
}

#[tauri::command]
fn transcript_chunk_payload(
    state: State<'_, AppState>,
    project_id: String,
    clip_id: String,
    chunk_index: i64,
) -> Result<TranscriptChunkPayload, String> {
    transcript_chunk_payload_inner(&state, &project_id, &clip_id, chunk_index)
}

#[tauri::command]
fn complete_transcription_chunk(
    state: State<'_, AppState>,
    project_id: String,
    clip_id: String,
    chunk_index: i64,
) -> Result<TranscriptionChunk, String> {
    let audio_path: Option<String> = {
        let connection = connection(&state)?;
        connection
            .query_row(
                "
                SELECT audio_path FROM transcription_jobs
                WHERE project_id = ?1 AND clip_id = ?2 AND chunk_index = ?3
                ",
                params![project_id, clip_id, chunk_index],
                |row| row.get(0),
            )
            .optional()
            .map_err(string_error)?
    };
    update_transcription_job(&state, &project_id, &clip_id, chunk_index, "complete", None)?;
    if let Some(path) = audio_path {
        if Path::new(&path).is_file() {
            let _ = std::fs::remove_file(path);
        }
    }
    transcription_chunk(&state, &project_id, &clip_id, chunk_index)?
        .ok_or_else(|| "Transcription chunk disappeared.".to_string())
}

async fn inspect_media(
    app: &AppHandle,
    media_path: &Path,
    poster_path: &Path,
) -> Result<WorkerInspection, String> {
    let output = app
        .shell()
        .sidecar("media-worker")
        .map_err(string_error)?
        .args([
            "inspect",
            "--path",
            &media_path.to_string_lossy(),
            "--thumbnail",
            &poster_path.to_string_lossy(),
        ])
        .output()
        .await
        .map_err(string_error)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if let Ok(worker_error) = serde_json::from_str::<serde_json::Value>(&stderr) {
            if let Some(message) = worker_error.get("error").and_then(|value| value.as_str()) {
                return Err(message.to_string());
            }
        }
        return Err(if stderr.is_empty() {
            "The media worker could not inspect this clip.".to_string()
        } else {
            stderr
        });
    }
    serde_json::from_slice(&output.stdout).map_err(string_error)
}

async fn extract_audio(
    app: &AppHandle,
    media_path: &Path,
    output_path: &Path,
    start_ms: i64,
    duration_ms: i64,
) -> Result<WorkerAudioExtraction, String> {
    let output = app
        .shell()
        .sidecar("media-worker")
        .map_err(string_error)?
        .args([
            "extract-audio",
            "--path",
            &media_path.to_string_lossy(),
            "--output",
            &output_path.to_string_lossy(),
            "--start-ms",
            &start_ms.to_string(),
            "--duration-ms",
            &duration_ms.to_string(),
        ])
        .output()
        .await
        .map_err(string_error)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if let Ok(worker_error) = serde_json::from_str::<serde_json::Value>(&stderr) {
            if let Some(message) = worker_error.get("error").and_then(|value| value.as_str()) {
                return Err(message.to_string());
            }
        }
        return Err(if stderr.is_empty() {
            "The media worker could not extract this audio chunk.".to_string()
        } else {
            stderr
        });
    }
    serde_json::from_slice(&output.stdout).map_err(string_error)
}

fn list_transcription_chunks_inner(
    state: &AppState,
    project_id: &str,
    clip_id: &str,
) -> Result<Vec<TranscriptionChunk>, String> {
    let connection = connection(state)?;
    let mut statement = connection
        .prepare(
            "
            SELECT
                project_id, clip_id, chunk_index, start_ms, duration_ms,
                stage, attempt_count, reservation_id, deepgram_request_id,
                model, model_version, estimated_cost_usd, error, updated_at
            FROM transcription_jobs
            WHERE project_id = ?1 AND clip_id = ?2
            ORDER BY chunk_index
            ",
        )
        .map_err(string_error)?;
    let chunks = statement
        .query_map(params![project_id, clip_id], transcription_chunk_from_row)
        .map_err(string_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(string_error)?;
    Ok(chunks)
}

fn transcription_chunk(
    state: &AppState,
    project_id: &str,
    clip_id: &str,
    chunk_index: i64,
) -> Result<Option<TranscriptionChunk>, String> {
    let connection = connection(state)?;
    connection
        .query_row(
            "
            SELECT
                project_id, clip_id, chunk_index, start_ms, duration_ms,
                stage, attempt_count, reservation_id, deepgram_request_id,
                model, model_version, estimated_cost_usd, error, updated_at
            FROM transcription_jobs
            WHERE project_id = ?1 AND clip_id = ?2 AND chunk_index = ?3
            ",
            params![project_id, clip_id, chunk_index],
            transcription_chunk_from_row,
        )
        .optional()
        .map_err(string_error)
}

fn transcription_chunk_from_row(row: &Row<'_>) -> rusqlite::Result<TranscriptionChunk> {
    let clip_id: String = row.get(1)?;
    let chunk_index: i64 = row.get(2)?;
    Ok(TranscriptionChunk {
        id: format!("chunk-{chunk_index:04}"),
        project_id: row.get(0)?,
        clip_id,
        chunk_index,
        start_ms: row.get(3)?,
        duration_ms: row.get(4)?,
        stage: row.get(5)?,
        attempt_count: row.get(6)?,
        reservation_id: row.get(7)?,
        deepgram_request_id: row.get(8)?,
        model: row.get(9)?,
        model_version: row.get(10)?,
        estimated_cost_usd: row.get(11)?,
        error: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

fn update_transcription_job(
    state: &AppState,
    project_id: &str,
    clip_id: &str,
    chunk_index: i64,
    stage: &str,
    error: Option<&str>,
) -> Result<(), String> {
    let connection = connection(state)?;
    let changed = connection
        .execute(
            "
            UPDATE transcription_jobs
            SET stage = ?1, error = ?2, updated_at = ?3
            WHERE project_id = ?4 AND clip_id = ?5 AND chunk_index = ?6
            ",
            params![stage, error, now(), project_id, clip_id, chunk_index],
        )
        .map_err(string_error)?;
    if changed == 0 {
        return Err("Transcription chunk not found.".to_string());
    }
    Ok(())
}

fn list_transcript_utterances_inner(
    state: &AppState,
    project_id: &str,
    clip_id: &str,
    chunk_index: Option<i64>,
) -> Result<Vec<TranscriptUtterance>, String> {
    let connection = connection(state)?;
    let sql = if chunk_index.is_some() {
        "
        SELECT
            id, project_id, clip_id, chunk_index, start_ms, end_ms,
            speaker, confidence, text, words_json, created_at, updated_at
        FROM transcript_utterances
        WHERE project_id = ?1 AND clip_id = ?2 AND chunk_index = ?3
        ORDER BY start_ms
        "
    } else {
        "
        SELECT
            id, project_id, clip_id, chunk_index, start_ms, end_ms,
            speaker, confidence, text, words_json, created_at, updated_at
        FROM transcript_utterances
        WHERE project_id = ?1 AND clip_id = ?2
        ORDER BY start_ms
        "
    };
    let mut statement = connection.prepare(sql).map_err(string_error)?;
    let rows = if let Some(index) = chunk_index {
        statement
            .query_map(params![project_id, clip_id, index], utterance_from_row)
            .map_err(string_error)?
    } else {
        statement
            .query_map(params![project_id, clip_id], utterance_from_row)
            .map_err(string_error)?
    };
    rows.collect::<Result<Vec<_>, _>>().map_err(string_error)
}

fn utterance_from_row(row: &Row<'_>) -> rusqlite::Result<TranscriptUtterance> {
    let words_json: String = row.get(9)?;
    Ok(TranscriptUtterance {
        id: row.get(0)?,
        project_id: row.get(1)?,
        clip_id: row.get(2)?,
        chunk_index: row.get(3)?,
        start_ms: row.get(4)?,
        end_ms: row.get(5)?,
        speaker: row.get(6)?,
        confidence: row.get(7)?,
        text: row.get(8)?,
        words: serde_json::from_str(&words_json).unwrap_or_default(),
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn transcript_chunk_payload_inner(
    state: &AppState,
    project_id: &str,
    clip_id: &str,
    chunk_index: i64,
) -> Result<TranscriptChunkPayload, String> {
    let chunk = transcription_chunk(state, project_id, clip_id, chunk_index)?
        .ok_or_else(|| "Transcription chunk not found.".to_string())?;
    let request_id = chunk
        .deepgram_request_id
        .clone()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "This chunk does not have a saved Deepgram response.".to_string())?;
    let utterances =
        list_transcript_utterances_inner(state, project_id, clip_id, Some(chunk_index))?;
    let word_count = utterances
        .iter()
        .map(|utterance| utterance.words.len() as i64)
        .sum();
    Ok(TranscriptChunkPayload {
        chunk: TranscriptChunkDocument {
            id: chunk.id,
            project_id: chunk.project_id,
            clip_id: chunk.clip_id,
            chunk_index: chunk.chunk_index,
            start_ms: chunk.start_ms,
            duration_ms: chunk.duration_ms,
            request_id,
            model: chunk.model.unwrap_or_else(|| "nova-3".to_string()),
            model_version: chunk.model_version,
            language: "en".to_string(),
            utterance_count: utterances.len() as i64,
            word_count,
            created_at: chunk.updated_at.clone(),
            updated_at: chunk.updated_at,
        },
        utterances,
    })
}

fn save_deepgram_transcript(
    state: &AppState,
    project_id: &str,
    clip_id: &str,
    chunk_index: i64,
    response: DeepgramResponse,
) -> Result<TranscriptChunkPayload, String> {
    let chunk = transcription_chunk(state, project_id, clip_id, chunk_index)?
        .ok_or_else(|| "Transcription chunk not found.".to_string())?;
    let timestamp = now();
    let request_id = response.metadata.request_id;
    let first_model_id = response.metadata.models.first();
    let model_info = first_model_id
        .and_then(|model_id| response.metadata.model_info.get(model_id))
        .or_else(|| response.metadata.model_info.values().next());
    let model = model_info
        .and_then(|info| info.name.clone())
        .unwrap_or_else(|| "nova-3".to_string());
    let model_version = model_info.and_then(|info| info.version.clone());

    let mut provider_utterances = response.results.utterances;
    if provider_utterances.is_empty() {
        if let Some(alternative) = response
            .results
            .channels
            .into_iter()
            .next()
            .and_then(|channel| channel.alternatives.into_iter().next())
        {
            if !alternative.transcript.trim().is_empty() {
                let start = alternative
                    .words
                    .first()
                    .map(|word| word.start)
                    .unwrap_or(0.0);
                let end = alternative
                    .words
                    .last()
                    .map(|word| word.end)
                    .unwrap_or(chunk.duration_ms as f64 / 1_000.0);
                let speaker = alternative.words.first().and_then(|word| word.speaker);
                provider_utterances.push(DeepgramUtterance {
                    id: None,
                    start,
                    end,
                    confidence: alternative.confidence,
                    transcript: alternative.transcript,
                    speaker,
                    words: alternative.words,
                });
            }
        }
    }

    let utterances: Vec<TranscriptUtterance> = provider_utterances
        .into_iter()
        .enumerate()
        .map(|(index, utterance)| {
            let _provider_id = utterance.id;
            let words = utterance
                .words
                .into_iter()
                .map(|word| TranscriptWord {
                    text: word.word.clone(),
                    punctuated_text: word.punctuated_word.unwrap_or(word.word),
                    start_ms: chunk.start_ms + seconds_to_milliseconds(word.start),
                    end_ms: chunk.start_ms + seconds_to_milliseconds(word.end),
                    confidence: bounded_confidence(word.confidence),
                    speaker: word.speaker.filter(|speaker| *speaker >= 0),
                    speaker_confidence: word.speaker_confidence.map(bounded_confidence),
                })
                .collect();
            TranscriptUtterance {
                id: format!("chunk-{chunk_index:04}-utterance-{index:06}"),
                project_id: project_id.to_string(),
                clip_id: clip_id.to_string(),
                chunk_index,
                start_ms: chunk.start_ms + seconds_to_milliseconds(utterance.start),
                end_ms: chunk.start_ms + seconds_to_milliseconds(utterance.end),
                speaker: utterance.speaker.filter(|speaker| *speaker >= 0),
                confidence: bounded_confidence(utterance.confidence),
                text: utterance.transcript,
                words,
                created_at: timestamp.clone(),
                updated_at: timestamp.clone(),
            }
        })
        .collect();

    let mut connection = connection(state)?;
    let transaction = connection.transaction().map_err(string_error)?;
    transaction
        .execute(
            "
            DELETE FROM transcript_utterances
            WHERE project_id = ?1 AND clip_id = ?2 AND chunk_index = ?3
            ",
            params![project_id, clip_id, chunk_index],
        )
        .map_err(string_error)?;
    for utterance in &utterances {
        transaction
            .execute(
                "
                INSERT INTO transcript_utterances (
                    id, project_id, clip_id, chunk_index, start_ms, end_ms,
                    speaker, confidence, text, words_json, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                ",
                params![
                    utterance.id,
                    utterance.project_id,
                    utterance.clip_id,
                    utterance.chunk_index,
                    utterance.start_ms,
                    utterance.end_ms,
                    utterance.speaker,
                    utterance.confidence,
                    utterance.text,
                    serde_json::to_string(&utterance.words).map_err(string_error)?,
                    utterance.created_at,
                    utterance.updated_at,
                ],
            )
            .map_err(string_error)?;
    }
    transaction
        .execute(
            "
            UPDATE transcription_jobs
            SET stage = 'syncing', deepgram_request_id = ?1, model = ?2,
                model_version = ?3, error = NULL, updated_at = ?4
            WHERE project_id = ?5 AND clip_id = ?6 AND chunk_index = ?7
            ",
            params![
                request_id,
                model,
                model_version,
                timestamp,
                project_id,
                clip_id,
                chunk_index,
            ],
        )
        .map_err(string_error)?;
    transaction.commit().map_err(string_error)?;
    transcript_chunk_payload_inner(state, project_id, clip_id, chunk_index)
}

fn audio_chunk_path(
    state: &AppState,
    project_id: &str,
    clip_id: &str,
    chunk_index: i64,
) -> PathBuf {
    let project_hash = Sha256::digest(project_id.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    state
        .cache_directory
        .join("audio")
        .join(&project_hash[..16])
        .join(clip_id)
        .join(format!("chunk-{chunk_index:04}.m4a"))
}

fn seconds_to_milliseconds(seconds: f64) -> i64 {
    if seconds.is_finite() {
        (seconds.max(0.0) * 1_000.0).round() as i64
    } else {
        0
    }
}

fn bounded_confidence(confidence: f64) -> f64 {
    if confidence.is_finite() {
        confidence.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

fn transcription_chunk_ranges(duration_ms: i64) -> Vec<(i64, i64)> {
    if duration_ms <= 0 {
        return Vec::new();
    }
    let mut ranges = Vec::new();
    let mut start_ms = 0;
    while start_ms < duration_ms {
        let chunk_duration_ms = (duration_ms - start_ms).min(TRANSCRIPTION_CHUNK_DURATION_MS);
        ranges.push((start_ms, chunk_duration_ms));
        start_ms += chunk_duration_ms;
    }
    ranges
}

fn existing_clip(
    state: &AppState,
    project_id: &str,
    fingerprint: &str,
) -> Result<Option<ClipManifest>, String> {
    let connection = connection(state)?;
    connection
        .query_row(
            "
            SELECT
                id, project_id, fingerprint, filename, file_extension,
                portable_directory_hint, duration_ms, frame_rate_numerator,
                frame_rate_denominator, drop_frame, start_timecode_frames,
                width, height, video_codec, audio_codec, has_audio,
                file_size_bytes, poster_path, stage, error, created_at, updated_at
            FROM clips
            WHERE project_id = ?1 AND fingerprint = ?2
            ",
            params![project_id, fingerprint],
            clip_from_row,
        )
        .optional()
        .map_err(string_error)
}

fn update_clip_location(
    state: &AppState,
    project_id: &str,
    fingerprint: &str,
    source_path: &Path,
) -> Result<(), String> {
    let connection = connection(state)?;
    connection
        .execute(
            "
            UPDATE clips
            SET source_path = ?1, portable_directory_hint = ?2, updated_at = ?3
            WHERE project_id = ?4 AND fingerprint = ?5
            ",
            params![
                source_path.to_string_lossy(),
                directory_hint(source_path),
                now(),
                project_id,
                fingerprint,
            ],
        )
        .map_err(string_error)?;
    Ok(())
}

fn upsert_clip(state: &AppState, clip: &ClipManifest, source_path: &Path) -> Result<(), String> {
    let connection = connection(state)?;
    connection
        .execute(
            "
            INSERT INTO clips (
                id, project_id, fingerprint, filename, file_extension,
                source_path, portable_directory_hint, duration_ms,
                frame_rate_numerator, frame_rate_denominator, drop_frame,
                start_timecode_frames, width, height, video_codec, audio_codec,
                has_audio, file_size_bytes, poster_path, stage, error,
                created_at, updated_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23
            )
            ON CONFLICT(project_id, id) DO UPDATE SET
                filename = excluded.filename,
                source_path = excluded.source_path,
                portable_directory_hint = excluded.portable_directory_hint,
                duration_ms = excluded.duration_ms,
                frame_rate_numerator = excluded.frame_rate_numerator,
                frame_rate_denominator = excluded.frame_rate_denominator,
                drop_frame = excluded.drop_frame,
                start_timecode_frames = excluded.start_timecode_frames,
                width = excluded.width,
                height = excluded.height,
                video_codec = excluded.video_codec,
                audio_codec = excluded.audio_codec,
                has_audio = excluded.has_audio,
                file_size_bytes = excluded.file_size_bytes,
                poster_path = excluded.poster_path,
                stage = excluded.stage,
                error = excluded.error,
                updated_at = excluded.updated_at
            ",
            params![
                clip.id,
                clip.project_id,
                clip.fingerprint,
                clip.filename,
                clip.file_extension,
                source_path.to_string_lossy(),
                clip.portable_directory_hint,
                clip.duration_ms,
                clip.frame_rate.numerator,
                clip.frame_rate.denominator,
                clip.frame_rate.drop_frame,
                clip.start_timecode_frames,
                clip.width,
                clip.height,
                clip.video_codec,
                clip.audio_codec,
                clip.has_audio,
                clip.file_size_bytes,
                clip.poster_path,
                clip.stage,
                clip.error,
                clip.created_at,
                clip.updated_at,
            ],
        )
        .map_err(string_error)?;
    Ok(())
}

fn clip_from_row(row: &Row<'_>) -> rusqlite::Result<ClipManifest> {
    Ok(ClipManifest {
        id: row.get(0)?,
        project_id: row.get(1)?,
        fingerprint: row.get(2)?,
        filename: row.get(3)?,
        file_extension: row.get(4)?,
        portable_directory_hint: row.get(5)?,
        duration_ms: row.get(6)?,
        frame_rate: FrameRate {
            numerator: row.get(7)?,
            denominator: row.get(8)?,
            drop_frame: row.get(9)?,
        },
        start_timecode_frames: row.get(10)?,
        width: row.get(11)?,
        height: row.get(12)?,
        video_codec: row.get(13)?,
        audio_codec: row.get(14)?,
        has_audio: row.get(15)?,
        file_size_bytes: row.get(16)?,
        poster_path: row.get(17)?,
        stage: row.get(18)?,
        error: row.get(19)?,
        created_at: row.get(20)?,
        updated_at: row.get(21)?,
    })
}

fn sampled_fingerprint(path: &Path) -> Result<String, String> {
    const SAMPLE_SIZE: u64 = 64 * 1_024;
    let mut file = File::open(path).map_err(string_error)?;
    let length = file.metadata().map_err(string_error)?.len();
    let mut hasher = Sha256::new();
    hasher.update(length.to_le_bytes());

    let positions = [
        0,
        length.saturating_sub(SAMPLE_SIZE) / 2,
        length.saturating_sub(SAMPLE_SIZE),
    ];
    let mut buffer = vec![0_u8; SAMPLE_SIZE as usize];
    for position in positions {
        file.seek(SeekFrom::Start(position)).map_err(string_error)?;
        let bytes_read = file.read(&mut buffer).map_err(string_error)?;
        hasher.update(position.to_le_bytes());
        hasher.update(&buffer[..bytes_read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn is_supported_video(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .as_deref(),
        Some("mov" | "mp4" | "m4v")
    )
}

fn file_extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn directory_hint(path: &Path) -> String {
    path.parent()
        .and_then(Path::file_name)
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string()
}

fn json_array(value: String) -> Vec<String> {
    serde_json::from_str(&value).unwrap_or_default()
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn string_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn supported_extensions_are_case_insensitive() {
        assert!(is_supported_video(Path::new("A001.MOV")));
        assert!(is_supported_video(Path::new("interview.mp4")));
        assert!(!is_supported_video(Path::new("notes.txt")));
    }

    #[test]
    fn sampled_fingerprint_is_stable_and_content_sensitive() {
        let directory = tempfile::tempdir().unwrap();
        let first_path = directory.path().join("first.mov");
        let second_path = directory.path().join("second.mov");
        File::create(&first_path)
            .unwrap()
            .write_all(b"same clip")
            .unwrap();
        File::create(&second_path)
            .unwrap()
            .write_all(b"same clip")
            .unwrap();
        assert_eq!(
            sampled_fingerprint(&first_path).unwrap(),
            sampled_fingerprint(&second_path).unwrap()
        );

        File::create(&second_path)
            .unwrap()
            .write_all(b"different clip")
            .unwrap();
        assert_ne!(
            sampled_fingerprint(&first_path).unwrap(),
            sampled_fingerprint(&second_path).unwrap()
        );
    }

    #[test]
    fn transcription_chunks_are_capped_at_thirty_minutes() {
        let ranges = transcription_chunk_ranges(61 * 60 * 1_000);
        assert_eq!(
            ranges,
            vec![
                (0, 30 * 60 * 1_000),
                (30 * 60 * 1_000, 30 * 60 * 1_000),
                (60 * 60 * 1_000, 60 * 1_000),
            ]
        );
    }

    #[test]
    fn deepgram_utterance_response_deserializes() {
        let response: DeepgramResponse = serde_json::from_str(
            r#"{
                "metadata": {
                    "request_id": "request-a",
                    "models": ["model-a"],
                    "model_info": {
                        "model-a": {"name": "nova-3", "version": "2026-05-01"}
                    }
                },
                "results": {
                    "utterances": [{
                        "id": "utterance-a",
                        "start": 0.1,
                        "end": 1.2,
                        "confidence": 0.98,
                        "transcript": "A test.",
                        "speaker": 0,
                        "words": [{
                            "word": "test",
                            "punctuated_word": "test.",
                            "start": 0.5,
                            "end": 1.2,
                            "confidence": 0.99,
                            "speaker": 0,
                            "speaker_confidence": 0.97
                        }]
                    }]
                }
            }"#,
        )
        .unwrap();
        assert_eq!(response.metadata.request_id, "request-a");
        assert_eq!(response.results.utterances.len(), 1);
        assert_eq!(response.results.utterances[0].speaker, Some(0));
    }

    #[test]
    fn database_initialization_adds_transcription_tables() {
        let directory = tempfile::tempdir().unwrap();
        let database_path = directory.path().join("catalog.sqlite");
        initialize_database(&database_path).unwrap();
        let connection = Connection::open(database_path).unwrap();
        for table in ["transcription_jobs", "transcript_utterances"] {
            let exists: i64 = connection
                .query_row(
                    "
                    SELECT COUNT(*) FROM sqlite_master
                    WHERE type = 'table' AND name = ?1
                    ",
                    params![table],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(exists, 1);
        }
    }

    #[test]
    fn saved_transcript_is_resumable_with_absolute_clip_timestamps() {
        let directory = tempfile::tempdir().unwrap();
        let database_path = directory.path().join("catalog.sqlite");
        initialize_database(&database_path).unwrap();
        let state = AppState {
            database_path,
            cache_directory: directory.path().join("cache"),
        };
        let connection = connection(&state).unwrap();
        let timestamp = now();
        connection
            .execute(
                "
                INSERT INTO projects (
                    id, owner_id, name, brief, known_names_json,
                    terminology_json, budget_per_footage_hour, member_ids_json,
                    created_at, updated_at
                ) VALUES ('project-a', 'owner-a', 'Project', '', '[]', '[]',
                    0.5, '[\"owner-a\"]', ?1, ?1)
                ",
                params![timestamp],
            )
            .unwrap();
        connection
            .execute(
                "
                INSERT INTO clips (
                    id, project_id, fingerprint, filename, file_extension,
                    source_path, portable_directory_hint, duration_ms,
                    frame_rate_numerator, frame_rate_denominator, drop_frame,
                    start_timecode_frames, width, height, video_codec,
                    audio_codec, has_audio, file_size_bytes, poster_path, stage,
                    error, created_at, updated_at
                ) VALUES (
                    'clip-a', 'project-a', '0123456789abcdef', 'clip.mov', 'mov',
                    '/tmp/clip.mov', 'tmp', 3600000, 25, 1, 0, NULL, 1920, 1080,
                    'h264', 'aac', 1, 1000, NULL, 'ready', NULL, ?1, ?1
                )
                ",
                params![timestamp],
            )
            .unwrap();
        connection
            .execute(
                "
                INSERT INTO transcription_jobs (
                    project_id, clip_id, chunk_index, start_ms, duration_ms,
                    audio_path, stage, attempt_count, reservation_id,
                    estimated_cost_usd, created_at, updated_at
                ) VALUES (
                    'project-a', 'clip-a', 1, 1800000, 1800000,
                    '/tmp/chunk.m4a', 'transcribing', 1, 'reservation-a',
                    0.204, ?1, ?1
                )
                ",
                params![timestamp],
            )
            .unwrap();
        drop(connection);

        let response: DeepgramResponse = serde_json::from_str(
            r#"{
                "metadata": {
                    "request_id": "request-a",
                    "models": ["model-a"],
                    "model_info": {
                        "model-a": {"name": "nova-3", "version": "2026-05-01"}
                    }
                },
                "results": {
                    "utterances": [{
                        "start": 1.25,
                        "end": 2.5,
                        "confidence": 0.98,
                        "transcript": "Resume from here.",
                        "speaker": 1,
                        "words": [{
                            "word": "Resume",
                            "punctuated_word": "Resume",
                            "start": 1.25,
                            "end": 1.75,
                            "confidence": 0.99,
                            "speaker": 1
                        }]
                    }]
                }
            }"#,
        )
        .unwrap();
        let payload = save_deepgram_transcript(&state, "project-a", "clip-a", 1, response).unwrap();

        assert_eq!(payload.chunk.request_id, "request-a");
        assert_eq!(payload.utterances.len(), 1);
        assert_eq!(payload.utterances[0].start_ms, 1_801_250);
        assert_eq!(payload.utterances[0].words[0].start_ms, 1_801_250);
        let resumed = transcript_chunk_payload_inner(&state, "project-a", "clip-a", 1).unwrap();
        assert_eq!(resumed.chunk.request_id, "request-a");
        assert_eq!(resumed.utterances[0].text, "Resume from here.");
        assert_eq!(
            transcription_chunk(&state, "project-a", "clip-a", 1)
                .unwrap()
                .unwrap()
                .stage,
            "syncing"
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let database_directory = app
                .path()
                .app_data_dir()
                .map_err(|error| Box::<dyn std::error::Error>::from(error))?;
            let cache_directory = app
                .path()
                .app_cache_dir()
                .map_err(|error| Box::<dyn std::error::Error>::from(error))?;
            let database_path = database_directory.join("catalog.sqlite");
            initialize_database(&database_path)
                .map_err(|error| Box::<dyn std::error::Error>::from(error))?;
            std::fs::create_dir_all(cache_directory.join("posters"))?;
            app.manage(AppState {
                database_path,
                cache_directory,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            upsert_local_project,
            list_local_projects,
            list_local_clips,
            scan_folder,
            relink_folder,
            reveal_clip,
            prepare_transcription,
            list_transcription_chunks,
            list_transcript_summaries,
            list_transcript_utterances,
            search_transcripts,
            extract_transcription_chunk,
            transcribe_audio_chunk,
            transcript_chunk_payload,
            complete_transcription_chunk,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Docubase");
}
