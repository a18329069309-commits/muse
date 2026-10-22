# 第一次运行 W自动配乐

适用于 `0.1.0-preview.4` 源码预览版。目标是无账户、无私人配置、无商业素材、无模型服务地运行固定合成演示，不是新影片自动分析、选曲或听感通过的展示。

## 1. Windows PowerShell 与 D 盘工作位置

以下命令用于 **Windows PowerShell**，不是 cmd 或 Git Bash。请打开 PowerShell 普通窗口，不需要管理员权限。源码、下载包、依赖、临时文件和输出均放在 D 盘普通目录；不要选择指向 C 盘的目录链接。演示拒绝 C 盘、文件系统根目录及项目根目录输出。若没有 D 盘，可自行替换为其他非 C 盘工作目录；所有路径需一致替换。

本页准备阶段需要网络，离线运行阶段不需要账户或模型请求。不要执行 `npm install`；离线演示不需要 Python、API 密钥、订阅登录、曲库或模型权重。

先创建一个专用的新容器。以下命令已有目录就停止，不覆盖。若名称被占用，选择新的容器名，并同步修改后文路径：

```powershell
$QuickstartRoot = "D:\AI-Projects\W自动配乐 快速开始"
if (Test-Path -LiteralPath $QuickstartRoot) { throw "工作目录已存在，请选择新的目录名，不要覆盖" }
New-Item -ItemType Directory -Path $QuickstartRoot | Out-Null
New-Item -ItemType Directory -Path "$QuickstartRoot\downloads" | Out-Null
New-Item -ItemType Directory -Path "$QuickstartRoot\tools" | Out-Null
New-Item -ItemType Directory -Path "$QuickstartRoot\temp" | Out-Null
$env:TEMP = "$QuickstartRoot\temp"
$env:TMP = "$QuickstartRoot\temp"
$env:TMPDIR = "$QuickstartRoot\temp"
```

这些环境变量只影响当前 PowerShell 及其后续子进程，不修改系统设置。不要把 `$QuickstartRoot` 设为磁盘根目录或已有工作目录。

## 2. 手工准备依赖（联网准备）

工具不会自动下载、安装或修改系统 PATH。用浏览器的“另存为”把依赖压缩包保存到上面新建的 `downloads` 目录，不要使用默认 C 盘下载位置；再手工解压到 `tools`。根据自己的 Windows 架构选包，不要混用 x64 与 ARM64。

