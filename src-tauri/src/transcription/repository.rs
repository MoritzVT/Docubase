use std::path::PathBuf;

use rusqlite::{params, OptionalExtension, Row};
use sha2::{Digest, Sha256};

use crate::database::connection;
use crate::models::{
    AppState, TranscriptChunkDocument, TranscriptChunkPayload, TranscriptUtterance, TranscriptWord,
    TranscriptionChunk, WorkerSpeechTranscription, TRANSCRIPTION_CHUNK_DURATION_MS,
};
use crate::utilities::{now, string_error};

pub(crate) fn list_transcription_chunks_inner(
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
                stage, attempt_count, transcription_id, model, model_version,
                language, error, updated_at
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

pub(crate) fn transcription_chunk(
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
                stage, attempt_count, transcription_id, model, model_version,
                language, error, updated_at
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
        transcription_id: row.get(7)?,
        model: row.get(8)?,
        model_version: row.get(9)?,
        language: row.get(10)?,
        error: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

pub(crate) fn update_transcription_job(
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

pub(crate) fn list_transcript_utterances_inner(
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

pub(crate) fn transcript_chunk_payload_inner(
    state: &AppState,
    project_id: &str,
    clip_id: &str,
    chunk_index: i64,
) -> Result<TranscriptChunkPayload, String> {
    let chunk = transcription_chunk(state, project_id, clip_id, chunk_index)?
        .ok_or_else(|| "Transcription chunk not found.".to_string())?;
    let transcription_id = chunk
        .transcription_id
        .clone()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "This chunk does not have a saved local transcription.".to_string())?;
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
            request_id: transcription_id,
            model: chunk
                .model
                .unwrap_or_else(|| "Apple SpeechTranscriber".to_string()),
            model_version: chunk.model_version,
            language: chunk.language.unwrap_or_else(|| "en-US".to_string()),
            utterance_count: utterances.len() as i64,
            word_count,
            created_at: chunk.updated_at.clone(),
            updated_at: chunk.updated_at,
        },
        utterances,
    })
}

pub(crate) fn save_apple_transcript(
    state: &AppState,
    project_id: &str,
    clip_id: &str,
    chunk_index: i64,
    transcription: WorkerSpeechTranscription,
) -> Result<TranscriptChunkPayload, String> {
    let chunk = transcription_chunk(state, project_id, clip_id, chunk_index)?
        .ok_or_else(|| "Transcription chunk not found.".to_string())?;
    let timestamp = now();
    let transcription_id = local_transcription_id(project_id, clip_id, chunk_index);

    let utterances: Vec<TranscriptUtterance> = transcription
        .segments
        .into_iter()
        .enumerate()
        .filter_map(|(index, segment)| {
            let text = segment.text.trim().to_string();
            if text.is_empty() {
                return None;
            }
            let words = segment
                .words
                .into_iter()
                .filter_map(|word| {
                    let text = word.text.trim().to_string();
                    if text.is_empty() {
                        return None;
                    }
                    Some(TranscriptWord {
                        punctuated_text: text.clone(),
                        text,
                        start_ms: chunk.start_ms + word.start_ms.max(0),
                        end_ms: chunk.start_ms + word.end_ms.max(word.start_ms).max(0),
                        confidence: bounded_confidence(word.confidence),
                        speaker: None,
                        speaker_confidence: None,
                    })
                })
                .collect();
            Some(TranscriptUtterance {
                id: format!("chunk-{chunk_index:04}-utterance-{index:06}"),
                project_id: project_id.to_string(),
                clip_id: clip_id.to_string(),
                chunk_index,
                start_ms: chunk.start_ms + segment.start_ms.max(0),
                end_ms: chunk.start_ms + segment.end_ms.max(segment.start_ms).max(0),
                speaker: None,
                confidence: bounded_confidence(segment.confidence),
                text,
                words,
                created_at: timestamp.clone(),
                updated_at: timestamp.clone(),
            })
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
            SET stage = 'syncing', transcription_id = ?1, model = ?2,
                model_version = ?3, language = ?4, error = NULL, updated_at = ?5
            WHERE project_id = ?6 AND clip_id = ?7 AND chunk_index = ?8
            ",
            params![
                transcription_id,
                transcription.model,
                transcription.model_version,
                transcription.locale,
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

fn local_transcription_id(project_id: &str, clip_id: &str, chunk_index: i64) -> String {
    let digest = Sha256::digest(format!("{project_id}:{clip_id}:{chunk_index}").as_bytes());
    let value = digest
        .iter()
        .take(12)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("local-{value}")
}

pub(crate) fn audio_chunk_path(
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

fn bounded_confidence(confidence: f64) -> f64 {
    if confidence.is_finite() {
        confidence.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

pub(crate) fn transcription_chunk_ranges(duration_ms: i64) -> Vec<(i64, i64)> {
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
