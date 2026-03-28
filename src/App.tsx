import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { open } from "@tauri-apps/plugin-dialog";
import "./App.css";

interface VideoParams {
  path: string;
  t?: number;      // 起始时间（秒）
  end?: number;    // 结束时间（秒）
  speed?: number;  // 播放速率
  loop?: boolean;
  muted?: boolean;
  volume?: number; // 0~1
  title?: string;
}

/**
 * 解析时间字符串为秒数。
 * 支持格式：90 | 1:30 | 1:30:00 | 1m30s | 2h15m
 */
function parseTime(s: string): number {
  const num = Number(s);
  if (!isNaN(num)) return num;

  if (s.includes(":")) {
    const parts = s.split(":").map(Number);
    if (parts.some(isNaN)) return 0;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
  }

  // XhYmZs 格式
  let total = 0;
  const hMatch = s.match(/(\d+)h/);
  const mMatch = s.match(/(\d+)m/);
  const secMatch = s.match(/(\d+)s/);
  if (hMatch) total += parseInt(hMatch[1]) * 3600;
  if (mMatch) total += parseInt(mMatch[1]) * 60;
  if (secMatch) total += parseInt(secMatch[1]);
  return total;
}

/**
 * 将 deep link 解析出的路径规范化为 Windows/Unix 可用的绝对路径。
 * - graph-video:///D:/path → 得到 "/D:/path"，需改为 "D:/path"
 * - graph-video://D:/path 在部分环境下 ":" 被当 URL 的 host 解析掉，得到 "D/path"，需改为 "D:/path"
 */
function normalizeFilePath(path: string): string {
  if (!path) return path;
  // 前导斜杠 + Windows 盘符：/D:/... → D:/
  if (/^\/[A-Za-z]:/.test(path)) {
    const match = path.match(/^\/([A-Za-z]):(\/.*)?$/);
    if (match) return match[1] + ":" + (match[2] ?? "/");
  }
  // 单字母 + 斜杠（缺冒号）：D/... → D:/
  const missingColon = /^([A-Za-z])\/(.*)$/;
  if (missingColon.test(path)) {
    const match = path.match(/^([A-Za-z])\/(.*)$/);
    if (match) return match[1] + ":" + "/" + match[2];
  }
  return path;
}

/**
 * 解析 graph-video:// URL，返回 VideoParams。
 * 格式：graph-video:///绝对路径/video.mp4?t=90&speed=1.5&...
 * 或 graph-video://D:/绝对路径/video.mp4?t=90（Windows 下两斜杠时冒号可能被吞掉）
 */
function parseGraphVideoUrl(url: string): VideoParams | null {
  if (!url.startsWith("graph-video://")) return null;
  try {
    const withoutScheme = url.slice("graph-video://".length);
    const qIndex = withoutScheme.indexOf("?");
    const rawPath = qIndex === -1 ? withoutScheme : withoutScheme.slice(0, qIndex);
    const queryString = qIndex === -1 ? "" : withoutScheme.slice(qIndex + 1);

    let path: string;
    try {
      path = decodeURIComponent(rawPath);
    } catch {
      path = rawPath;
    }
    path = normalizeFilePath(path);
    if (!path) return null;

    const params = new URLSearchParams(queryString);
    const result: VideoParams = { path };

    const tStr = params.get("t");
    if (tStr !== null) result.t = parseTime(tStr);

    const endStr = params.get("end");
    if (endStr !== null) result.end = parseTime(endStr);

    const speedStr = params.get("speed");
    if (speedStr !== null) {
      const speed = parseFloat(speedStr);
      if (!isNaN(speed) && speed > 0) result.speed = speed;
    }

    const loopStr = params.get("loop");
    if (loopStr === "1" || loopStr === "true") result.loop = true;

    const mutedStr = params.get("muted");
    if (mutedStr === "1" || mutedStr === "true") result.muted = true;

    const volStr = params.get("volume");
    if (volStr !== null) {
      const vol = parseFloat(volStr);
      if (!isNaN(vol)) result.volume = Math.max(0, Math.min(1, vol));
    }

    const titleStr = params.get("title");
    if (titleStr !== null) result.title = titleStr;

    return result;
  } catch {
    return null;
  }
}

