use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::Command,
};

use rusqlite::{params, OptionalExtension, Row};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};
use walkdir::WalkDir;

use crate::database::connection;
use crate::media::inspect_media;
use crate::models::{AppState, ClipManifest, FrameRate, ImportProgress};
use crate::utilities::{now, string_error, system_time};

#[tauri::command]
pub(crate) fn list_local_clips(
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
                file_size_bytes, poster_path, stage, error, created_at, updated_at,
                recorded_at, source_modified_at
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
pub(crate) async fn scan_folder(
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

        let metadata = std::fs::metadata(media_path).map_err(string_error)?;
        let source_modified_at = metadata.modified().ok().map(system_time);
        let fingerprint = sampled_fingerprint(media_path)?;
        if let Some(cached) = existing_clip(&state, &project_id, &fingerprint)? {
            let poster_is_cached = cached
                .poster_path
                .as_deref()
                .is_some_and(|path| Path::new(path).is_file());
            if cached.stage == "ready" && poster_is_cached {
                let manifest = ClipManifest {
                    filename,
                    portable_directory_hint: directory_hint(media_path),
                    source_modified_at,
                    updated_at: now(),
                    ..cached
                };
                upsert_clip(&state, &manifest, media_path)?;
                manifests.push(manifest);
                continue;
            }
        }

        let poster_path = state
            .cache_directory
            .join("posters")
            .join(format!("{fingerprint}.jpg"));
        let created_at = now();
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
                recorded_at: inspection.recorded_at,
                source_modified_at: source_modified_at.clone(),
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
                recorded_at: None,
                source_modified_at: source_modified_at.clone(),
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
pub(crate) fn relink_folder(
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
        let source_modified_at = std::fs::metadata(entry.path())
            .ok()
            .and_then(|value| value.modified().ok())
            .map(system_time);
        relinked += connection
            .execute(
                "
                UPDATE clips
                SET source_path = ?1, portable_directory_hint = ?2,
                    source_modified_at = ?3, updated_at = ?4
                WHERE project_id = ?5 AND fingerprint = ?6
                ",
                params![
                    entry.path().to_string_lossy(),
                    directory_hint(entry.path()),
                    source_modified_at,
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
pub(crate) fn reveal_clip(
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

pub(crate) fn existing_clip(
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
                file_size_bytes, poster_path, stage, error, created_at, updated_at,
                recorded_at, source_modified_at
            FROM clips
            WHERE project_id = ?1 AND fingerprint = ?2
            ",
            params![project_id, fingerprint],
            clip_from_row,
        )
        .optional()
        .map_err(string_error)
}

pub(crate) fn upsert_clip(
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
                created_at, updated_at, recorded_at, source_modified_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24,
                ?25
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
                recorded_at = excluded.recorded_at,
                source_modified_at = excluded.source_modified_at,
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
                clip.recorded_at,
                clip.source_modified_at,
            ],
        )
        .map_err(string_error)?;
    Ok(())
}

pub(crate) fn clip_from_row(row: &Row<'_>) -> rusqlite::Result<ClipManifest> {
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
        recorded_at: row.get(22)?,
        source_modified_at: row.get(23)?,
    })
}

pub(crate) fn sampled_fingerprint(path: &Path) -> Result<String, String> {
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

pub(crate) fn is_supported_video(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .as_deref(),
        Some("mov" | "mp4" | "m4v")
    )
}

pub(crate) fn file_extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

pub(crate) fn directory_hint(path: &Path) -> String {
    path.parent()
        .and_then(Path::file_name)
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string()
}
