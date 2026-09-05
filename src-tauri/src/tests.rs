use std::{fs::File, io::Write, path::Path};

use rusqlite::{params, Connection};

use crate::catalog::{is_supported_video, sampled_fingerprint};
use crate::database::{connection, initialize_database};
use crate::models::{
    AppState, WorkerSpeechSegment, WorkerSpeechTranscription, WorkerSpeechWord,
};
use crate::projects::delete_local_project_inner;
use crate::transcription::{
    save_apple_transcript, transcript_chunk_payload_inner, transcription_chunk,
    transcription_chunk_ranges,
};
use crate::utilities::now;
use crate::visual::estimate_visual_cost;

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
fn database_initialization_adds_transcription_tables() {
    let directory = tempfile::tempdir().unwrap();
    let database_path = directory.path().join("catalog.sqlite");
    initialize_database(&database_path).unwrap();
    let connection = Connection::open(database_path).unwrap();
    for table in [
        "transcription_jobs",
        "transcript_utterances",
        "visual_clip_jobs",
        "visual_frames",
    ] {
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
    let visual_columns = connection
        .prepare("PRAGMA table_info(visual_clip_jobs)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    for column in [
        "significant_change_count",
        "significant_change_ratio",
        "median_change_score",
        "maximum_change_score",
    ] {
        assert!(visual_columns.iter().any(|name| name == column));
    }
    let clip_columns = connection
        .prepare("PRAGMA table_info(clips)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    for column in ["recorded_at", "source_modified_at"] {
        assert!(clip_columns.iter().any(|name| name == column));
    }
}

#[test]
fn database_initialization_backfills_source_file_modified_dates() {
    let directory = tempfile::tempdir().unwrap();
    let database_path = directory.path().join("catalog.sqlite");
    let source_path = directory.path().join("source.mov");
    File::create(&source_path)
        .unwrap()
        .write_all(b"source footage")
        .unwrap();
    initialize_database(&database_path).unwrap();

    let database = Connection::open(&database_path).unwrap();
    let timestamp = now();
    database
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
    database
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
                ?1, 'source', 1000, 25, 1, 0, NULL, 1920, 1080, 'h264',
                'aac', 1, 1000, NULL, 'ready', NULL, ?2, ?2
            )
            ",
            params![source_path.to_string_lossy(), timestamp],
        )
        .unwrap();
    drop(database);

    initialize_database(&database_path).unwrap();
    let database = Connection::open(database_path).unwrap();
    let source_modified_at: Option<String> = database
        .query_row(
            "SELECT source_modified_at FROM clips WHERE id = 'clip-a'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(source_modified_at.is_some());
}

#[test]
fn deleting_a_local_project_cascades_rows_and_only_removes_cached_files() {
    let directory = tempfile::tempdir().unwrap();
    let database_path = directory.path().join("catalog.sqlite");
    let cache_directory = directory.path().join("cache");
    let poster_path = cache_directory.join("posters").join("clip-a.jpg");
    let source_path = directory.path().join("source.mov");
    std::fs::create_dir_all(poster_path.parent().unwrap()).unwrap();
    File::create(&poster_path)
        .unwrap()
        .write_all(b"cached poster")
        .unwrap();
    File::create(&source_path)
        .unwrap()
        .write_all(b"source footage")
        .unwrap();
    initialize_database(&database_path).unwrap();
    let state = AppState {
        database_path,
        cache_directory,
    };
    let database = connection(&state).unwrap();
    let timestamp = now();
    database
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
    database
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
                ?1, 'source', 1000, 25, 1, 0, NULL, 1920, 1080, 'h264',
                'aac', 1, 1000, ?2, 'ready', NULL, ?3, ?3
            )
            ",
            params![
                source_path.to_string_lossy(),
                poster_path.to_string_lossy(),
                timestamp
            ],
        )
        .unwrap();
    drop(database);

    delete_local_project_inner(&state, "project-a").unwrap();

    let database = connection(&state).unwrap();
    let project_count: i64 = database
        .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
        .unwrap();
    let clip_count: i64 = database
        .query_row("SELECT COUNT(*) FROM clips", [], |row| row.get(0))
        .unwrap();
    assert_eq!(project_count, 0);
    assert_eq!(clip_count, 0);
    assert!(!poster_path.exists());
    assert!(source_path.exists());
}

#[test]
fn visual_cost_estimate_uses_batch_image_and_output_rates() {
    assert_eq!(estimate_visual_cost(360, 180), 0.062532);
    assert_eq!(estimate_visual_cost(0, 0), 0.0);
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
                audio_path, stage, attempt_count, created_at, updated_at
            ) VALUES (
                'project-a', 'clip-a', 1, 1800000, 1800000,
                '/tmp/chunk.m4a', 'transcribing', 1, ?1, ?1
            )
            ",
            params![timestamp],
        )
        .unwrap();
    drop(connection);

    let response = WorkerSpeechTranscription {
        locale: "en-US".to_string(),
        model: "Apple SpeechTranscriber".to_string(),
        model_version: "macOS 26".to_string(),
        segments: vec![WorkerSpeechSegment {
            text: "Resume from here.".to_string(),
            start_ms: 1_250,
            end_ms: 2_500,
            confidence: 0.98,
            words: vec![WorkerSpeechWord {
                text: "Resume".to_string(),
                start_ms: 1_250,
                end_ms: 1_750,
                confidence: 0.99,
            }],
        }],
    };
    let payload = save_apple_transcript(&state, "project-a", "clip-a", 1, response).unwrap();

    assert!(payload.chunk.request_id.starts_with("local-"));
    assert_eq!(payload.utterances.len(), 1);
    assert_eq!(payload.utterances[0].start_ms, 1_801_250);
    assert_eq!(payload.utterances[0].words[0].start_ms, 1_801_250);
    let resumed = transcript_chunk_payload_inner(&state, "project-a", "clip-a", 1).unwrap();
    assert_eq!(resumed.chunk.request_id, payload.chunk.request_id);
    assert_eq!(resumed.utterances[0].text, "Resume from here.");
    assert_eq!(
        transcription_chunk(&state, "project-a", "clip-a", 1)
            .unwrap()
            .unwrap()
            .stage,
        "syncing"
    );
}
