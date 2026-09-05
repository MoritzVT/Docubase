use std::{path::Path, time::Duration};

use reqwest::header::CONTENT_TYPE;
use rusqlite::{params, OptionalExtension};
use tauri::{AppHandle, State};

use crate::database::connection;
use crate::media::extract_audio;
use crate::models::{
    AppState, ClipTranscriptSummary, DeepgramResponse, TranscriptChunkPayload,
    TranscriptSearchMatch, TranscriptUtterance, TranscriptionChunk, DEEPGRAM_API_BASE,
};
use crate::utilities::{now, string_error};

#[tauri::command]
pub(crate) fn prepare_transcription(
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
pub(crate) fn list_transcription_chunks(
    state: State<'_, AppState>,
    project_id: String,
    clip_id: String,
) -> Result<Vec<TranscriptionChunk>, String> {
    list_transcription_chunks_inner(&state, &project_id, &clip_id)
}

#[tauri::command]
pub(crate) fn list_transcript_summaries(
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
pub(crate) fn list_transcript_utterances(
    state: State<'_, AppState>,
    project_id: String,
    clip_id: String,
) -> Result<Vec<TranscriptUtterance>, String> {
    list_transcript_utterances_inner(&state, &project_id, &clip_id, None)
}

#[tauri::command]
pub(crate) fn search_transcripts(
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
pub(crate) async fn extract_transcription_chunk(
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
pub(crate) async fn transcribe_audio_chunk(
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
pub(crate) fn transcript_chunk_payload(
    state: State<'_, AppState>,
    project_id: String,
    clip_id: String,
    chunk_index: i64,
) -> Result<TranscriptChunkPayload, String> {
    transcript_chunk_payload_inner(&state, &project_id, &clip_id, chunk_index)
}

#[tauri::command]
pub(crate) fn complete_transcription_chunk(
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

mod repository;
pub(crate) use repository::*;
