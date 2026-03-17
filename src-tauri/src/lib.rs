use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;

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

/// 规范化路径：Windows 下去掉前导斜杠 /D:/... → D:/
fn normalize_path_for_open(path: &str) -> String {
    let mut s = path.to_string();
    if s.len() >= 3
        && s.starts_with('/')
        && s.chars().nth(1).map(|c| c.is_ascii_alphabetic()).unwrap_or(false)
        && s.chars().nth(2) == Some(':')
    {
        s = s[1..].to_string();
    }
    s
}

/// 本地 HTTP 视频流服务状态（用于 Windows 等不支持自定义协议子资源的平台）
struct VideoStreamState {
    port: u16,
    path: Arc<Mutex<Option<PathBuf>>>,
}

/// 设置当前要播放的文件路径并返回通过 HTTP 访问的 URL（供 Windows 等平台使用，避免 ERR_UNKNOWN_URL_SCHEME）
#[tauri::command]
fn get_video_stream_url(path: String, state: tauri::State<VideoStreamState>) -> Result<String, String> {
    let path = normalize_path_for_open(&path);
    if path.is_empty() {
        return Err("路径为空".into());
    }
    let path_buf = PathBuf::from(&path);
    {
        let mut guard = state.path.lock().map_err(|e| e.to_string())?;
        *guard = Some(path_buf);
    }
    Ok(format!("http://127.0.0.1:{}/", state.port))
}

/// 在后台线程中运行的最小 HTTP 服务，仅支持 GET + Range，用于提供视频流
fn run_video_stream_server(path: Arc<Mutex<Option<PathBuf>>>, port_tx: mpsc::Sender<u16>) {
    thread::spawn(move || {
        let listener = match std::net::TcpListener::bind("127.0.0.1:0") {
            Ok(l) => l,
            Err(_) => return,
        };
        let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
        let _ = port_tx.send(port);
        listener.set_nonblocking(false).ok();

        for stream_result in listener.incoming() {
            let mut stream = match stream_result {
                Ok(s) => s,
                Err(_) => continue,
            };
            let path_guard = path.lock().unwrap();
            let path_buf = path_guard.clone();
            drop(path_guard);

            let path_buf = match path_buf {
                Some(p) => p,
                None => {
                    let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
                    continue;
                }
            };
            let path_str = path_buf.to_string_lossy().to_string();
            let path_str = normalize_path_for_open(&path_str);

            let mut file = match File::open(&path_str) {
                Ok(f) => f,
                Err(_) => {
                    let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
                    continue;
                }
            };
            let file_size = match file.metadata() {
                Ok(m) => m.len(),
                Err(_) => {
                    let _ = stream.write_all(b"HTTP/1.1 500 Internal Server Error\r\n\r\n");
                    continue;
                }
            };
            let content_type = guess_mime(&path_str);

            // 简单解析请求：读第一行和 headers，找 Range
            let mut buf = [0u8; 4096];
            let n = match stream.read(&mut buf) {
                Ok(0) => continue,
                Ok(n) => n,
                Err(_) => continue,
            };
            let req = String::from_utf8_lossy(&buf[..n]);
            let range_val = req
                .lines()
                .find(|l| l.to_lowercase().starts_with("range:"))
                .and_then(|l| l.split_once(':'))
                .map(|(_, v)| v.trim().to_string());

            let (status_line, headers, body) = if let Some(range_str) = range_val {
                let range_body = range_str.strip_prefix("bytes=").unwrap_or("");
                let parts: Vec<&str> = range_body.splitn(2, '-').collect();
                if parts.len() == 2 {
                    let start: u64 = parts[0].parse().unwrap_or(0);
                    let end: u64 = if parts[1].is_empty() {
                        file_size.saturating_sub(1)
                    } else {
                        parts[1].parse().unwrap_or(file_size.saturating_sub(1))
                    };
                    let end = end.min(file_size.saturating_sub(1));
                    let length = end.saturating_sub(start) + 1;

                    if file.seek(SeekFrom::Start(start)).is_ok() {
                        let mut body_buf = vec![0u8; length as usize];
                        if file.read_exact(&mut body_buf).is_ok() {
                            let actual_end = start + body_buf.len() as u64 - 1;
                            (
                                "HTTP/1.1 206 Partial Content",
                                format!(
                                    "Content-Type: {}\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\n",
                                    content_type,
                                    start,
                                    actual_end,
                                    file_size,
                                    body_buf.len()
                                ),
                                body_buf,
                            )
                        } else {
                            (
                                "HTTP/1.1 500 Internal Server Error",
                                "Content-Length: 0\r\n".to_string(),
                                vec![],
                            )
                        }
                    } else {
                        (
                            "HTTP/1.1 500 Internal Server Error",
                            "Content-Length: 0\r\n".to_string(),
                            vec![],
                        )
                    }
                } else {
                    (
                        "HTTP/1.1 500 Internal Server Error",
                        "Content-Length: 0\r\n".to_string(),
                        vec![],
                    )
                }
            } else {
                let mut body_buf = Vec::new();
                let _ = file.seek(SeekFrom::Start(0));
                let _ = file.read_to_end(&mut body_buf);
                let len = body_buf.len();
                (
                    "HTTP/1.1 200 OK",
                    format!(
                        "Content-Type: {}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\n",
                        content_type,
                        len
                    ),
                    body_buf,
                )
            };

            let response = format!("{}\r\n{}\r\n", status_line, headers);
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.write_all(&body);
            let _ = stream.flush();
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let path: Arc<Mutex<Option<PathBuf>>> = Arc::new(Mutex::new(None));
    let (port_tx, port_rx) = mpsc::channel();
    run_video_stream_server(Arc::clone(&path), port_tx);
    let port = port_rx.recv().unwrap_or(0);

    let state = VideoStreamState { port, path };

    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .register_uri_scheme_protocol("video-src", |_app, request| {
            use tauri::http::{Response, StatusCode};

            // Decode path: video-src://localhost/D%3A%2F... or video-src://localhost/Users/foo/bar.mp4
            let raw_path = request.uri().path();
            let mut file_path = percent_decode(raw_path);
            // Windows: 前端会生成 /D:/...，需去掉前导斜杠以便 File::open("D:/...") 能正确打开
            if file_path.len() >= 3
                && file_path.starts_with('/')
                && file_path.chars().nth(1).map(|c| c.is_ascii_alphabetic()).unwrap_or(false)
                && file_path.chars().nth(2) == Some(':')
            {
                file_path = file_path[1..].to_string();
            }

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
                                    let _ = std::io::Read::by_ref(&mut file).take(length).read_to_end(&mut buf);
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
        .invoke_handler(tauri::generate_handler![get_video_stream_url])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
