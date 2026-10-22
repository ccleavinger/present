use crate::error::{AppError, AppResult};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io;
use std::path::Path;

/// Recursively sort object keys. This is what guarantees stable, low-noise
/// diffs for the flat AST maps written to disk.
pub fn sort_json(value: &mut Value) {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<(String, Value)> = std::mem::take(map).into_iter().collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            for (key, mut child) in entries {
                sort_json(&mut child);
                map.insert(key, child);
            }
        }
        Value::Array(items) => {
            for item in items {
                sort_json(item);
            }
        }
        _ => {}
    }
}

pub fn canonical_pretty<T: Serialize>(value: &T) -> AppResult<String> {
    let mut json = serde_json::to_value(value)?;
    sort_json(&mut json);
    Ok(serde_json::to_string_pretty(&json)? + "\n")
}

pub fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> AppResult<()> {
    let text = canonical_pretty(value)?;
    write_atomic(path, text.as_bytes())
}

pub fn write_atomic(path: &Path, content: &[u8]) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::Internal("path has no parent".into()))?;
    fs::create_dir_all(parent)?;
    let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("file");
    let tmp = parent.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&tmp, content)?;
    // rename(2) is atomic on the same filesystem; readers never observe a
    // partially written slide.
    if let Err(err) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(err.into());
    }
    Ok(())
}

pub fn read_json<T: DeserializeOwned>(path: &Path) -> AppResult<T> {
    let bytes = fs::read(path)?;
    Ok(serde_json::from_slice(&bytes)?)
}

pub fn read_json_opt<T: DeserializeOwned>(path: &Path) -> AppResult<Option<T>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.into()),
    }
}

pub fn slugify(input: &str) -> String {
    let mut out = String::new();
    let mut last_dash = true;
    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
        if out.len() >= 40 {
            break;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "deck".into()
    } else {
        out
    }
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorts_nested_keys() {
        let mut value = serde_json::json!({
            "z": 1,
            "elements": { "b": {"y": 1, "x": 2}, "a": 3 },
            "a": [{"b": 1, "a": 2}]
        });
        sort_json(&mut value);
        let text = serde_json::to_string(&value).unwrap();
        assert_eq!(
            text,
            r#"{"a":[{"a":2,"b":1}],"elements":{"a":3,"b":{"x":2,"y":1}},"z":1}"#
        );
    }

    #[test]
    fn slugifies_titles() {
        assert_eq!(slugify("My Great Deck!"), "my-great-deck");
        assert_eq!(slugify("???"), "deck");
    }
}
