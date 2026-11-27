# AI 模型监控

[English](#english)

在后台 `/admin/ai` 管理渠道与模型，Worker 和 Go 后端均支持。首次使用需先在 **设置 → 展示设置** 开启“启用 AI 监控”。

## 添加渠道与模型

1. 在 `/admin/ai` 添加渠道，选择协议并填写名称、基础地址与 API Key（基础地址保留版本路径即可，勿追加生成接口路径）。
2. 可选点击“检查连接”获取模型列表（不消耗文本生成费用）；不支持列表接口的中转站可直接手动输入模型 ID。
3. 在渠道下添加模型（或使用“从渠道导入”批量勾选），填写模型 ID、提示词、输出上限、期望文本、检查间隔和是否公开。

### 支持的协议与基础地址

| 协议 | 基础地址示例 | 自动追加路径 | 模型 ID 示例 |
| --- | --- | --- | --- |
| OpenAI Chat Completions | `https://api.openai.com/v1` | `/chat/completions` | `gpt-4.1-mini` |
| OpenAI Responses | `https://api.openai.com/v1` | `/responses` | `gpt-4.1-mini` |
| Anthropic Messages | `https://api.anthropic.com/v1` | `/messages` | `claude-sonnet-4-5` |
| Gemini generateContent | `https://generativelanguage.googleapis.com/v1beta` | `/models/模型ID:generateContent` | `gemini-2.5-flash` |

接入要点：
- **地址范围**：支持 HTTP、HTTPS、内网及容器服务名（`localhost` 指后端服务器，非本地浏览器），拒绝文件路径、URL 内嵌凭据、查询参数和云元数据地址；公网服务请使用 HTTPS。
- **中转站与 Gemini**：选填中转站实际兼容的协议；Gemini 模型 ID 填纯名称（不带 `models/`）。切换渠道协议会影响全部下属模型，切到 Gemini 前先调整不兼容的模型 ID。
- **自定义请求头**：支持键值或 JSON（总长 ≤64 KiB），值加密保存；禁止覆盖认证头、`Content-Type`、`Host`、`Cookie` 和连接控制头。
- **探测参数与请求体**：默认每 `300` 秒检查（`60–86400`），超时 `30` 秒（`1–60` 且小于间隔），非流式发送 `Reply OK.`（≤2000 字符）且限制输出 `64` tokens（`1–4096`）。期望文本按区分大小写的子串匹配。部分推理模型若将输出预算全耗在思考上会导致无可见输出报错，调高输出上限即可。自定义请求体（≤64 KiB JSON）会递归合并到默认载荷（Gemini 参数放 `generationConfig`）。

**费用提示**：定时检查属于真实 API 调用（每 5 分钟一次每天约 288 次），具体账单按渠道单价计费；手动检查不计入定时可用率与状态条。

## 结果、通知与公开展示

- **延迟与状态**：延迟统计完整响应耗时（非首字延迟）；自动区分鉴权失败、权限不足、模型不可用、限流、额度不足、超时与响应不匹配。修改名称、公开状态或通知保留历史状态条；改地址、协议或模型等探测参数后重新累计。
- **通知路由**：在渠道中指定通知渠道时下属模型共用；留空走全局规则（发往未限定分组的已启用渠道）。
- **公开页**：公开模型展示在 `/ai`（可映射独立域名），开启“在主监控页显示 AI 模型”后同步出现在 `/`；在 **主题管理 → AI 模型展示页** 可自定义布局与显示字段。公开数据仅含分组用的渠道 ID 和名称，勿在名称中写入敏感内容。

## 密钥保存与恢复

API Key 保存后不再回显，编辑渠道留空即可保留原密钥。

| 部署方式 | 加密密钥 | 备份要求 |
| --- | --- | --- |
| Worker | 复用 `ADMIN_TOKEN` | 与数据库、KV 一起备份 |
| Go + SQLite | 数据目录自动生成的 `ai-credential.key` | 随数据目录一起备份 |
| Go + PostgreSQL | `POLARIS_AI_KEY_FILE` 指定的 32 字节原始随机文件 | 多实例共用同一文件；SQLite 迁入时沿用原 `ai-credential.key` |

`POLARIS_AI_KEY_FILE` 必须是 **32 个原始随机字节**（非口令/Hex/Base64），POSIX 权限 `0600`，Windows 收紧 ACL，禁止符号链接。若密钥丢失且无备份，需重新配置密钥并逐个重填 API Key。

## English

Manage AI channels and models under `/admin/ai` (supported on both Worker and Go). Enable **AI monitoring** under **Settings → Presentation** first.

### Add a channel and model

1. Create a channel with protocol, base URL (keep version prefix, omit generation path), and API key.
2. Optionally run **Check connection** to fetch models without text-generation charges, or enter model IDs manually.
3. Add models individually or via **Import from channel**, then configure prompt, max tokens, expected text, interval, and visibility.

| Protocol | Example base URL | Appended path | Example model ID |
| --- | --- | --- | --- |
| OpenAI Chat Completions | `https://api.openai.com/v1` | `/chat/completions` | `gpt-4.1-mini` |
| OpenAI Responses | `https://api.openai.com/v1` | `/responses` | `gpt-4.1-mini` |
| Anthropic Messages | `https://api.anthropic.com/v1` | `/messages` | `claude-sonnet-4-5` |
| Gemini generateContent | `https://generativelanguage.googleapis.com/v1beta` | `/models/MODEL_ID:generateContent` | `gemini-2.5-flash` |

Key notes:
- Supports HTTP, HTTPS, private hosts, and container names (`localhost` is the backend host); rejects file paths, URL credentials, query strings, and metadata IPs.
- Gemini model IDs omit `models/`; fix incompatible IDs before switching a channel to Gemini.
- Custom headers (≤64 KiB JSON) are encrypted and cannot override auth, `Content-Type`, `Host`, `Cookie`, or connection headers.
- Intervals span `60–86400` s (default `300`), timeouts `1–60` s (default `30`), default prompt `Reply OK.`, default limit `64` tokens (`1–4096`). Reasoning models that spend the entire limit thinking require a higher token limit. Custom request JSON (≤64 KiB) merges recursively (put Gemini options in `generationConfig`).
- **Billing**: scheduled checks make real API calls; manual checks do not count toward scheduled history or availability.

### Results, alerts, and visibility

- Measures full-response latency (not TTFT) and distinguishes auth, permission, missing model, rate limits, quota exhaustion, timeouts, and mismatches.
- Set notification channels on the AI channel or leave empty for global ungrouped rules.
- Public models appear at `/ai` (and `/` if enabled), customizable under **Themes → AI model page**. Keep secrets out of channel and model names.

### Key backup and recovery

- **Worker**: uses `ADMIN_TOKEN`.
- **Go + SQLite**: auto-creates `ai-credential.key` in data dir.
- **Go + PostgreSQL**: requires `POLARIS_AI_KEY_FILE` containing **32 raw random bytes** (`0600` on POSIX, restricted ACLs on Windows, no symlinks; reuse `ai-credential.key` when migrating from SQLite).

Back up keys with the database; lost keys require provisioning a new key and re-entering channel API keys.
