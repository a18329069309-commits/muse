# 贡献指南

先按 [快速开始](docs/QUICKSTART.md) 在 D 盘普通目录准备 Node `>=24.19.0 <25`、FFmpeg 与 ffprobe，再运行 `node tools/doctor.mjs`、`node tools/check-public.mjs` 与 `node tools/test-offline.mjs`。Git 可选；源码 ZIP 可运行相同离线命令。首次复现优先使用固定合成演示，不要求真实影片或模型请求。

## 报告问题

在 [GitHub Issues](https://github.com/a18329069309-commits/w-auto-score/issues)搜索已有问题后，可使用下方模板新建反馈。不要把原始日志或完整 JSON 直接粘贴；先人工核对和删去账户、用户名、本机绝对路径、机器标识、凭据、素材位置、影片与曲库内容。用 `<PROJECT>`、`<NEW_OUTPUT>` 等占位符替代私人路径，只附解决问题所需的短摘录。发现疑似凭据泄露或安全问题时先读 [安全说明](SECURITY.md)，不要在公开 Issue 中贴秘密。

```text
标题：[离线演示/环境检查/文档] 简述单一问题

系统与版本：Windows 或 Ubuntu 版本；Node、FFmpeg、ffprobe 版本号
源码：提交哈希，或 ZIP 的下载页面、日期和 package.json 版本
依赖状态：已预装 / 按文档手工准备（不要把预装环境称为全新安装）
使用路线：Git / 源码 ZIP；是否使用中文或空格路径

最小复现：
1. 使用仓库的固定合成演示，或说明如何本地生成不含私人素材的最小输入
2. 粘贴已替换私人路径的命令，如 node tools/demo-offline.mjs --episodes 1 --out "<NEW_OUTPUT>"
3. 写出预期结果和实际结果

脱敏结果摘要：
- 退出码；stderr 第一行安全错误码及必要的固定提示
- doctor：ok、offline_ready、profile_checked、automatic_readiness，以及失败检查的 id/status/reason
- demo：整体 status；失败片段的 episode/status/error/message/action（如有）
- 是否保留本地失败目录；是否换全新末级目录重试

范围说明：这是工程复现、AI 模拟走查还是真人实际使用？有没有执行真实模型请求？
我已人工检查本帖，不含凭据、私人配置、影片、曲库、账户、本机绝对路径或原始完整日志。
```

不需要为反馈付费调用模型。`technical_ok` 不代表艺术认可；`automatic_readiness=unverified` 也不表示离线演示失败。若问题仅发生于真实部署，请先提供已脱敏的步骤和错误码，不上传配置或要求维护者接收私人影片。公开回归的跳过项需单独说明，不能算通过。

## 代码与真实性要求

请优先提交针对单一问题的小补丁，并添加离线回归测试。不要为了通过测试删除素材身份、预算、资格、源窗或听审检查。测试替身不能被登记为真实模型结果。

不要上传密钥、账户配置、私人反馈、曲库、无权公开的整片或原曲。需要讨论带画案例时先说明授权和可公开范围。不得用虚构用户、Stars、Issue 或性能结果代替真实维护。

重大结构改动先开 Issue 描述目标及迁移影响。维护者：汪小昇（GitHub: a18329069309-commits）。
