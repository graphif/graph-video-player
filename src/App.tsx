import { useState, useEffect, useRef } from "react";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
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
 * 解析 graph-video:// URL，返回 VideoParams。
 * 格式：graph-video:///绝对路径/video.mp4?t=90&speed=1.5&...
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

/** 将原生文件路径转为视频 URL（Rust 自定义协议提供服务） */
function makeVideoSrcUrl(path: string): string {
  const encoded = encodeURI(path.replace(/\\/g, "/"));
  // Windows WebView2 不识别 video-src://，会报 ERR_UNKNOWN_URL_SCHEME；
  // 需使用 http://video-src.localhost/ 格式，由 Tauri 协议处理器接管
  const isWindows = /Win|Windows/i.test(navigator.userAgent);
  if (isWindows) {
    return "http://video-src.localhost/" + encoded;
  }
  return "video-src://localhost/" + encoded;
}

/** 根据当前路径和秒数生成仅带 t 参数的 graph-video 链接 */
function buildGraphVideoUrlWithT(path: string, currentTimeSeconds: number): string {
  const normalizedPath = path.replace(/\\/g, "/");
  const t = Math.floor(currentTimeSeconds);
  return `graph-video:///${normalizedPath}?t=${t}`;
}

function App() {
  const [videoSrc, setVideoSrc] = useState<string>("");
  const [videoParams, setVideoParams] = useState<VideoParams | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const playParams = (params: VideoParams) => {
    setVideoParams(params);
    setVideoSrc(makeVideoSrcUrl(params.path));
    // 自动播放由 autoPlay 属性触发，参数在 onLoadedMetadata 中应用
  };

  const playFile = (file: File) => {
    const nativePath = (file as any).path as string | undefined;
    if (nativePath) {
      playParams({ path: nativePath });
    } else {
      // fallback: blob URL（无原生路径时仅能播放，生成链接会缺绝对路径）
      setVideoParams({ path: file.name });
      setVideoSrc(URL.createObjectURL(file));
    }
  };

  /** 通过 Tauri 原生对话框选择视频，得到完整路径，便于生成带绝对路径的 graph-video 链接 */
  const handleOpenVideoDialog = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        directory: false,
        filters: [
          {
            name: "视频",
            extensions: ["mp4", "webm", "mkv", "avi", "mov", "m4v", "ts", "flv"],
          },
        ],
      });
      if (selected && typeof selected === "string") {
        playParams({ path: selected });
      }
    } catch (_) {
      // 非 Tauri 环境或用户取消
    }
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

    return () => {
      unlisten?.();
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
    const file = e.dataTransfer.files[0];
    if (file) playFile(file);
  };

  const displayTitle = videoParams?.title ?? videoParams?.path ?? "";

  /** 判断是否为绝对路径（Windows 盘符或以 / 开头） */
  const isAbsolutePath = (p: string) =>
    /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/");

  const handleCopyCurrentLink = async () => {
    const video = videoRef.current;
    if (!video || !videoParams?.path) return;
    if (!isAbsolutePath(videoParams.path)) {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      setToast("请使用「选择文件」或「更换」选择视频以生成带完整路径的链接");
      toastTimerRef.current = setTimeout(() => {
        setToast(null);
        toastTimerRef.current = null;
      }, 3000);
      return;
    }
    const url = buildGraphVideoUrlWithT(videoParams.path, video.currentTime);
    try {
      await navigator.clipboard.writeText(url);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      setToast("链接已复制到剪贴板");
      toastTimerRef.current = setTimeout(() => {
        setToast(null);
        toastTimerRef.current = null;
      }, 2500);
    } catch {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      setToast("复制失败");
      toastTimerRef.current = setTimeout(() => {
        setToast(null);
        toastTimerRef.current = null;
      }, 2500);
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
          />
          <div className="video-path" title={videoParams?.path}>
            <span>{displayTitle}</span>
            <button
              type="button"
              className="copy-link-btn"
              onClick={handleCopyCurrentLink}
            >
              生成当前位置的视频链接
            </button>
            <button type="button" className="change-btn" onClick={handleOpenVideoDialog}>
              更换
            </button>
          </div>
          {toast && <div className="toast">{toast}</div>}
        </>
      ) : (
        <div className="drop-zone">
          <div className="drop-content">
            <div className="icon">▶</div>
            <p className="title">Graph Video Player</p>
            <p className="desc">拖拽视频文件到此处播放</p>
            <button type="button" className="file-btn" onClick={handleOpenVideoDialog}>
              选择文件
            </button>
            <p className="hint">或通过 graph-video:///path/to/video?t=90 协议唤起</p>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;

