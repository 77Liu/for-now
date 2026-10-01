# 火山语音与视觉接入

本文是火山豆包语音、通用文字识别和智能文档解析的配置与验证入口。真实密钥不得写入 Git、聊天、日志、截图或测试夹具。

## 服务与应用路径

| 服务 | 火山接口 | 应用用途 |
|---|---|---|
| 豆包 TTS 2.0 | `POST /api/v3/tts/unidirectional` | 捕念文字朗读，服务端返回 MP3 |
| 异步长文本 TTS | `POST /api/v3/tts/submit`、`POST /api/v3/tts/query` | 供应商适配器与真实冒烟；当前界面不生成长音频 |
| 豆包流式 ASR 2.0 | `wss /api/v3/sauc/bigmodel_async` | 服务端读取账户私有音频并直接分块转写 |
| 录音文件 ASR 2.0 | `POST /api/v3/auc/bigmodel/submit`、`query` | 供应商适配器与外部 HTTPS 音频冒烟 |
| 通用文字识别 | `OCRNormal / 2020-08-26` | 健康截图、书目信息的文字提取 |
| 智能文档解析 | `OCRPdf / 2021-08-23`，业务版本 `v3` | 受认证的 `/api/vision/document` 接口 |

应用不会为私有录音创建公网 URL。捕念转写使用流式 ASR；录音文件 ASR 只允许显式传入外部 HTTPS 测试地址。

## 音色

默认值固定为：

- 少年梓辛 2.0：`zh_male_shaonianzixin_uranus_bigtts`
- 音调：`0`
- 语速：`-10`
- 音量：`0`

界面同时提供：

- 云舟 2.0：`zh_male_m191_uranus_bigtts`
- Vivi 2.0：`zh_female_vv_uranus_bigtts`
- 知性灿灿 2.0：`zh_female_cancan_uranus_bigtts`

## 敏感字段

本地开发在仓库根目录创建 `.secrets/for-now.env`，并设置权限：

```bash
mkdir -p .secrets
chmod 700 .secrets
touch .secrets/for-now.env
chmod 600 .secrets/for-now.env
```

只在该文件中填写：

```dotenv
VOLCENGINE_SPEECH_API_KEY=
VOLCENGINE_ACCESS_KEY_ID=
VOLCENGINE_SECRET_ACCESS_KEY=
```

可选非密钥配置：

```dotenv
VOLCENGINE_SPEECH_PROJECT_NAME=default
VOLCENGINE_TTS_DEFAULT_VOICE=zh_male_shaonianzixin_uranus_bigtts
SPEECH_GLOBAL_QPS=5
SPEECH_GLOBAL_CONCURRENCY=5
OCR_GLOBAL_QPS=10
OCR_GLOBAL_CONCURRENCY=10
DOCUMENT_PARSE_GLOBAL_QPS=2
DOCUMENT_PARSE_GLOBAL_CONCURRENCY=2
```

`VOLCENGINE_SPEECH_API_KEY` 来自火山语音控制台的 API Key 管理页。视觉 AK/SK 来自火山引擎访问密钥管理；生产环境应优先创建最小权限子用户，不建议长期使用主账号密钥。使用 STS 临时凭据时另设 `VOLCENGINE_SESSION_TOKEN`。
语音控制台里的“名称”只是便于识别 Key 的标签，不参与接口鉴权；应用只读取
API Key 值和可选的项目名。

本地启动：

```bash
set -a
source .secrets/for-now.env
set +a
npm start
```

生产配置写入 `/etc/for-now.env`，文件必须保持 `root:root` 和 `0600`；修改后通过既有发布流程重启服务。不得把密钥写入 `deploy/for-now.env.example`。

## 验证

不访问真实供应商的契约测试：

```bash
npm run test:volcengine
```

加载本地密钥后执行真实语音测试：

```bash
set -a
source .secrets/for-now.env
set +a
npm run test:volcengine:speech
```

附加 `-- --long-text` 可同时提交并轮询异步长文本 TTS。设置 `VOLCENGINE_ASR_TEST_AUDIO_URL` 后还会提交录音文件 ASR；该 URL 必须是测试专用 HTTPS 资源，不得指向应用私有附件。

真实视觉测试：

```bash
set -a
source .secrets/for-now.env
set +a
npm run test:volcengine:vision
```

可在命令末尾传入本地图片路径；未传时脚本会在内存中生成仅含 `OCR TEST 2026` 的测试图。输出只包含成功状态、字符/页数与供应商请求 ID，不打印密钥或识别正文。

## 官方入口

- 语音 API Key：<https://console.volcengine.com/speech/new/setting/apikeys?projectName=default>
- TTS 单向 HTTP：<https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-text-to-speech-http?lang=zh>
- TTS 双向 WebSocket：<https://docs.volcengine.com/docs/DoubaoVoice/bidirectional-streaming-text-to-speech-websocket?lang=zh>
- TTS 异步长文本：<https://docs.volcengine.com/docs/DoubaoVoice/Tasksubmission?lang=zh>
- ASR 录音文件：<https://docs.volcengine.com/docs/DoubaoVoice/task-submission-http-1?lang=zh>
- ASR 流式：<https://docs.volcengine.com/docs/DoubaoVoice/bidirectional-streaming-automatic-speech-recognition-websocket?lang=zh>
- 通用 OCR：<https://docs.volcengine.com/docs/Largemodelofimagegeneration/Callingmethod?lang=zh>
- 智能文档解析：<https://docs.volcengine.com/docs/Largemodelofimagegeneration/Callingmethod-2?lang=zh>

## 2026-10-01 本地实测

- 通用 OCR：真实调用成功。
- 智能文档解析：真实调用成功。
- 录音文件 ASR `volc.seedasr.auc`：任务提交鉴权成功；未用私有附件 URL 做远端下载测试。
- TTS `seed-tts-2.0`：服务返回 `requested resource not granted`。
- 流式 ASR `volc.seedasr.sauc.duration` 与
  `volc.seedasr.sauc.concurrent`：WebSocket 握手均返回
  `requested resource not granted`。

语音 Key 格式有效，但还需要在同一项目中开通 TTS 2.0，并开通流式 ASR
小时版或并发版后重新测试。资源开通前，应用会保留语音原件并返回
`SPEECH_RESOURCE_NOT_GRANTED`，不会伪造转写结果。

资源开通生效后的复测结果：

- 默认音色及其余三种音色均成功返回 MP3。
- 流式 ASR 2.0 成功返回中文转写。
- 录音文件 ASR 2.0 完成提交、轮询与结果读取。
- 异步长文本 TTS 完成提交、轮询并返回限时下载地址。

流式 ASR 对压缩音频需要在最后一个数据分片后留出服务端处理窗口，再发送
结束包；真实测试已覆盖该时序。
