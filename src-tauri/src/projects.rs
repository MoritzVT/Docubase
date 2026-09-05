use std::path::Path;

use rusqlite::{params, Connection};
use tauri::State;

use crate::database::connection;
use crate::models::{AppState, LocalProject};
use crate::utilities::{json_array, string_error};

#[tauri::command]
pub(crate) fn upsert_local_project(
    state: State<'_, AppState>,
    project: LocalProject,
) -> Result<(), String> {
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
pub(crate) fn list_local_projects(state: State<'_, AppState>) -> Result<Vec<LocalProject>, String> {
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
pub(crate) fn delete_local_project(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<(), String> {
    delete_local_project_inner(&state, &project_id)
}

pub(crate) fn delete_local_project_inner(state: &AppState, project_id: &str) -> Result<(), String> {
    let connection = connection(state)?;
    let mut cached_paths = string_query(
        &connection,
        "
        SELECT poster_path FROM clips
        WHERE project_id = ?1 AND poster_path IS NOT NULL
        ",
        project_id,
    )?;
    cached_paths.extend(string_query(
        &connection,
        "
        SELECT audio_path FROM transcription_jobs
        WHERE project_id = ?1 AND audio_path IS NOT NULL
        ",
        project_id,
    )?);
    cached_paths.extend(string_query(
        &connection,
        "
        SELECT local_path FROM visual_frames
        WHERE project_id = ?1
        ",
        project_id,
    )?);
    let changed = connection
        .execute("DELETE FROM projects WHERE id = ?1", params![project_id])
        .map_err(string_error)?;
    if changed == 0 {
        return Err("Local project not found.".to_string());
    }
    drop(connection);

    for cached_path in cached_paths {
        let path = Path::new(&cached_path);
        if path.starts_with(&state.cache_directory) {
            match std::fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => {}
            }
        }
    }
    Ok(())
}

pub(crate) fn string_query(
    connection: &Connection,
    sql: &str,
    project_id: &str,
) -> Result<Vec<String>, String> {
    let mut statement = connection.prepare(sql).map_err(string_error)?;
    let values = statement
        .query_map(params![project_id], |row| row.get(0))
        .map_err(string_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(string_error)?;
    Ok(values)
}
