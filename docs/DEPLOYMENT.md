# 完整自动运行的配置边界

如果只是首次安装或想查看实际渲染输出，先按 [快速开始](QUICKSTART.md) 执行 `node tools/doctor.mjs` 和 `node tools/demo-offline.mjs`。这条离线演示路线不需要下列生产资料，也不替代完整自动模式。

本源码预览保留实际生产研究链，但不是无配置即用的服务。单片入口形状为：

```sh
node scripts/compose_uploaded_episode.mjs --profile ABSOLUTE_DEPLOYMENT_JSON --video ABSOLUTE_VIDEO --out ABSOLUTE_NEW_OUTPUT
```

批量入口把 `--video` 替换为 `--batch ABSOLUTE_BATCH_JSON`。批次仅提供作品身份与影片，不预先填写歌曲、逐段 cue 或编辑结果。

执行前至少准备：

1. Node.js 24.x、Python、FFmpeg 和 ffprobe；具体 Python 库随启用的检索、观察或渲染路线安装，仓库不提供假装覆盖全部路线的统一 requirements。
2. 自己获准使用的素材库、索引、实际源窗与真实许可记录。独立音乐包与参考原曲是不同路线，不混用授权。
3. 明确的模型/宿主运行时、可用能力、预算及数据上传范围。源码预览不附账户、订阅会话或 API 密钥，不承诺完整自动模式零成本。
4. 与实际库和策略对应的 `consumer_publication` 及 SHA-256 绑定；运行时会校验一致性。不要用占位哈希或伪造的“已批准”JSON绕过门禁。
5. 需要实际听声的阶段应有相应可用工具及真实资格；技术诊断和待审候选不是正式听审通过。

原私人部署壳与历史授权不分发。本公开版本不自动接续私人任务。迁移已有任务时必须显式复用原策略、任务身份、证据和累计预算；不能通过换目录重新开跑已停止或耗尽预算的旧片。这是迁移要求，不代表独立副本能够识别未提供的私人历史状态。

公开副本的本地状态默认位于项目 `.muse/`。需要复用自己的项目策略时显式设置 `SDR_PROJECT_TRIAL_POLICY` 与 `SDR_PROJECT_TRIAL_ROOTS`（绝对路径 JSON 数组），同时保留原策略与证据。多个副本共用 GPU 时须将 `SDR_GPU_SLOT_ROOT` 设为同一个绝对目录，并重新生成与该目录对应的实际配置绑定；默认单槽约束不变。

通用运行时不默认加载私人导演卡或历史反馈。需要知识文件时显式配置 `knowledge_files`；离线测试会清除继承的 `SDR_*` 环境变量，避免误用私人实链路 fixture。

## 配置准备与只读检查

部署配置是生产输入，不应从演示输出或单元测试 fixture 直接拼接。准备顺序如下：

| 准备项 | 需要的真实资料 | 本轮可检查的范围 |
| --- | --- | --- |
| 基础媒体工具 | 本机 Node.js、FFmpeg、ffprobe | `doctor` 检查离线演示所需版本和能力，不自动安装 |
| 运行路线 | 自己选择的宿主/模型、Python、相应检索或观察组件 | 本轮不做模型请求；可执行文件存在不等于服务、资格或预算有效 |
| 素材与许可 | 自备合规素材库、索引、真实源窗及许可记录 | 不提供假授权，不把其他人的公开测试记录当作自己的素材证据 |
| 冻结部署 | 与实际库、策略和文件匹配的 `consumer_publication` 及哈希 | 显式提供 `--profile` 后调用现有上传配置校验器，只读校验结构和绑定 |
| 真实验收 | 获准新片、实际工具资格、执行和听审记录 | 需要另外执行和记录；离线演示不覆盖 |

已有真实部署配置时可以运行：

```sh
node tools/doctor.mjs --profile ABSOLUTE_DEPLOYMENT_JSON --json
```

该命令不会创建自动任务、生成授权记录、登记测试替身、上传影片或进行模型调用。没有提供 profile 时不会搜寻本机的私人配置。配置检查成功也不能替代曲库权利核查、资格检查、全部运行时可用性或完整新片验收。

已提供通用合成媒体的固定编排离线演示与公开复现入口。独立试验部署生成器仍要求真实运行时、素材发布、授权和证据输入，不自动填造这些记录。获准真实新片的单集及批量端到端验证仍列在路线图中；本文件不提供能冒充完整可运行配置的示意 JSON。

## 新独立部署与严格听审接口

`createIndependentTrialDeployment` 仅构建新目录。它保留 `quality_review_audio_backend` 与 `quality_review_qualification`，校验文件哈希及后端身份；严格模式要求已有、有效的 schema2 听审资格。缺项、绑定失效或目标目录已存在时拒绝构建。默认诊断模式与部署 schema1 不变，不自动开启严格听审，也不生成资格或听审批准记录。构建时记录的范围授权不是艺术认可，更不能重置或绕过旧任务的预算。

`quality_review_policy=automatic_required` 不只是一个配置开关。[预检](../scripts/post_render_quality_review.mjs) 先检查后端、真实资格及会话适配器，全部可用后才绑定当前影片的预算并完成全面检查。局部能力可用不等于整体就绪，不能回退使用其他影片的共享账本。

标准 `ApiSession` 已提供 `prepareAudioReviewRequest` 与 `exact_audio_picture_submission_v1`。首版仅登记 `gemini-3.8-flash` 的静态视频路线，固定 1 FPS、低分辨率；仅支持带同步视频的 `purpose=mix`，不接受额外 frames。准备阶段不联网；提交必须显式提供同一份准备结果。Host 路线仍明确不支持，真实服务、模型可用性、资格及完整听感没有因此获得验收。请求绑定、预算估算、最小超时和 pending 恢复规则见 [听审接口契约](AUDIO_REVIEW_CONTRACT.md)。

本轮零真实模型请求，不执行私人任务迁移，不改现用安装。测试替身和合成媒体不能作为真实资格、真实配乐质量或听审通过证明。
