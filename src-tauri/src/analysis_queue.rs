use rusqlite::{params, OptionalExtension, Row};
use tauri::State;

use crate::database::connection;
use crate::models::{AppState, VisualAnalysisQueueItem, VisualAnalysisRun};
use crate::utilities::{now, string_error};

const ITEM_STATES: [&str; 6] = [
    "queued",
    "retrying",
    "submitted",
    "complete",
    "failed",
    "skipped",
];

#[tauri::command]
pub(crate) fn create_visual_analysis_run(
    state: State<'_, AppState>,
    run_id: String,
    project_id: String,
    clip_ids: Vec<String>,
    analysis_mode: String,
    estimated_cost_usd: f64,
) -> Result<VisualAnalysisRun, String> {
    if run_id.is_empty()
        || !run_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_".contains(character))
    {
        return Err("Invalid analysis run identifier.".to_string());
    }
    if !matches!(analysis_mode.as_str(), "batch" | "fast") {
        return Err("Invalid analysis mode.".to_string());
    }
    if clip_ids.is_empty() || clip_ids.len() > 10_000 {
        return Err("Choose between 1 and 10,000 clips for analysis.".to_string());
    }
    let mut connection = connection(&state)?;
    let existing: Option<String> = connection
        .query_row(
            "SELECT id FROM visual_analysis_runs
             WHERE project_id = ?1 AND state = 'active'
             ORDER BY updated_at DESC LIMIT 1",
            params![project_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(string_error)?;
    if existing.is_some() {
        return Err("This project already has an active analysis run.".to_string());
    }
    let timestamp = now();
    let transaction = connection.transaction().map_err(string_error)?;
    transaction
        .execute(
            "INSERT INTO visual_analysis_runs (
                id, project_id, analysis_mode, state, estimated_cost_usd,
                created_at, updated_at
             ) VALUES (?1, ?2, ?3, 'active', ?4, ?5, ?5)",
            params![
                run_id,
                project_id,
                analysis_mode,
                estimated_cost_usd.max(0.0),
                timestamp
            ],
        )
        .map_err(string_error)?;
    for (position, clip_id) in clip_ids.iter().enumerate() {
        transaction
            .execute(
                "INSERT INTO visual_analysis_queue (
                    run_id, project_id, clip_id, position, state, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, 'queued', ?5)",
                params![run_id, project_id, clip_id, position as i64, timestamp],
            )
            .map_err(string_error)?;
    }
    transaction.commit().map_err(string_error)?;
    load_run(&state, &run_id)?.ok_or_else(|| "Analysis run disappeared.".to_string())
}

