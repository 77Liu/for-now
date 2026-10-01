# 第三方服务统一实测

本文是 DeepSeek、火山引擎和阿里云运行时能力的统一真实冒烟入口。测试只使用
脚本生成的合成文字、音频和图片，不读取用户记录或私有附件。

## 统一入口

默认命令只检查测试计划和当前进程可见的配置，不发送第三方请求：

```bash
npm run test:third-party
```

真实调用必须显式加入 `--live`：

```bash
set -a
source .secrets/for-now.env
set +a
THIRD_PARTY_DEEPSEEK_SETTINGS_FILE=data/llm-settings.json \
  npm run test:third-party -- --live
```

`THIRD_PARTY_DEEPSEEK_SETTINGS_FILE` 是显式选择项，用于读取本机受保护设置文件中
的 `apiKey`；也可直接注入 `DEEPSEEK_API_KEY`。脚本不会输出密钥、请求正文或
识别正文。

## 固定测试矩阵

| 服务 | 每轮最小调用 | 成功证据 |
| --- | --- | --- |
| DeepSeek | 1 次 Flash 短文本 | 返回非空正文、官方 usage 和请求 ID |
| 火山豆包语音 | 1 次 TTS、1 次流式 ASR | MP3 非空，转写非空 |
| 火山智能视觉 | 1 次通用 OCR、1 次智能文档解析 | OCR 文字和文档 Markdown 非空 |
| 阿里云图片分割 | 1 次提交及必要轮询、1 次结果下载 | 返回有效 PNG |
| 阿里云 OSS | 1 次临时对象写入、鉴权读取、匿名读取检查和删除 | 内容一致、匿名非 200、删除后 404 |

脚本固定预留 `¥2.30`，`THIRD_PARTY_TEST_MAX_CNY` 默认且最高只能设为 `3`。
这是调用次数保护值，不是账单金额承诺。真实金额仍须在供应商控制台按请求 ID
和账单延迟核对。

缺少某服务凭据时，该项标记为 `not_configured`；真实请求失败时标记为
`failed`。`--live` 下只要存在未通过项，进程退出码为 `2`，不得将部分通过
表述为全链路通过。

## 凭据与环境边界

- 火山语音使用 `VOLCENGINE_SPEECH_API_KEY`。
- 火山视觉使用 `VOLCENGINE_ACCESS_KEY_ID` 和
  `VOLCENGINE_SECRET_ACCESS_KEY`。
- 阿里云图片分割与 OSS 使用 ECS RAM Role 或阿里云标准凭据链。
- OSS 还要求 `OSS_ATTACHMENT_BUCKET` 和 `OSS_ENDPOINT`。
- 本地密钥文件必须位于 `.secrets/`、权限 `0600` 且被 Git 忽略。
- 生产环境只读核对不得输出值；在生产执行分割或 OSS 写读删测试仍属于生产
  写操作，必须另有当次授权。

## 2026-10-01 收口实测

本机统一脚本真实运行结果：

| 服务 | 结果 | 摘要 |
| --- | --- | --- |
| DeepSeek | 通过 | Flash 返回 2 字符；输入 7 Token、输出 1 Token |
| 火山豆包语音 | 通过 | TTS 返回 27,117 字节；流式 ASR 返回 15 字符 |
| 火山智能视觉 | 通过 | OCR 1 行/9 字符；文档解析 1 页/9 字符 |
| 阿里云图片分割 | 未配置 | 本机无 ECS RAM Role 或阿里云标准凭据链 |
| 阿里云 OSS | 未配置 | 本机无 RAM Role，且不从生产导出临时凭据 |

生产 `/etc/for-now.env` 在 v0.3.0 发布前已补齐火山语音/视觉凭据、项目名
和默认音色，文件保持 `root:root 0600`，配置值未进入日志或 Git。部署
`e3a7da5c7a66d0f1c3d86b565b90832b5ffaa616` 后统一脚本在 ECS 真实运行：
DeepSeek、豆包 TTS/流式 ASR、火山 OCR/智能文档解析、阿里图片分割和 OSS
5/5 通过。OSS 合成探针完成私有写入、鉴权读取、匿名 403 与删除后不存在
验证；固定预留仍为 ¥2.30，实际账单金额待供应商控制台延迟出账。
