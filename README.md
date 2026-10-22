# W自动配乐

作者与维护者：**汪小昇** · [GitHub](https://github.com/a18329069309-commits)

面向批量短剧的成片感知配乐工具：将剧情分析、音乐与音效检索、时间轴编排、任务恢复和同长音轨导出连接起来。当前以曲库选材、编辑与混音为主，不将所有输出称为原创作曲，也不保证逐切点自动卡拍。

## 发布状态

这是 **0.1.0-preview.4 源码预览版**，不是开箱即用的桌面安装版。

- 包含原项目的上传入口、批量控制器、持久任务队列、编排契约、渲染及辅助工具，不是重写的简化演示。
- 本公开版本的离线测试只验证相应工程行为；不代表已用新影片跑通所有自动分析、选曲或听审，也不保证所有题材的配乐质量。
- 完整自动模式仍需自行准备可用运行时、合规素材库、冻结配置及必要的真实绑定记录。缺配置会报错，不会自动下载整库或跳过资格检查。
- 私有影片、曲库、数据库、模型权重、账户配置和个人历史反馈不包含在仓库中。历史开发环境成功记录不充当本公开版验收。
- 已有新部署听审配置、冻结音画请求、输入规划预算和影片预算隔离；见 [听审接口契约](docs/AUDIO_REVIEW_CONTRACT.md)。本轮改善首次使用说明与离线演示失败提示，不扩展配乐算法。真实自动配乐及听审尚未验收。

## 免费离线检查

首次使用 Windows 时，请打开 **PowerShell**，将源码、依赖解压目录、临时文件与演示输出放在 **D 盘普通目录**，不要使用指向 C 盘的目录链接。演示拒绝向 C 盘、文件系统根目录或项目根目录输出。先按 [快速开始](docs/QUICKSTART.md) 准备：

- Node.js **`>=24.19.0 <25`**：[官方 24.x 下载目录](https://nodejs.org/download/release/latest-v24.x/)。不要直接使用其他主版本的“最新版”。
- FFmpeg 和 ffprobe：[官方入口](https://ffmpeg.org/download.html)。FFmpeg 官方提供源码，Windows 可执行文件来自该页列出的第三方构建；检查实际构建是否具备所需组件。
- 源码二选一：Git 克隆，或 GitHub 的源码 ZIP。**Git 不是离线运行的必需依赖**；需要时可从 [Git 官方 Windows 页面](https://git-scm.com/install/windows) 手工准备 Portable 版本。

依赖与源码准备阶段需要网络；准备后以下演示和回归不提交模型请求。无需 `npm install`、Python、账户、私人曲库或模型权重。工具不自动下载或安装依赖，不修改系统 PATH。D 盘准备、当前终端 PATH、Git/ZIP 两条路线及中文空格路径命令见快速开始。

完成准备并进入包含 `package.json` 的源码目录后：

```powershell
node tools/check-public.mjs
node tools/doctor.mjs --json
node tools/test-offline.mjs
```

具体版本、测试数量、跳过项和 Windows／Ubuntu CI 的实际结果见 [验证记录](docs/VALIDATION.md)。已有依赖环境的执行记录不等于全新电脑安装测试。

## 第一次运行：免费离线演示

```powershell
node tools/demo-offline.mjs
```

该命令在项目 `.muse/` 下新建独立输出目录，生成两段合成短片、测试音源、实际渲染分轨和可播放预览。不需要账户、Python、曲库或模型服务；也不自动安装或下载依赖。仅演示固定编排的渲染与批次处理，不分析新影片剧情、不自动选曲、不执行听审，不是完整自动模式的通过证明。单片演示可加 `--episodes 1`。

`offline_ready=true` 只表示离线依赖检查通过；`automatic_readiness=unverified` 表示完整自动模式未验证。演示的 `technical_ok` 只表示固定合成案例的技术检查通过，`creative_review=not_performed`、`production_approval=false` 不是听感或生产批准。字段、失败报告和恢复步骤见 [快速开始](docs/QUICKSTART.md)；真实配置边界见 [部署说明](docs/DEPLOYMENT.md)。

测试包含合成音频与纯色视频的技术渲染，不使用商业影片或真实歌曲。运行器把临时文件放在项目 `.muse/`，拦截 Node 的 fetch、TCP、HTTP/TLS 接口；这不是操作系统禁网沙箱，也不覆盖所有外部进程。所选用例不提交模型请求。详细范围和实际执行结果见 [验证记录](docs/VALIDATION.md)。

## 代码入口

| 入口 | 用途 |
| --- | --- |
| `scripts/compose_uploaded_episode.mjs` | 单片和批量上传入口，不让用户逐段填写曲目和 cue |
| `scripts/automatic_episode_controller.mjs` | 剧情、选材、编排、渲染与复核阶段协调 |
| `scripts/episode_task_queue.mjs` | 持久队列、任务身份及受限恢复 |
| `scripts/prepare_episode.mjs` | 真实视频时基、音频和画面准备 |
| `scripts/run_sound_job.mjs` | 已冻结方案的可重建执行 |
| `scripts/render_audio.mjs` | BGM、SFX、环境声及 accompaniment 同长分轨渲染 |

完整运行条件见 [部署说明](docs/DEPLOYMENT.md)。这里不提供伪造的曲库授权、听审资格或素材回执。不要把离线样例输入直接当成正式生产配置。

## 当前限制与维护方向

首要工作是可移植部署与公开真实案例，然后继续完善多题材适配、换曲衔接、音效可闻性、对白避让及自动复核。模型预测、生成成功、完整音轨、技术通过和听感认可分别记录。

请用真实问题与可复现步骤反馈；不要提交凭据、无权公开的影片、整曲或完整工作日志。见 [贡献指南](CONTRIBUTING.md)、[安全说明](SECURITY.md) 与 [路线图](docs/ROADMAP.md)。

## 许可

项目自身代码采用 [MIT 许可证](LICENSE)，Copyright (c) 2026 汪小昇。第三方代码保留各自原始许可与署名，见 [第三方声明](THIRD_PARTY_NOTICES.md)。项目代码许可不涵盖用户影片、音乐或外置模型权重。

## English summary

W Auto Score (W自动配乐) is an experimental short-drama scoring pipeline maintained by 汪小昇. It connects story-aware material selection, music/SFX editing, durable batch jobs and aligned stem rendering. This is a source preview, not a turnkey desktop app or a claim of universally validated music quality. Offline tests use synthetic media and do not call model services. Full automatic scoring requires separately configured runtimes, properly licensed assets and real evidence bindings; those private resources are not distributed here.
