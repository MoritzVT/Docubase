use std::time::SystemTime;

use chrono::{DateTime, Utc};

pub(crate) fn json_array(value: String) -> Vec<String> {
    serde_json::from_str(&value).unwrap_or_default()
}

pub(crate) fn now() -> String {
    Utc::now().to_rfc3339()
}

pub(crate) fn system_time(value: SystemTime) -> String {
    DateTime::<Utc>::from(value).to_rfc3339()
}

pub(crate) fn string_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}
