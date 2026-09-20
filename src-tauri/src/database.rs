use std::{path::Path, time::Duration};

use rusqlite::Connection;

use crate::models::AppState;
use crate::utilities::string_error;
use crate::utilities::system_time;

pub(crate) fn initialize_database(path: &Path) -> Result<(), String> {
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
                summary TEXT NOT NULL DEFAULT '',
                brief TEXT NOT NULL,
                known_names_json TEXT NOT NULL,
                terminology_json TEXT NOT NULL,
                context_resource_names_json TEXT NOT NULL DEFAULT '[]',
                context_text TEXT NOT NULL DEFAULT '',
                thumbnail_path TEXT,
                context_resource_paths_json TEXT NOT NULL DEFAULT '[]',
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
                recorded_at TEXT,
                source_modified_at TEXT,
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
                transcription_id TEXT,
                model TEXT,
                model_version TEXT,
                language TEXT,
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

            CREATE TABLE IF NOT EXISTS visual_clip_jobs (
                project_id TEXT NOT NULL,
                clip_id TEXT NOT NULL,
                stage TEXT NOT NULL,
                sampled_frame_count INTEGER NOT NULL DEFAULT 0,
                significant_change_count INTEGER NOT NULL DEFAULT 0,
                significant_change_ratio REAL NOT NULL DEFAULT 1,
                median_change_score REAL NOT NULL DEFAULT 1,
                maximum_change_score REAL NOT NULL DEFAULT 1,
                estimated_cost_usd REAL NOT NULL DEFAULT 0,
                batch_job_id TEXT,
                error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (project_id, clip_id),
                FOREIGN KEY (project_id, clip_id)
                    REFERENCES clips(project_id, id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS visual_frames (
                id TEXT NOT NULL,
                project_id TEXT NOT NULL,
                clip_id TEXT NOT NULL,
                moment_id TEXT NOT NULL,
                timestamp_ms INTEGER NOT NULL,
                local_path TEXT NOT NULL,
                width INTEGER NOT NULL,
                height INTEGER NOT NULL,
                file_size_bytes INTEGER NOT NULL,
                change_score REAL NOT NULL,
                stage TEXT NOT NULL,
                storage_path TEXT,
                error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (project_id, clip_id, id),
                FOREIGN KEY (project_id, clip_id)
                    REFERENCES visual_clip_jobs(project_id, clip_id)
                    ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS visual_frames_clip_time
            ON visual_frames(project_id, clip_id, timestamp_ms);

            CREATE INDEX IF NOT EXISTS visual_frames_clip_moment
            ON visual_frames(project_id, clip_id, moment_id);

            CREATE TABLE IF NOT EXISTS visual_analysis_runs (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                analysis_mode TEXT NOT NULL,
                state TEXT NOT NULL,
                estimated_cost_usd REAL NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS visual_analysis_queue (
                run_id TEXT NOT NULL,
                project_id TEXT NOT NULL,
                clip_id TEXT NOT NULL,
                position INTEGER NOT NULL,
                state TEXT NOT NULL,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                job_id TEXT,
                error TEXT,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (run_id, clip_id),
                FOREIGN KEY (run_id) REFERENCES visual_analysis_runs(id) ON DELETE CASCADE,
                FOREIGN KEY (project_id, clip_id)
                    REFERENCES clips(project_id, id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS visual_analysis_queue_run_position
            ON visual_analysis_queue(run_id, position);
            ",
        )
        .map_err(string_error)?;

    for (name, definition) in [
        ("significant_change_count", "INTEGER NOT NULL DEFAULT 0"),
        ("significant_change_ratio", "REAL NOT NULL DEFAULT 1"),
        ("median_change_score", "REAL NOT NULL DEFAULT 1"),
        ("maximum_change_score", "REAL NOT NULL DEFAULT 1"),
    ] {
        add_column_if_missing(&connection, "visual_clip_jobs", name, definition)?;
    }
    add_column_if_missing(&connection, "clips", "recorded_at", "TEXT")?;
    add_column_if_missing(
        &connection,
        "projects",
        "summary",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    add_column_if_missing(
        &connection,
        "projects",
        "context_resource_names_json",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    add_column_if_missing(
        &connection,
        "projects",
        "context_text",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    add_column_if_missing(&connection, "projects", "thumbnail_path", "TEXT")?;
    add_column_if_missing(
        &connection,
        "projects",
        "context_resource_paths_json",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    add_column_if_missing(&connection, "clips", "source_modified_at", "TEXT")?;
    add_column_if_missing(
        &connection,
        "transcription_jobs",
        "transcription_id",
        "TEXT",
    )?;
    add_column_if_missing(&connection, "transcription_jobs", "language", "TEXT")?;
    backfill_source_modified_dates(&connection)?;
    Ok(())
}

fn backfill_source_modified_dates(connection: &Connection) -> Result<(), String> {
    let rows = {
        let mut statement = connection
            .prepare(
                "SELECT project_id, id, source_path FROM clips WHERE source_modified_at IS NULL",
            )
            .map_err(string_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(string_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(string_error)?;
        rows
    };
    for (project_id, clip_id, source_path) in rows {
        let Ok(modified) = std::fs::metadata(source_path).and_then(|value| value.modified()) else {
            continue;
        };
        connection
            .execute(
                "UPDATE clips SET source_modified_at = ?1 WHERE project_id = ?2 AND id = ?3",
                rusqlite::params![system_time(modified), project_id, clip_id],
            )
            .map_err(string_error)?;
    }
    Ok(())
}

fn add_column_if_missing(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(string_error)?;
    let exists = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(string_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(string_error)?
        .iter()
        .any(|name| name == column);
    if !exists {
        connection
            .execute(
                &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
                [],
            )
            .map_err(string_error)?;
    }
    Ok(())
}

pub(crate) fn connection(state: &AppState) -> Result<Connection, String> {
    let connection = Connection::open(&state.database_path).map_err(string_error)?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(string_error)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(string_error)?;
    Ok(connection)
}