function formatSecondsForUrl(t: number): string {
  const s = t.toFixed(3);
  return s.replace(/\.?0+$/, "");
}

function encodeGraphVideoPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return encodeURI(normalized).replace(/#/g, "%23").replace(/\?/g, "%3F");
}

function buildGraphVideoUrl(path: string, params?: { t?: number }): string | null {
  const normalized = path.replace(/\\/g, "/");
  const isWindowsAbs = /^[A-Za-z]:\//.test(normalized);
  const isUnixAbs = normalized.startsWith("/");
  if (!isWindowsAbs && !isUnixAbs) return null;

  const encodedPath = encodeGraphVideoPath(normalized);
  const base = isWindowsAbs ? `graph-video:///${encodedPath}` : `graph-video://${encodedPath}`;

  const query = new URLSearchParams();
  if (params?.t !== undefined) query.set("t", formatSecondsForUrl(params.t));
  const qs = query.toString();
  return qs ? `${base}?${qs}` : base;
}

async function writeToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "true");
  el.style.position = "fixed";
  el.style.top = "-1000px";
  el.style.left = "-1000px";
  document.body.appendChild(el);
  el.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(el);
  if (!ok) throw new Error("copy failed");
}

/**
 * 通过后端 HTTP 流获取视频 URL。在 Windows 上自定义协议 video-src:// 无法用于 <video src>（ERR_UNKNOWN_URL_SCHEME），
 * 故统一用本地 HTTP 服务提供视频流，各平台均可正常播放与 seek。
 */
async function getVideoStreamUrl(path: string): Promise<string> {
  return invoke<string>("get_video_stream_url", { path });
}

