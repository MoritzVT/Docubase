use std::path::{Path, PathBuf};

use rusqlite::{params, OptionalExtension, Row};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};

use crate::database::connection;
use crate::media::extract_frames;
use crate::models::{AppState, ClipVisualSummary, VisualFrame, VISUAL_MOMENT_DURATION_MS};
use crate::utilities::{now, string_error};

#[tauri::command]
pub(crate) async fn extract_visual_index(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    clip_id: String,
) -> Result<Vec<VisualFrame>, String> {
    let existing = list_visual_frames_inner(&state, &project_id, &clip_id)?;
    let current_stage: Option<String> = {
        let connection = connection(&state)?;
        connection
            .query_row(
                "SELECT stage FROM visual_clip_jobs
                 WHERE project_id = ?1 AND clip_id = ?2",
                params![project_id, clip_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(string_error)?
    };
    if matches!(
        current_stage.as_deref(),
        Some("ready" | "uploading" | "batched" | "analyzing" | "complete")
    ) && !existing.is_empty()
        && existing
            .iter()
            .all(|frame| Path::new(&frame.local_path).is_file())
    {
        return Ok(existing);
    }

    let (source_path, duration_ms): (String, i64) = {
        let connection = connection(&state)?;
        connection
            .query_row(
                "SELECT source_path, duration_ms FROM clips
                 WHERE project_id = ?1 AND id = ?2",
                params![project_id, clip_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(string_error)?
            .ok_or_else(|| "Clip not found in the local catalog.".to_string())?
    };
    if !Path::new(&source_path).is_file() {
        return Err("The source file has moved. Use Relink folder first.".to_string());
    }

    let timestamp = now();
    {
        let connection = connection(&state)?;
        connection
            .execute(
                "
                INSERT INTO visual_clip_jobs (
                    project_id, clip_id, stage, sampled_frame_count,
                    estimated_cost_usd, created_at, updated_at
                ) VALUES (?1, ?2, 'extracting', 0, 0, ?3, ?3)
                ON CONFLICT(project_id, clip_id) DO UPDATE SET
                    stage = 'extracting', error = NULL, updated_at = excluded.updated_at
                ",
                params![project_id, clip_id, timestamp],
            )
            .map_err(string_error)?;
    }

    let output_directory = visual_frames_directory(&state, &project_id, &clip_id);
    let extraction = extract_frames(&app, Path::new(&source_path), &output_directory).await;
    let extraction = match extraction {
        Ok(value) if !value.retained_frames.is_empty() => value,
        Ok(_) => {
            let message = "No usable frames were extracted from this clip.".to_string();
            update_visual_clip_job(
                &state,
                &project_id,
                &clip_id,
                "failed",
                None,
                None,
                Some(&message),
            )?;
            return Err(message);
        }
        Err(error) => {
            update_visual_clip_job(
                &state,
                &project_id,
                &clip_id,
                "failed",
                None,
                None,
                Some(&error),
            )?;
            return Err(error);
        }
    };

    let frame_count = extraction.retained_frames.len() as i64;
    let moment_count = extraction
        .retained_frames
        .iter()
        .map(|frame| frame.timestamp_ms / VISUAL_MOMENT_DURATION_MS)
        .collect::<std::collections::HashSet<_>>()
        .len() as i64;
    let estimated_cost_usd = estimate_visual_cost(frame_count, moment_count);
    let sampled_frame_count = extraction.sampled_frame_count;
    let significant_change_count = extraction.significant_change_count;
    let significant_change_ratio = extraction.significant_change_ratio.clamp(0.0, 1.0);
    let median_change_score = extraction.median_change_score.clamp(0.0, 1.0);
    let maximum_change_score = extraction.maximum_change_score.clamp(0.0, 1.0);
    let mut connection = connection(&state)?;
    let transaction = connection.transaction().map_err(string_error)?;
    transaction
        .execute(
            "DELETE FROM visual_frames WHERE project_id = ?1 AND clip_id = ?2",
            params![project_id, clip_id],
        )
        .map_err(string_error)?;
    for frame in extraction.retained_frames {
        let frame_id = format!("frame-{:012}", frame.timestamp_ms);
        let moment_index = frame.timestamp_ms / VISUAL_MOMENT_DURATION_MS;
        let moment_id = format!("moment-{moment_index:08}");
        let local_path = output_directory.join(&frame.filename);
        transaction
            .execute(
                "
                INSERT INTO visual_frames (
                    id, project_id, clip_id, moment_id, timestamp_ms, local_path,
                    width, height, file_size_bytes, change_score, stage,
                    storage_path, error, created_at, updated_at
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'ready',
                    NULL, NULL, ?11, ?11
                )
                ",
                params![
                    frame_id,
                    project_id,
                    clip_id,
                    moment_id,
                    frame.timestamp_ms.min(duration_ms.max(0)),
                    local_path.to_string_lossy(),
                    frame.width,
                    frame.height,
                    frame.file_size_bytes,
                    frame.change_score.clamp(0.0, 1.0),
                    timestamp,
                ],
            )
            .map_err(string_error)?;
    }
    transaction
        .execute(
            "
            UPDATE visual_clip_jobs
            SET stage = 'ready', sampled_frame_count = ?1,
                significant_change_count = ?2,
                significant_change_ratio = ?3,
                median_change_score = ?4,
                maximum_change_score = ?5,
                estimated_cost_usd = ?6, batch_job_id = NULL,
                error = NULL, updated_at = ?7
            WHERE project_id = ?8 AND clip_id = ?9
            ",
            params![
                sampled_frame_count,
                significant_change_count,
                significant_change_ratio,
                median_change_score,
                maximum_change_score,
                estimated_cost_usd,
                timestamp,
                project_id,
                clip_id,
            ],
        )
        .map_err(string_error)?;
    transaction.commit().map_err(string_error)?;
    list_visual_frames_inner(&state, &project_id, &clip_id)
}

#[tauri::command]
pub(crate) fn list_visual_frames(
    state: State<'_, AppState>,
    project_id: String,
    clip_id: String,
) -> Result<Vec<VisualFrame>, String> {
    list_visual_frames_inner(&state, &project_id, &clip_id)
}

#[tauri::command]
pub(crate) fn list_visual_summaries(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<ClipVisualSummary>, String> {
    let connection = connection(&state)?;
    let mut statement = connection
        .prepare(
            "
            SELECT
                j.clip_id, j.stage, COUNT(f.id),
                COALESCE(SUM(CASE WHEN f.storage_path IS NOT NULL THEN 1 ELSE 0 END), 0),
                COUNT(DISTINCT f.moment_id), j.significant_change_count,
                j.significant_change_ratio, j.median_change_score,
                j.maximum_change_score, j.estimated_cost_usd,
                j.error, j.updated_at
            FROM visual_clip_jobs j
            LEFT JOIN visual_frames f
                ON f.project_id = j.project_id AND f.clip_id = j.clip_id
            WHERE j.project_id = ?1
            GROUP BY j.project_id, j.clip_id
            ORDER BY j.clip_id
            ",
        )
        .map_err(string_error)?;
    let summaries = statement
        .query_map(params![project_id], |row| {
            Ok(ClipVisualSummary {
                clip_id: row.get(0)?,
                stage: row.get(1)?,
                total_frames: row.get(2)?,
                uploaded_frames: row.get(3)?,
                moment_count: row.get(4)?,
                completed_moments: 0,
                significant_change_count: row.get(5)?,
                significant_change_ratio: row.get(6)?,
                median_change_score: row.get(7)?,
                maximum_change_score: row.get(8)?,
                description: String::new(),
                tags: Vec::new(),
                estimated_cost_usd: row.get(9)?,
                error: row.get(10)?,
                updated_at: row.get(11)?,
            })
        })
        .map_err(string_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(string_error)?;
    Ok(summaries)
}

#[tauri::command]
pub(crate) fn read_visual_frame(
    state: State<'_, AppState>,
    project_id: String,
    clip_id: String,
    frame_id: String,
) -> Result<Vec<u8>, String> {
    let connection = connection(&state)?;
    let local_path: String = connection
        .query_row(
            "SELECT local_path FROM visual_frames
             WHERE project_id = ?1 AND clip_id = ?2 AND id = ?3",
            params![project_id, clip_id, frame_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(string_error)?
        .ok_or_else(|| "Visual frame not found.".to_string())?;
    std::fs::read(local_path).map_err(string_error)
}

#[tauri::command]
pub(crate) fn mark_visual_frame_uploaded(
    state: State<'_, AppState>,
    project_id: String,
    clip_id: String,
    frame_id: String,
    storage_path: String,
) -> Result<VisualFrame, String> {
    let expected_prefix = format!("projects/{project_id}/clips/{clip_id}/frames/");
    if !storage_path.starts_with(&expected_prefix) || !storage_path.ends_with(".jpg") {
        return Err("The visual frame storage path is invalid.".to_string());
    }
    let connection = connection(&state)?;
    let changed = connection
        .execute(
            "
            UPDATE visual_frames
            SET stage = 'uploading', storage_path = ?1, error = NULL, updated_at = ?2
            WHERE project_id = ?3 AND clip_id = ?4 AND id = ?5
            ",
            params![storage_path, now(), project_id, clip_id, frame_id],
        )
        .map_err(string_error)?;
    if changed == 0 {
        return Err("Visual frame not found.".to_string());
    }
    visual_frame(&state, &project_id, &clip_id, &frame_id)?
        .ok_or_else(|| "Visual frame disappeared.".to_string())
}

#[tauri::command]
pub(crate) fn set_visual_clip_stage(
    state: State<'_, AppState>,
    project_id: String,
    clip_id: String,
    stage: String,
    batch_job_id: Option<String>,
    estimated_cost_usd: Option<f64>,
    error: Option<String>,
) -> Result<(), String> {
    if !matches!(
        stage.as_str(),
        "ready" | "uploading" | "batched" | "analyzing" | "complete" | "failed"
    ) {
        return Err("Invalid visual processing stage.".to_string());
    }
    update_visual_clip_job(
        &state,
        &project_id,
        &clip_id,
        &stage,
        batch_job_id.as_deref(),
        estimated_cost_usd,
        error.as_deref(),
    )
}

pub(crate) fn list_visual_frames_inner(
    state: &AppState,
    project_id: &str,
    clip_id: &str,
) -> Result<Vec<VisualFrame>, String> {
    let connection = connection(state)?;
    let mut statement = connection
        .prepare(
            "
            SELECT
                id, project_id, clip_id, moment_id, timestamp_ms, local_path,
                width, height, file_size_bytes, change_score, stage,
                storage_path, error, created_at, updated_at
            FROM visual_frames
            WHERE project_id = ?1 AND clip_id = ?2
            ORDER BY timestamp_ms
            ",
        )
        .map_err(string_error)?;
    let frames = statement
        .query_map(params![project_id, clip_id], visual_frame_from_row)
        .map_err(string_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(string_error)?;
    Ok(frames)
}

pub(crate) fn visual_frame(
    state: &AppState,
    project_id: &str,
    clip_id: &str,
    frame_id: &str,
) -> Result<Option<VisualFrame>, String> {
    let connection = connection(state)?;
    connection
        .query_row(
            "
            SELECT
                id, project_id, clip_id, moment_id, timestamp_ms, local_path,
                width, height, file_size_bytes, change_score, stage,
                storage_path, error, created_at, updated_at
            FROM visual_frames
            WHERE project_id = ?1 AND clip_id = ?2 AND id = ?3
            ",
            params![project_id, clip_id, frame_id],
            visual_frame_from_row,
        )
        .optional()
        .map_err(string_error)
}

pub(crate) fn visual_frame_from_row(row: &Row<'_>) -> rusqlite::Result<VisualFrame> {
    Ok(VisualFrame {
        id: row.get(0)?,
        project_id: row.get(1)?,
        clip_id: row.get(2)?,
        moment_id: row.get(3)?,
        timestamp_ms: row.get(4)?,
        local_path: row.get(5)?,
        width: row.get(6)?,
        height: row.get(7)?,
        file_size_bytes: row.get(8)?,
        change_score: row.get(9)?,
        stage: row.get(10)?,
        storage_path: row.get(11)?,
        error: row.get(12)?,
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
    })
}

pub(crate) fn update_visual_clip_job(
    state: &AppState,
    project_id: &str,
    clip_id: &str,
    stage: &str,
    batch_job_id: Option<&str>,
    estimated_cost_usd: Option<f64>,
    error: Option<&str>,
) -> Result<(), String> {
    let connection = connection(state)?;
    let changed = connection
        .execute(
            "
            UPDATE visual_clip_jobs
            SET stage = ?1,
                batch_job_id = COALESCE(?2, batch_job_id),
                estimated_cost_usd = COALESCE(?3, estimated_cost_usd),
                error = ?4,
                updated_at = ?5
            WHERE project_id = ?6 AND clip_id = ?7
            ",
            params![
                stage,
                batch_job_id,
                estimated_cost_usd.map(|value| value.max(0.0)),
                error,
                now(),
                project_id,
                clip_id,
            ],
        )
        .map_err(string_error)?;
    if changed == 0 {
        return Err("Visual processing job not found.".to_string());
    }
    Ok(())
}

pub(crate) fn visual_frames_directory(
    state: &AppState,
    project_id: &str,
    clip_id: &str,
) -> PathBuf {
    let project_hash = Sha256::digest(project_id.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    state
        .cache_directory
        .join("visual-frames")
        .join(&project_hash[..16])
        .join(clip_id)
}

pub(crate) fn estimate_visual_cost(frame_count: i64, moment_count: i64) -> f64 {
    const BATCH_INPUT_USD_PER_MILLION: f64 = 0.15;
    const BATCH_OUTPUT_USD_PER_MILLION: f64 = 1.25;
    const IMAGE_TOKENS: f64 = 258.0;
    const ESTIMATED_PROMPT_TOKENS_PER_MOMENT: f64 = 300.0;
    const ESTIMATED_OUTPUT_TOKENS_PER_MOMENT: f64 = 180.0;
    let input = frame_count.max(0) as f64 * IMAGE_TOKENS
        + moment_count.max(0) as f64 * ESTIMATED_PROMPT_TOKENS_PER_MOMENT;
    let output = moment_count.max(0) as f64 * ESTIMATED_OUTPUT_TOKENS_PER_MOMENT;
    ((input * BATCH_INPUT_USD_PER_MILLION + output * BATCH_OUTPUT_USD_PER_MILLION) / 1_000_000.0
        * 1_000_000.0)
        .round()
        / 1_000_000.0
}