#[tauri::command]
pub(crate) fn get_active_visual_analysis_run(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Option<VisualAnalysisRun>, String> {
    let connection = connection(&state)?;
    let run_id: Option<String> = connection
        .query_row(
            "SELECT id FROM visual_analysis_runs
             WHERE project_id = ?1 AND state = 'active'
             ORDER BY updated_at DESC LIMIT 1",
            params![project_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(string_error)?;
    run_id
        .map(|id| load_run(&state, &id))
        .transpose()
        .map(|run| run.flatten())
}

#[tauri::command]
pub(crate) fn update_visual_analysis_queue_item(
    state: State<'_, AppState>,
    run_id: String,
    clip_id: String,
    item_state: String,
    job_id: Option<String>,
    error: Option<String>,
    increment_attempt: bool,
) -> Result<VisualAnalysisRun, String> {
    if !ITEM_STATES.contains(&item_state.as_str()) {
        return Err("Invalid analysis queue state.".to_string());
    }
    let timestamp = now();
    let connection = connection(&state)?;
    let changed = connection
        .execute(
            "UPDATE visual_analysis_queue
             SET state = ?1,
                 attempt_count = attempt_count + CASE WHEN ?2 THEN 1 ELSE 0 END,
                 job_id = COALESCE(?3, job_id), error = ?4, updated_at = ?5
             WHERE run_id = ?6 AND clip_id = ?7",
            params![
                item_state,
                increment_attempt,
                job_id,
                error,
                timestamp,
                run_id,
                clip_id
            ],
        )
        .map_err(string_error)?;
    if changed == 0 {
        return Err("Analysis queue item not found.".to_string());
    }
    connection
        .execute(
            "UPDATE visual_analysis_runs SET updated_at = ?1 WHERE id = ?2",
            params![timestamp, run_id],
        )
        .map_err(string_error)?;
    load_run(&state, &run_id)?.ok_or_else(|| "Analysis run disappeared.".to_string())
}

#[tauri::command]
pub(crate) fn finish_visual_analysis_run(
    state: State<'_, AppState>,
    run_id: String,
) -> Result<VisualAnalysisRun, String> {
    let mut run =
        load_run(&state, &run_id)?.ok_or_else(|| "Analysis run not found.".to_string())?;
    if run.queued_count == 0 && run.retrying_count == 0 && run.submitted_count == 0 {
        let final_state = if run.failed_count > 0 {
            "complete_with_errors"
        } else {
            "complete"
        };
        let connection = connection(&state)?;
        connection
            .execute(
                "UPDATE visual_analysis_runs SET state = ?1, updated_at = ?2 WHERE id = ?3",
                params![final_state, now(), run_id],
            )
            .map_err(string_error)?;
        run = load_run(&state, &run_id)?.ok_or_else(|| "Analysis run disappeared.".to_string())?;
    } else {
        let connection = connection(&state)?;
        connection
            .execute(
                "UPDATE visual_analysis_runs SET updated_at = ?1 WHERE id = ?2",
                params![now(), run_id],
            )
            .map_err(string_error)?;
        run = load_run(&state, &run_id)?.ok_or_else(|| "Analysis run disappeared.".to_string())?;
    }
    Ok(run)
}

fn load_run(state: &AppState, run_id: &str) -> Result<Option<VisualAnalysisRun>, String> {
    let connection = connection(state)?;
    let header: Option<(String, String, String, String, f64, String, String)> = connection
        .query_row(
            "SELECT id, project_id, analysis_mode, state, estimated_cost_usd,
                    created_at, updated_at
             FROM visual_analysis_runs WHERE id = ?1",
            params![run_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .optional()
        .map_err(string_error)?;
    let Some((
        id,
        project_id,
        analysis_mode,
        run_state,
        estimated_cost_usd,
        created_at,
        updated_at,
    )) = header
    else {
        return Ok(None);
    };
    let mut statement = connection
        .prepare(
            "SELECT run_id, project_id, clip_id, position, state, attempt_count,
                    job_id, error, updated_at
             FROM visual_analysis_queue WHERE run_id = ?1 ORDER BY position",
        )
        .map_err(string_error)?;
    let items = statement
        .query_map(params![run_id], queue_item_from_row)
        .map_err(string_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(string_error)?;
    let count = |expected: &str| items.iter().filter(|item| item.state == expected).count() as i64;
    Ok(Some(VisualAnalysisRun {
        id,
        project_id,
        analysis_mode,
        state: run_state,
        estimated_cost_usd,
        total_count: items.len() as i64,
        queued_count: count("queued"),
        retrying_count: count("retrying"),
        submitted_count: count("submitted"),
        completed_count: count("complete"),
        failed_count: count("failed"),
        skipped_count: count("skipped"),
        created_at,
        updated_at,
        items,
    }))
}

fn queue_item_from_row(row: &Row<'_>) -> rusqlite::Result<VisualAnalysisQueueItem> {
    Ok(VisualAnalysisQueueItem {
        run_id: row.get(0)?,
        project_id: row.get(1)?,
        clip_id: row.get(2)?,
        position: row.get(3)?,
        state: row.get(4)?,
        attempt_count: row.get(5)?,
        job_id: row.get(6)?,
        error: row.get(7)?,
        updated_at: row.get(8)?,
    })
}