function App() {
  const [videoSrc, setVideoSrc] = useState<string>("");
  const [videoParams, setVideoParams] = useState<VideoParams | null>(null);
  const [videoLoadError, setVideoLoadError] = useState<string | null>(null);
  const [copyLinkText, setCopyLinkText] = useState<string>("复制此刻链接");
  const videoRef = useRef<HTMLVideoElement>(null);
  const isTauri = Boolean((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__);

  const playParams = (params: VideoParams) => {
    setVideoLoadError(null);
    setVideoParams(params);
    getVideoStreamUrl(params.path)
      .then((url) => setVideoSrc(url))
      .catch((e) =>
        setVideoLoadError("无法获取视频流: " + (e instanceof Error ? e.message : String(e)))
      );
  };

  const playFile = (file: File) => {
    setVideoLoadError(null);
    const nativePath = (file as any).path as string | undefined;
    if (nativePath) {
      playParams({ path: nativePath });
    } else {
      // fallback: blob URL（dev 模式下无原生路径时使用）
      setVideoParams({ path: file.name });
      setVideoSrc(URL.createObjectURL(file));
    }
  };

  /** 视频加载失败（文件不存在、格式不支持、协议错误等） */
  const handleVideoError = () => {
    const path = videoParams?.path ?? "";
    setVideoLoadError(
      path
        ? `无法播放：文件不存在或格式不支持\n${path}`
        : "无法播放：请检查链接或选择本地文件"
    );
  };

  useEffect(() => {
    // 冷启动：由 graph-video:// 协议直接唤起
    getCurrent()
      .then((urls) => {
        if (urls && urls.length > 0) {
          const params = parseGraphVideoUrl(urls[0]);
          if (params) playParams(params);
        }
      })
      .catch(() => {});

    // 热启动：应用已运行时收到协议调用
    let unlisten: (() => void) | null = null;
    onOpenUrl((urls) => {
      if (urls.length > 0) {
        const params = parseGraphVideoUrl(urls[0]);
        if (params) playParams(params);
      }
    }).then((fn) => {
      unlisten = fn;
    });

    let unlistenFileDrop: (() => void) | null = null;
    if (isTauri) {
      listen<any>("tauri://file-drop", (event) => {
        const payload = (event as any)?.payload;
        const path = Array.isArray(payload) ? payload[0] : payload;
        if (typeof path === "string" && path) playParams({ path });
      })
        .then((fn) => {
          unlistenFileDrop = fn;
        })
        .catch(() => {});
    }

    return () => {
      unlisten?.();
      unlistenFileDrop?.();
    };
  }, []);

  /** 视频元数据加载完成后应用所有参数 */
  const handleLoadedMetadata = () => {
    const video = videoRef.current;
    if (!video || !videoParams) return;
    if (videoParams.t !== undefined) video.currentTime = videoParams.t;
    if (videoParams.speed !== undefined) video.playbackRate = videoParams.speed;
    if (videoParams.loop !== undefined) video.loop = videoParams.loop;
    if (videoParams.muted !== undefined) video.muted = videoParams.muted;
    if (videoParams.volume !== undefined) video.volume = videoParams.volume;
  };

  /** 监控 end 时间点，到达后暂停 */
  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video || videoParams?.end === undefined) return;
    if (video.currentTime >= videoParams.end) {
      video.pause();
      video.currentTime = videoParams.end;
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (isTauri) return;
    const file = e.dataTransfer.files[0];
    if (file) playFile(file);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (isTauri) return;
    const file = e.target.files?.[0];
    if (file) playFile(file);
    e.target.value = "";
  };

  const displayTitle = videoParams?.title ?? videoParams?.path ?? "";

  const handleChooseVideo = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: "Video",
            extensions: ["mp4", "m4v", "webm", "mkv", "avi", "mov", "ts", "flv"],
          },
        ],
      });
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (typeof path === "string" && path) playParams({ path });
    } catch {}
  };

  const handleCopyLink = async () => {
    const video = videoRef.current;
    const path = videoParams?.path;
    if (!video || !path) return;

    const t = Math.max(0, Number(video.currentTime.toFixed(3)));
    const url = buildGraphVideoUrl(path, { t });
    if (!url) {
      setCopyLinkText("无法生成");
      window.setTimeout(() => setCopyLinkText("复制此刻链接"), 1200);
      return;
    }

    try {
      await writeToClipboard(url);
      setCopyLinkText("已复制");
    } catch {
      setCopyLinkText("复制失败");
    } finally {
      window.setTimeout(() => setCopyLinkText("复制此刻链接"), 1200);
    }
  };

  return (
    <div
      className="player-container"
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
    >
      {videoSrc ? (
        <>
          <video
            ref={videoRef}
            src={videoSrc}
            controls
            className="video-player"
            autoPlay
            onLoadedMetadata={handleLoadedMetadata}
            onTimeUpdate={handleTimeUpdate}
            onError={handleVideoError}
          />
          {videoLoadError && (
            <div className="video-error" role="alert">
              {videoLoadError}
            </div>
          )}
          <div className="video-path" title={videoParams?.path}>
            <span>{displayTitle}</span>
            <button
              type="button"
              className="change-btn"
              onClick={handleCopyLink}
              disabled={!videoParams?.path}
            >
              {copyLinkText}
            </button>
            {isTauri ? (
              <button type="button" className="change-btn" onClick={handleChooseVideo}>
                更换
              </button>
            ) : (
              <label className="change-btn">
                更换
                <input
                  type="file"
                  accept="video/*"
                  hidden
                  onChange={handleFileSelect}
                />
              </label>
            )}
          </div>
        </>
      ) : (
        <div className="drop-zone">
          <div className="drop-content">
            <div className="icon">▶</div>
            <p className="title">Graph Video Player</p>
            <p className="desc">拖拽视频文件到此处播放</p>
            {isTauri ? (
              <button type="button" className="file-btn" onClick={handleChooseVideo}>
                选择文件
              </button>
            ) : (
              <label className="file-btn">
                选择文件
                <input
                  type="file"
                  accept="video/*"
                  hidden
                  onChange={handleFileSelect}
                />
              </label>
            )}
            <p className="hint">或通过 graph-video:///path/to/video?t=90 协议唤起</p>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
