use tauri::Manager;

mod catalog;
mod database;
mod media;
mod models;
mod projects;
mod transcription;
mod utilities;
mod visual;

use catalog::{list_local_clips, relink_folder, reveal_clip, scan_folder};
use database::initialize_database;
use models::AppState;
use projects::{delete_local_project, list_local_projects, upsert_local_project};
use transcription::{
    complete_transcription_chunk, extract_transcription_chunk, list_transcript_summaries,
    list_transcript_utterances, list_transcription_chunks, prepare_transcription,
    search_transcripts, transcribe_audio_chunk, transcript_chunk_payload,
};
use visual::{
    extract_visual_index, list_visual_frames, list_visual_summaries, mark_visual_frame_uploaded,
    read_visual_frame, set_visual_clip_stage,
};

#[cfg(test)]
mod tests;

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
            delete_local_project,
            list_local_clips,
            scan_folder,
            relink_folder,
            reveal_clip,
            prepare_transcription,
            list_transcription_chunks,
            list_transcript_summaries,
            list_transcript_utterances,
            search_transcripts,
            extract_transcription_chunk,
            transcribe_audio_chunk,
            transcript_chunk_payload,
            complete_transcription_chunk,
            extract_visual_index,
            list_visual_frames,
            list_visual_summaries,
            read_visual_frame,
            mark_visual_frame_uploaded,
            set_visual_clip_stage,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Docubase");
}
