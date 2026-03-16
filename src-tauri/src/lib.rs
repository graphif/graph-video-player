use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

/// Decode a percent-encoded string (e.g. %E5%BD%95 → 录)
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut result: Vec<u8> = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    result.push(byte);
                    i += 3;
                    continue;
                }
            }
        }
        result.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&result).into_owned()
}

fn guess_mime(path: &str) -> &'static str {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "mov" => "video/quicktime",
        "ts" => "video/mp2t",
        "flv" => "video/x-flv",
        _ => "application/octet-stream",
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .register_uri_scheme_protocol("video-src", |_app, request| {
            use tauri::http::{Response, StatusCode};

            // Decode path: video-src://localhost/Users/foo/bar.mp4
            let raw_path = request.uri().path();
            let file_path = percent_decode(raw_path);

            let mut file = match File::open(&file_path) {
                Ok(f) => f,
                Err(e) => {
                    return Response::builder()
                        .status(StatusCode::NOT_FOUND)
                        .header("Content-Type", "text/plain")
                        .body(format!("Not found: {e}").into_bytes())
                        .unwrap();
                }
            };

            let file_size = match file.metadata() {
                Ok(m) => m.len(),
                Err(_) => {
                    return Response::builder()
                        .status(StatusCode::INTERNAL_SERVER_ERROR)
                        .body(b"Metadata error".to_vec())
                        .unwrap();
                }
            };

            let content_type = guess_mime(&file_path);

            // Handle Range requests (required for video seek support)
            let range_response =
                if let Some(range_val) = request.headers().get("Range") {
                    if let Ok(range_str) = range_val.to_str() {
                        if let Some(range_body) = range_str.strip_prefix("bytes=") {
                            let parts: Vec<&str> = range_body.splitn(2, '-').collect();
                            if parts.len() == 2 {
                                let start: u64 = parts[0].parse().unwrap_or(0);
                                let end: u64 = if parts[1].is_empty() {
                                    file_size.saturating_sub(1)
                                } else {
                                    parts[1]
                                        .parse()
                                        .unwrap_or(file_size.saturating_sub(1))
                                };
                                let end = end.min(file_size.saturating_sub(1));
                                let length = end.saturating_sub(start) + 1;

                                if file.seek(SeekFrom::Start(start)).is_ok() {
                                    let mut buf = Vec::new();
                                    let _ = file.by_ref().take(length).read_to_end(&mut buf);
                                    let actual_end = start + buf.len() as u64 - 1;

                                    Some(
                                        Response::builder()
                                            .status(StatusCode::PARTIAL_CONTENT)
                                            .header("Content-Type", content_type)
                                            .header(
                                                "Content-Range",
                                                format!(
                                                    "bytes {start}-{actual_end}/{file_size}"
                                                ),
                                            )
                                            .header("Content-Length", buf.len().to_string())
                                            .header("Accept-Ranges", "bytes")
                                            .header("Access-Control-Allow-Origin", "*")
                                            .body(buf)
                                            .unwrap(),
                                    )
                                } else {
                                    None
                                }
                            } else {
                                None
                            }
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                } else {
                    None
                };

            if let Some(resp) = range_response {
                return resp;
            }

            // Full file response
            let mut buf = Vec::new();
            let _ = file.read_to_end(&mut buf);

            Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", content_type)
                .header("Content-Length", buf.len().to_string())
                .header("Accept-Ranges", "bytes")
                .header("Access-Control-Allow-Origin", "*")
                .body(buf)
                .unwrap()
        })
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
