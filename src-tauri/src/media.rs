use std::path::Path;

use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

use crate::models::{
    WorkerAudioExtraction, WorkerFrameExtraction, WorkerInspection, WorkerSpeechTranscription,
};
use crate::utilities::string_error;

pub(crate) async fn inspect_media(
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

pub(crate) async fn extract_audio(
    app: &AppHandle,
    media_path: &Path,
    output_path: &Path,
    start_ms: i64,
    duration_ms: i64,
) -> Result<WorkerAudioExtraction, String> {
    let output = app
        .shell()
        .sidecar("media-worker")
        .map_err(string_error)?
        .args([
            "extract-audio",
            "--path",
            &media_path.to_string_lossy(),
            "--output",
            &output_path.to_string_lossy(),
            "--start-ms",
            &start_ms.to_string(),
            "--duration-ms",
            &duration_ms.to_string(),
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
            "The media worker could not extract this audio chunk.".to_string()
        } else {
            stderr
        });
    }
    serde_json::from_slice(&output.stdout).map_err(string_error)
}

pub(crate) async fn transcribe_audio(
    app: &AppHandle,
    audio_path: &Path,
    locale: &str,
    contextual_terms: &[String],
) -> Result<WorkerSpeechTranscription, String> {
    let mut arguments = vec![
        "transcribe".to_string(),
        "--audio".to_string(),
        audio_path.to_string_lossy().into_owned(),
        "--locale".to_string(),
        locale.to_string(),
    ];
    for term in contextual_terms {
        arguments.push("--context".to_string());
        arguments.push(term.clone());
    }
    let output = app
        .shell()
        .sidecar("media-worker")
        .map_err(string_error)?
        .args(arguments)
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
            "Apple Speech could not transcribe this audio chunk.".to_string()
        } else {
            stderr
        });
    }
    serde_json::from_slice(&output.stdout).map_err(string_error)
}

pub(crate) async fn extract_frames(
    app: &AppHandle,
    media_path: &Path,
    output_directory: &Path,
) -> Result<WorkerFrameExtraction, String> {
    let output = app
        .shell()
        .sidecar("media-worker")
        .map_err(string_error)?
        .args([
            "extract-frames",
            "--path",
            &media_path.to_string_lossy(),
            "--output-directory",
            &output_directory.to_string_lossy(),
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
            "The media worker could not extract visual frames.".to_string()
        } else {
            stderr
        });
    }
    serde_json::from_slice(&output.stdout).map_err(string_error)
}
