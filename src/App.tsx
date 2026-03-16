import { useState, useEffect, useRef } from "react";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import "./App.css";

function parseGraphVideoUrl(url: string): string | null {
  // graph-video:///absolute/path/to/video.mp4 → /absolute/path/to/video.mp4
  // macOS may percent-encode the URL, so decode it before returning
  if (url.startsWith("graph-video://")) {
    const raw = url.slice("graph-video://".length);
    try {
      return decodeURIComponent(raw) || null;
    } catch {
      return raw || null;
    }
  }
  return null;
}

/** Convert a native file path to a video-src:// URL served by the Rust custom protocol */
function makeVideoSrcUrl(path: string): string {
  // encodeURI keeps / intact but encodes non-ASCII characters (e.g. Chinese)
  return "video-src://localhost" + encodeURI(path);
}

function App() {
  const [videoSrc, setVideoSrc] = useState<string>("");
  const [videoPath, setVideoPath] = useState<string>("");
  const videoRef = useRef<HTMLVideoElement>(null);

  const playPath = (path: string) => {
    const src = makeVideoSrcUrl(path);
    setVideoPath(path);
    setVideoSrc(src);
    setTimeout(() => {
      videoRef.current?.play().catch(() => {});
    }, 100);
  };

  const playFile = (file: File) => {
    const nativePath = (file as any).path as string | undefined;
    if (nativePath) {
      playPath(nativePath);
    } else {
      // fallback: blob URL（dev 模式下无原生路径时使用）
      const blobUrl = URL.createObjectURL(file);
      setVideoPath(file.name);
      setVideoSrc(blobUrl);
    }
  };

  useEffect(() => {
    // 处理冷启动：应用由 graph-video:// 协议直接唤起时
    getCurrent()
      .then((urls) => {
        if (urls && urls.length > 0) {
          const path = parseGraphVideoUrl(urls[0]);
          if (path) playPath(path);
        }
      })
      .catch(() => {});

    // 处理热启动：应用已在运行时收到 graph-video:// 协议
    let unlisten: (() => void) | null = null;
    onOpenUrl((urls) => {
      if (urls.length > 0) {
        const path = parseGraphVideoUrl(urls[0]);
        if (path) playPath(path);
      }
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, []);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) playFile(file);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) playFile(file);
    // reset input so same file can be re-selected
    e.target.value = "";
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
          />
          <div className="video-path" title={videoPath}>
            <span>{videoPath}</span>
            <label className="change-btn">
              更换
              <input
                type="file"
                accept="video/*"
                hidden
                onChange={handleFileSelect}
              />
            </label>
          </div>
        </>
      ) : (
        <div className="drop-zone">
          <div className="drop-content">
            <div className="icon">▶</div>
            <p className="title">Graph Video Player</p>
            <p className="desc">拖拽视频文件到此处播放</p>
            <label className="file-btn">
              选择文件
              <input
                type="file"
                accept="video/*"
                hidden
                onChange={handleFileSelect}
              />
            </label>
            <p className="hint">或通过 graph-video:///path/to/video 协议唤起</p>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;

