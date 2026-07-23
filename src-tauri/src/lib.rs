use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::Command,
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
            ",
        )
        .map_err(string_error)
}

fn connection(state: &AppState) -> Result<Connection, String> {
    Connection::open(&state.database_path).map_err(string_error)
}

#[tauri::command]
fn upsert_local_project(
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
                start_timecode_frames: inspection
                    .start_timecode_frames
                    .map(|frames| frames.max(0)),
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

fn upsert_clip(
    state: &AppState,
    clip: &ClipManifest,
    source_path: &Path,
) -> Result<(), String> {
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
        File::create(&first_path).unwrap().write_all(b"same clip").unwrap();
        File::create(&second_path).unwrap().write_all(b"same clip").unwrap();
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Docubase");
}
