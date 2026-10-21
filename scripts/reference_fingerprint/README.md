# 本地参考片段指纹定位

固定 [dpwe/audfprint `cb03ba99feafd41b8874307f0f4e808a6ce34362`](https://github.com/dpwe/audfprint/tree/cb03ba99feafd41b8874307f0f4e808a6ce34362)。`upstream/`保留原始5个Python模块和[LICENSE](upstream/LICENSE)，未修改上游代码；来源在[UPSTREAM.json](upstream/UPSTREAM.json)。本入口只索引manifest明确列出的源范围，再查实际音频片段；不会扫描磁盘、访问网络或下载模型。

识别的是同一录音及其源内位置。返回不能证明剧情适配、歌词含义、音乐质量或另一首同风格曲目。公开包尚未使用可公开的授权素材重跑本组件；没有随包提供可复核的成功率、混音鲁棒性或生产可用性结论。未公开素材上的内部结果不作为公开验证证据。

运行前按仓库依赖说明准备包含numpy、scipy、psutil、librosa、soundfile的Python环境，并确认所选环境可以导入这些依赖。入口通过librosa解码，调用原始audfprint的landmark、hash表和时间匹配；不下载模型权重，不保证所有音频／视频格式都可解码。本说明没有在公开素材上重跑安装或格式兼容性验证。

## 明确索引manifest

自行创建manifest，仅列出有权处理的本地素材、实际sha256和可解码范围。公开包不提供私有曲库manifest、音频或成片。结构如下；路径、摘要及范围均须替换为自己的真实值，不能直接执行占位示例：

```json
{"assets": [{"asset_id": "unique-source-id", "path": "./media/source.wav", "sha256": "REPLACE_WITH_REAL_SHA256", "source_range": [0, 70]}]}
```

`source_range`按完整源秒数，必须可解码，不能超源尾。索引绑定音频sha256、范围、上游commit及索引sha256。固定参数sr11025、density20、index shift1、hashbits18／depth20，适用于有限验证；大曲库容量／hash丢弃与误报率未验证，不直接扩成全库生产服务。

## 手工运行示例（PowerShell）

以下命令从仓库根目录运行。先准备自己的`media/source.wav`、`media/query.wav`和`local-fingerprint/manifest.json`，并按实际素材调整源范围及查询起止；示例查询要求查询文件至少可解码8秒。`python`须指向已准备的环境，也可将`$fpPython`改为该环境的解释器路径。示例不会取得素材或替你确认许可。

```powershell
$fpPython = 'python'
$fpToolDir = Join-Path (Get-Location) 'scripts/reference_fingerprint'
$fpWorkDir = Join-Path (Get-Location) 'local-fingerprint'
$fpIndex = Join-Path $fpWorkDir 'index.pklz'
& $fpPython -X utf8 "$fpToolDir/reference_fingerprint.py" build --manifest "$fpWorkDir/manifest.json" --index $fpIndex --out "$fpWorkDir/build.json"
& $fpPython -X utf8 "$fpToolDir/reference_fingerprint.py" match --index $fpIndex --query './media/query.wav' --source-in-seconds 0 --source-out-seconds 8 --out "$fpWorkDir/match.json"
```

match采用query shift4、window2、minimum5 consistent hashes。`query_start_maps_to_source_seconds`映射查询片段开头到完整库源时间；`matched_query_support_seconds`是这8秒查询内有一致指纹支持的范围，不自动代表整个query都匹配。成片区间的查询起止按query文件完整时间。

build另写`index.manifest.json`，match读取侧车及索引hash后执行。没有结果时`matches=[]`，不猜歌名、不用相似曲替代。先检查JSON里的源范围／hash／一致hash数和实际声音。

## 公开验证状态与边界

状态：未使用公开授权素材重跑。上述命令是手工运行方法，不是已执行记录；公开包不包含私有录音、成片、索引或内部验证报告。尚不能给出公开可复核的检出率、误报率、噪声／变速／混音鲁棒性或规模化容量结论。

后续验证应使用有权公开的素材及可追溯身份，分别记录同源干净片段、未入库负例、噪声、变速和叠加混音条件，保留输入范围、索引参数、预期真值、原始回包与失败项。少量负例不能推算规模化误报率，失败不能删除或改称通过；公开结果须先确认素材及报告允许分发。

查询没有命中时先检查目标录音是否实际入库、源范围与查询范围是否正确，再区分负例和鲁棒性失败。目标源未入库的零结果不能证明系统能处理该源的混音条件；干净同源对照通过也不等于成片混音通过。

本组件是可单独调用的局部工具；主runner不会自动建立索引、选择调用窗口或采用音乐。manifest、索引侧车和匹配报告会记录本地路径及素材身份，公开前须逐项审查；不要提交私有素材、索引、缓存或本地验证工件。上游原始代码、`upstream/LICENSE`及`upstream/UPSTREAM.json`身份声明应原样保留。
