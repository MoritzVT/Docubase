use std::path::{Path, PathBuf};

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
                id, owner_id, name, summary, brief, known_names_json,
                terminology_json, context_resource_names_json, context_text,
                thumbnail_path, context_resource_paths_json,
                budget_per_footage_hour, member_ids_json, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
            ON CONFLICT(id) DO UPDATE SET
                owner_id = excluded.owner_id,
                name = excluded.name,
                summary = excluded.summary,
                brief = excluded.brief,
                known_names_json = excluded.known_names_json,
                terminology_json = excluded.terminology_json,
                context_resource_names_json = excluded.context_resource_names_json,
                context_text = excluded.context_text,
                thumbnail_path = excluded.thumbnail_path,
                context_resource_paths_json = excluded.context_resource_paths_json,
                budget_per_footage_hour = excluded.budget_per_footage_hour,
                member_ids_json = excluded.member_ids_json,
                updated_at = excluded.updated_at
            ",
            params![
                project.id,
                project.owner_id,
                project.name,
                project.summary,
                project.brief,
                serde_json::to_string(&project.known_names).map_err(string_error)?,
                serde_json::to_string(&project.terminology).map_err(string_error)?,
                serde_json::to_string(&project.context_resource_names).map_err(string_error)?,
                project.context_text,
                project.thumbnail_path,
                serde_json::to_string(&project.context_resource_paths).map_err(string_error)?,
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
                p.id, p.owner_id, p.name, p.summary, p.brief, p.known_names_json,
                p.terminology_json, p.context_resource_names_json, p.context_text,
                p.budget_per_footage_hour, p.member_ids_json, p.created_at,
                p.updated_at, COUNT(c.id), COALESCE(SUM(c.duration_ms), 0),
                p.thumbnail_path, p.context_resource_paths_json
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
                summary: row.get(3)?,
                brief: row.get(4)?,
                known_names: json_array(row.get::<_, String>(5)?),
                terminology: json_array(row.get::<_, String>(6)?),
                context_resource_names: json_array(row.get::<_, String>(7)?),
                context_text: row.get(8)?,
                budget_per_footage_hour: row.get(9)?,
                member_ids: json_array(row.get::<_, String>(10)?),
                created_at: row.get(11)?,
                updated_at: row.get(12)?,
                clip_count: row.get(13)?,
                total_duration_ms: row.get(14)?,
                thumbnail_path: row.get(15)?,
                context_resource_paths: json_array(row.get::<_, String>(16)?),
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
    let asset_directory = state
        .cache_directory
        .join("project-assets")
        .join(project_id);
    let _ = std::fs::remove_dir_all(asset_directory);
    Ok(())
}

#[tauri::command]
pub(crate) fn import_project_asset(
    state: State<'_, AppState>,
    project_id: String,
    source_path: String,
    asset_type: String,
) -> Result<String, String> {
    if !project_id
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || "-_".contains(character))
    {
        return Err("Invalid project identifier.".to_string());
    }
    let source = PathBuf::from(source_path);
    if !source.is_file() {
        return Err("The selected project file is unavailable.".to_string());
    }
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let root = state
        .cache_directory
        .join("project-assets")
        .join(&project_id);
    let destination = match asset_type.as_str() {
        "thumbnail" if ["jpg", "jpeg", "png", "webp"].contains(&extension.as_str()) => {
            root.join(format!("thumbnail.{extension}"))
        }
        "context_text" if extension == "txt" => {
            if source.metadata().map_err(string_error)?.len() > 256 * 1_024 {
                return Err("Context text files must be 256 KB or smaller.".to_string());
            }
            let filename = source
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("context.txt")
                .replace(['/', '\\'], "-");
            root.join("resources").join(filename)
        }
        "thumbnail" => return Err("Choose a JPG, PNG, or WebP thumbnail.".to_string()),
        "context_text" => return Err("Choose a plain-text .txt resource.".to_string()),
        _ => return Err("Unsupported project asset type.".to_string()),
    };
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(string_error)?;
    }
    std::fs::copy(&source, &destination).map_err(string_error)?;
    Ok(destination.to_string_lossy().into_owned())
}

#[tauri::command]
pub(crate) fn read_project_context(
    state: State<'_, AppState>,
    project_id: String,
    paths: Vec<String>,
) -> Result<String, String> {
    if !project_id
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || "-_".contains(character))
    {
        return Err("Invalid project identifier.".to_string());
    }
    let root = state
        .cache_directory
        .join("project-assets")
        .join(&project_id)
        .join("resources");
    if paths.is_empty() {
        return Ok(String::new());
    }
    let canonical_root = root.canonicalize().map_err(string_error)?;
    let mut combined = String::new();
    for raw_path in paths.into_iter().take(20) {
        let path = PathBuf::from(raw_path);
        let canonical_path = path.canonicalize().map_err(string_error)?;
        if !canonical_path.starts_with(&canonical_root)
            || canonical_path
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| !value.eq_ignore_ascii_case("txt"))
                .unwrap_or(true)
        {
            return Err("A contextual resource is outside this project's text files.".to_string());
        }
        let content = std::fs::read_to_string(&canonical_path)
            .map_err(|_| "Context text files must use UTF-8 encoding.".to_string())?;
        let name = canonical_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("context.txt");
        let section = format!("Source: {name}\n{}\n\n", content.trim());
        for character in section.chars() {
            if combined.len() + character.len_utf8() > 12_000 {
                return Ok(combined.trim().to_string());
            }
            combined.push(character);
        }
    }
    Ok(combined.trim().to_string())
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
