# 公开版验证记录

版本：0.1.0-preview.1；日期：2026-10-22。

本次实际运行：Windows、Node.js 24.19.0、FFmpeg 9.0.1。6 个测试文件共 73 项：72 通过、0 失败、1 跳过，约 14 秒。具体计时受机器影响，不是影片处理耗时或产能指标。

跳过项：`test_sound_edit_decision_contract.mjs` 中需要真实 CLI fixture 的集成用例。未配置私人 fixture，不把它算作通过。本次不读取私人部署，也不产生模型调用。

新增离线运行器首次运行因 Windows `--import` 绝对路径格式错误而失败，已改用 file URL 后重跑得到上述结果；没有修改业务断言来让测试通过。静态检查和语法检查范围另行记录，不等同完整安全审计。

发布前静态检查：原 339 个公开文件的常见凭据、机器路径、二进制及相对 JS 依赖检查为 0 问题；另复核 JSON 转义 Windows 路径的检测回归。新增抽帧回归后共 340 个公开文件，重新执行同一检查。人工复核未发现新增私人材料，但不宣称已排除一切未知敏感信息或安全问题。

语法检查：原 207 个 MJS 的 `node --check` 与 104 个 Python 的 AST 解析均通过；新增回归和修改的 MJS 另经 `node --check` 通过，共 312 个源文件。Python 检查不导入业务模块、不写入 pyc；语法通过不等于可选运行时、依赖和完整功能已验证。

6 个文件覆盖持久批处理队列、音乐弧线、音频渲染、音乐编辑动作契约、声音编辑决策契约，以及非方形像素抽帧。测试使用合成输入与替身，不调用真实模型。复现命令：`node tools/test-offline.mjs`；日志和机器结果生成于被 Git 忽略的 `.muse/`。

首次 [Ubuntu CI](https://github.com/a18329069309-commits/w-auto-score/actions/runs/39640636388) 为 70 通过、1 失败、1 跳过：FFmpeg 6.1.1 缺少 `scale:reset_sar` 参数。Windows 的 FFmpeg 9.0.1 支持该参数，说明本机通过并不能代表 Linux 兼容。修复按输入显示宽高比计算有界尺寸并用 `setsar=1` 输出方形像素；保留原抽帧选择和 PTS，不删除或跳过失败的真实 PCM 用例。新增 5 组合成画面检验横竖屏、非方形像素、1280 边界、帧时间与时长。表达式依据 [FFmpeg 6.1 官方 scale 文档](https://github.com/FFmpeg/FFmpeg/blob/n6.1/doc/filters.texi)。[修复后 Ubuntu CI](https://github.com/a18329069309-commits/w-auto-score/actions/runs/39641592037) 已实际完成：72 通过、0 失败、1 跳过，所有工作流步骤成功；[品牌更新后的 CI](https://github.com/a18329069309-commits/w-auto-score/actions/runs/39645901096) 也复现了同样结果。

尚未验证：公开素材的新片自动分析、真实选曲及听审、跨机器完整部署、全部可选 Python/模型路线、桌面安装。离线技术通过不等于听感通过。
