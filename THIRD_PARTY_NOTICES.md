# Third-party notices

Muse 的自有代码署名为汪小昇。以下随包第三方代码不改署名，原许可证和文件内声明保持有效。

| 组件 | 目录与原始许可 | 固定来源 |
| --- | --- | --- |
| audfprint | `scripts/reference_fingerprint/upstream/LICENSE`，MIT | [dpwe/audfprint](https://github.com/dpwe/audfprint)，commit `cb03ba99feafd41b8874307f0f4e808a6ce34362` |
| candidate comparison | `scripts/reference_fingerprint/candidate_upstream/LICENSE`，MIT | [Snoop2023/video-background-music-identification-skill](https://github.com/Snoop2023/video-background-music-identification-skill)，commit `ad61b9753be54f86048faee9383e8963705f2cb7` |

`upstream/audio_read.py` 等文件还含 librosa、audioread 等原始声明，须随该文件保留。固定来源与哈希另见两个目录中的 `UPSTREAM.json`；上游测试状态不代表 Muse 已通过对应集成验证。

Node.js、Python、FFmpeg、Python 扩展库及可选模型由使用者单独安装，不作为本源码包内的二进制分发。可选工具所需环境因路线而异，不能用某个 CUDA 研究环境的依赖文件代表整个项目。FFmpeg 的许可依所用构建而定。

本仓库不分发歌曲、音效库、影视素材、训练数据或模型权重，不授予它们的使用或再分发权。组件代码开放不意味着其模型、数据或云服务也免费或可商用。
