# Graph Video Player

一个基于 [Tauri](https://tauri.app) + React + TypeScript 构建的桌面视频播放器，支持通过自定义协议 `graph-video://` 从外部应用唤起并播放指定视频。

---

## 功能特性

- 支持拖拽或选择本地视频文件播放
- 支持自定义协议 `graph-video://` 远程唤起（冷启动 & 热启动均支持）
- 支持 URL 参数控制播放行为（起始时间、速率、音量等）
- 支持视频 seek（Range 请求，自定义 `video-src://` 协议提供）

---

## 自定义协议格式

### 基础格式

```
graph-video:///绝对路径/视频文件.mp4
```

> 注意：`graph-video://` 后接三个斜杠，第三个斜杠是绝对路径的开头。

### 带参数格式

```
graph-video:///绝对路径/视频文件.mp4?参数1=值1&参数2=值2
```

---

## 支持的 URL 参数

| 参数 | 类型 | 示例 | 缺省行为 | 说明 |
|------|------|------|----------|------|
| `t` | 时间 | `t=90` | 从头播放（0 秒） | 起始播放时间 |
| `end` | 时间 | `end=120` | 播放到视频结尾 | 到达该时间点后自动暂停 |
| `speed` | 浮点数 | `speed=1.5` | 正常速率（1.0） | 播放速率，支持 0.25 ~ 4.0 |
| `loop` | `0`/`1` | `loop=1` | 不循环（0） | 视频结束后是否重头循环 |
| `muted` | `0`/`1` | `muted=1` | 不静音（0） | 是否静音启动 |
| `volume` | `0`~`1` | `volume=0.8` | 使用上次音量（浏览器默认） | 初始音量，0 为静音，1 为最大 |
| `title` | 字符串 | `title=第三章` | 显示视频文件名 | 界面底部显示的标题文字 |

### `t` / `end` 时间格式

支持以下四种格式，均表示同一时间点：

| 格式 | 示例 | 含义 |
|------|------|------|
| 纯秒数 | `t=90` | 90 秒 |
| `MM:SS` | `t=1:30` | 1 分 30 秒 |
| `HH:MM:SS` | `t=1:30:00` | 1 小时 30 分 |
| `XhYmZs` | `t=1m30s` | 1 分 30 秒 |

---

## 使用示例

### 从指定时间播放

```
graph-video:///Users/username/Videos/demo.mp4?t=30
```

### 播放片段（30s ~ 90s）

```
graph-video:///Users/username/Videos/demo.mp4?t=30&end=90
```

### 1.5 倍速 + 自定义标题

```
graph-video:///Users/username/Videos/demo.mp4?t=1m30s&speed=1.5&title=第三章
```

### 静音循环播放

```
graph-video:///Users/username/Videos/demo.mp4?loop=1&muted=1
```

### 完整参数示例

```
graph-video:///Users/username/Videos/demo.mp4?t=60&end=180&speed=1.25&volume=0.6&title=课时3
```

### 路径含中文或空格

路径中的中文和特殊字符无需手动编码，直接写即可：

```
graph-video:///Users/username/Desktop/OBS录制/a.mp4?t=30
```

---

## 安装与开发

### 环境要求

- [Node.js](https://nodejs.org/) 18+
- [pnpm](https://pnpm.io/)
- [Rust](https://rustup.rs/)

### 开发模式（不支持协议唤起）

```bash
pnpm install
pnpm tauri dev
```

### 构建并测试协议唤起

```bash
pnpm tauri build --debug
open src-tauri/target/debug/bundle/macos/graph-video-player.app
```

打开 `.app` 一次后，macOS 会注册 `graph-video://` 协议。之后可在浏览器地址栏或终端触发：

```bash
open "graph-video:///Users/username/Videos/demo.mp4?t=30&title=测试"
```

---

## 开发工具推荐

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