| 依赖 | 来源与选择 | 本页使用的解压后路径 |
| --- | --- | --- |
| Node.js | [官方 24.x 文件目录](https://nodejs.org/download/release/latest-v24.x/)，正式版 **`>=24.19.0 <25`**，Windows ZIP | `tools\node24\node.exe` |
| FFmpeg 与 ffprobe | [FFmpeg 官方下载页](https://ffmpeg.org/download.html)的 Windows EXE Files，选择包含两者及所需编码器的构建 | `tools\ffmpeg\bin\ffmpeg.exe`、`ffprobe.exe` |
| Git（可选） | 仅 Git 克隆路线需要；[Git 官方 Windows 页面](https://git-scm.com/install/windows)提供 Portable 版本，可手工解压到 D 盘 | `tools\git\cmd\git.exe` |

FFmpeg 官方发布源码，Windows 可执行文件由官方页面列出的 **gyan.dev 或 BtbN 等第三方构建方**提供，不是本项目制作或保证的二进制。`doctor` 会检查实际构建中的所需滤镜和编码器；只看到版本号不够。

压缩包的顶层文件夹随版本变化。上表是人为整理后的示例：可在资源管理器中把**包含 `node.exe` 的那层文件夹**命名为 `node24`，把**包含 `bin` 的 FFmpeg 文件夹**命名为 `ffmpeg`。不要只重命名压缩包。若保留原目录名，按真实位置替换下面变量；这里不承诺所有下载包的内部层级相同。

仅为当前终端设置 PATH，并检查目录：

```powershell
$NodeBin = "$QuickstartRoot\tools\node24"
$MediaBin = "$QuickstartRoot\tools\ffmpeg\bin"
foreach ($RequiredFile in @("$NodeBin\node.exe", "$MediaBin\ffmpeg.exe", "$MediaBin\ffprobe.exe")) {
  if (-not (Test-Path -LiteralPath $RequiredFile -PathType Leaf)) { throw "请核对依赖的实际解压位置" }
}
$env:Path = "$NodeBin;$MediaBin;$env:Path"
node --version
ffmpeg -version
ffprobe -version
```

不要使用 Node 22、25 等其他主版本，也不要使用 24.19.0 之前的 24.x。关闭终端后上述 PATH 失效，下次需重新设置相同变量。已自行准备符合要求的工具时，可把变量指向自己的实际非 C 盘解压目录，无需重复下载。已有依赖机器的复现不等于全新电脑安装已验证，实际测试环境见 [验证记录](VALIDATION.md)。

## 3. 获取源码：二选一（联网准备）

### 路线 A：Git 克隆

若使用 Portable Git，先核对 `tools\git\cmd\git.exe` 确实存在，或按真实解压位置替换 `$GitBin`：

```powershell
$GitBin = "$QuickstartRoot\tools\git\cmd"
if (-not (Test-Path -LiteralPath "$GitBin\git.exe" -PathType Leaf)) { throw "请核对 Portable Git 的实际解压位置，或改用 ZIP 路线" }
$env:Path = "$GitBin;$env:Path"
$SourceRoot = "$QuickstartRoot\Git 源码"
if (Test-Path -LiteralPath $SourceRoot) { throw "源码目录已存在，请换新名称，不要覆盖" }
git clone "https://github.com/a18329069309-commits/w-auto-score.git" "$SourceRoot"
if ($LASTEXITCODE -ne 0) { throw "克隆未完成，请检查网络；不要在失败目录上继续运行" }
Set-Location -LiteralPath $SourceRoot
git rev-parse HEAD
```

已安装可用 Git 时，可以省略 Portable Git 的三行设置，其他命令不变。首次克隆使用公开 `main`，其内容会随维护变化；记录实际提交哈希。复现历史版本时，应下载该提交的源码，而不是假设今天的 `main` 与旧测试相同。

### 路线 B：源码 ZIP，无需 Git

在 [公开仓库](https://github.com/a18329069309-commits/w-auto-score)选择 **Code → Download ZIP**，另存到 D 盘 `downloads`，并将文件名整理为 `w-auto-score-main.zip`。不要下载其他人的影片或素材包。然后执行：

```powershell
$ZipFile = "$QuickstartRoot\downloads\w-auto-score-main.zip"
$ZipRoot = "$QuickstartRoot\ZIP 源码"
if (-not (Test-Path -LiteralPath $ZipFile -PathType Leaf)) { throw "请先将公开源码 ZIP 保存到上述 D 盘位置" }
if (Test-Path -LiteralPath $ZipRoot) { throw "解压目录已存在，请换新名称，不要覆盖" }
Expand-Archive -LiteralPath $ZipFile -DestinationPath $ZipRoot
$SourceRoot = "$ZipRoot\w-auto-score-main"
if (-not (Test-Path -LiteralPath "$SourceRoot\package.json" -PathType Leaf)) { throw "请核对 ZIP 的真实顶层目录，并修改 SourceRoot" }
Set-Location -LiteralPath $SourceRoot
```

GitHub 分支 ZIP 通常有 `w-auto-score-main` 顶层；固定提交 ZIP 的目录名不同，需按实际情况替换。源码 ZIP 没有 `.git` 是正常情况，下面的离线命令不依赖 Git。记录下载来源、日期和 `package.json` 版本；需要固定版本时，从仓库对应提交页面下载其源码，不要混用分支 ZIP 的版本结论。

## 4. 离线检查与固定编排演示

完成准备后，在包含 `package.json` 的源码目录执行。以下命令只使用已准备的本地依赖；不安装、下载或提交模型请求：

```powershell
node tools/check-public.mjs
if ($LASTEXITCODE -ne 0) { throw "公开文件检查失败，请停止并阅读输出" }
node tools/doctor.mjs --json
if ($LASTEXITCODE -ne 0) { throw "环境检查失败，请按 doctor 的 action 修复，不要跳过检查" }
node tools/demo-offline.mjs
if ($LASTEXITCODE -ne 0) { throw "演示失败，请保留报告并按下文排查" }
```

`doctor` 只检查本地能力，不创建任务或写入授权、资格、听审记录，不搜寻默认私人配置。JSON 字段的含义：

| 字段 | 正确解释 |
| --- | --- |
| `ok` | 本次请求的检查中没有失败；显式 profile 检查失败也会使其为 false |
| `offline_ready` | 离线依赖检查通过，尚未执行演示；可能在 profile 失败时仍为 true |
| `profile_checked` | 是否显式提供了 `--profile`，**不是**“profile 已通过”；具体结果看 `checks` 中 `deployment_profile` |
| `automatic_readiness: "unverified"` | 完整自动模式未验证，不能根据 `ok` 或 `offline_ready` 宣称已就绪 |

默认演示顺序处理两段各 **3 秒**的合成片，调用现有 `renderPlan` 渲染器。画面是纯色切换，声音是合成音调，避让区间的“对白”是音调代理，不是真人对白。演示不分析新影片剧情、不自动选曲、不执行听审、生产上传或持久队列端到端恢复。

成功命令的 stdout 是一份 JSON，包含实际 `output` 目录。默认在项目 `.muse/` 新建独立目录，每片输出 `preview.mp4`、`final-mix.wav`、`episode-report.json`，以及 `render/` 下的 `bgm.wav`、`sfx.wav`、`ambience.wav`、`accompaniment.wav`。可以用本地播放器查看三秒预览，但能播放不等于听感认可。

### 中文与空格路径：单片自定义输出

父目录需提前存在，末级目录必须是新名称；工具不会创建自定义父目录。以下显式创建父目录，只运行单片，不预建末级目录：

```powershell
$OutputParent = "$QuickstartRoot\演示 输出"
if (-not (Test-Path -LiteralPath $OutputParent)) { New-Item -ItemType Directory -Path $OutputParent | Out-Null }
if (-not (Test-Path -LiteralPath $OutputParent -PathType Container)) { throw "输出父路径不是目录" }
$DemoOutput = "$OutputParent\单片 首次运行"
if (Test-Path -LiteralPath $DemoOutput) { throw "末级目录已存在，请把 DemoOutput 换成新名称，不要覆盖" }
node tools/demo-offline.mjs --episodes 1 --out "$DemoOutput"
if ($LASTEXITCODE -ne 0) { throw "单片演示失败，请保留现场和报告" }
Get-Content -LiteralPath "$DemoOutput\demo-report.json" -Raw
```

重复执行时把 `单片 首次运行` 换成新名称。不要删除旧记录来把失败伪装成首次通过，也不要向已有用户任务目录输出。

### 报告与失败恢复

根 `demo-report.json` 汇总每片状态，单片报告含文件哈希、解码时长、采样峰值、合成避让和固定切点的技术测量：

| 字段／现象 | 含义与下一步 |
| --- | --- |
| `status: "technical_ok"` | 仅本次固定合成案例通过技术检查，不代表真实配乐或听审通过 |
| `status: "failed"` | 至少一片失败；查看 `episodes` 的 `error`、`message`、`action`，不得把整个批次算作通过 |
| `creative_review: "not_performed"`、`audible_sync_review: "not_performed"` | 未进行艺术评审和实际听声同步评审 |
| `production_approval: false` | 没有生产批准，不要改成 true 或冒用为资格记录 |
| stderr 首行 `EEXIST` | 目标末级目录已存在；换新名称，不覆盖旧目录 |
| stderr 首行 `ENOENT` | 所需路径不存在；核对路径并显式准备父目录；不代表一定缺少 FFmpeg |
| `demo_child_failed_exit_*` 或其他逐片失败 | 不公开原始子进程输出；先运行 `node tools/doctor.mjs`，查看保留报告，再在新目录重试；通用失败不能确定是哪项依赖故障 |

参数、路径保护错误或逐片失败均返回非零退出码。顶层异常发生在输出目录建立之前时，可能没有报告；stderr 第一行保留安全错误码，后续给出固定中文说明和下一步。逐片失败仍继续尝试下一片，并保留现场；失败行与落盘报告一致。不要删除资格、预算或路径门禁来消除错误。

演示和测试使用 Node 层网络拦截，并清理继承的模型相关环境变量。这不是操作系统级禁网沙箱，也不是独立抓包证明；不能阻止任意外部程序联网。演示只启动既有本地媒体工具，不启动模型、账户或下载程序。

## 5. 离线回归与完整模式边界

```powershell
node tools/test-offline.mjs
if ($LASTEXITCODE -ne 0) { throw "回归失败，请保留本地日志并提交脱敏最小复现" }
```

日志和汇总保存在项目 `.muse/`，跳过项单独报告，不算通过。包含真实 FFmpeg 合成媒体渲染与失败保护测试；数量和实际环境见 [验证记录](VALIDATION.md)。不要直接公开原始日志，请使用 [贡献指南](../CONTRIBUTING.md)的脱敏模板。

带自己的影片前先读 [部署说明](DEPLOYMENT.md)。公开预览尚未提供从零到真实新片自动配乐的完整验收路线，仍需自备获准素材库、可用运行时、预算、实际证据绑定和真实听审资格。没有可作为生产凭据的测试 fixture，也不能用别人的测试结果替代本机、本片的真实记录。

已有真实配置时可只读检查；先将下列路径替换为自己的实际 D 盘 JSON：

```powershell
node tools/doctor.mjs --profile "D:\自己的部署\deployment.json" --json
```

该步骤不上传影片、执行推理、验证素材权利或听感；结构与已有绑定通过不等于完整运行时、账户、资格或新片验收通过。不要公开部署文件、机器路径或素材库。

## 开源实现与素材来源

演示复用本仓库已有渲染入口和 [FFmpeg 开源项目](https://github.com/FFmpeg/FFmpeg)，测试信号参考 [FFmpeg 官方滤镜文档](https://ffmpeg.org/ffmpeg-filters.html)。没有新增 FFmpeg 包装依赖、第三方影视或歌曲；工具许可取决于实际构建，见 [第三方说明](../THIRD_PARTY_NOTICES.md)。
