# AI 模型监控

[English](#english)

在后台的 **AI 监控** 页面管理渠道和模型。一个渠道保存接口地址和 API Key，渠道下的每个模型单独检查、单独记录状态。Worker 和 Go 后端都能用。

第一次使用，先在“设置 → 展示设置”里打开“启用 AI 监控”。关掉开关会停止定时检查、Queue 里的 AI 任务和手动调用，渠道、模型和历史都保留。升级前已经有渠道的站点，升级后保持启用；新装的站点默认关闭。

## 添加渠道和模型

1. 打开 `/admin/ai`，添加渠道，选择接口协议，填写名称、基础地址和 API Key。基础地址保留版本路径，不要附加生成接口路径，示例见下表。
2. 保存后可以点“检查连接”请求模型列表，这一步不生成文本。渠道没有模型列表接口时显示“不支持模型列表”，它只说明列表查不到，模型能不能用要看模型自己的检查结果。
3. 进入渠道添加模型，填显示名称和渠道实际接受的模型 ID。列表里的模型不会自动全部监控，需要哪个加哪个。
4. 设置提示词、输出上限、期望文本、间隔、超时和是否公开，然后保存。默认每 300 秒检查一次，超时 30 秒。间隔可设 60～86400 秒，超时 1～60 秒，并且要短于间隔。

也可以点“从渠道导入”，读取模型列表后勾选多个模型，一次设好间隔、启用和公开状态。获取列表不调用模型，导入并启用后才开始定时检查。单加模型时可以从同一个列表里选 ID，列表不可用就手动填。

渠道可以加自定义请求头，比如网关身份验证或 OpenAI 组织标识：

```json
{
  "OpenAI-Organization": "org-example",
  "CF-Access-Client-Id": "example-client-id",
  "CF-Access-Client-Secret": "example-client-secret"
}
```

请求头可以用键值行或 JSON 编辑，条数不限。值加密保存，再打开渠道编辑器会带回已保存的值，不需要重填。删光所有行或提交空对象就清除了。整个 JSON 不超过 64 KiB，名称不超过 64 个字符，单个值不超过 2048 个可打印 ASCII 字符。认证头、`Content-Type`、`Host`、`Cookie` 和连接控制类请求头不能覆盖。API Key 还是填在专用字段，保存后不回显。

基础地址支持 HTTP、HTTPS、本机和内网，例如 `http://127.0.0.1:11434/v1`，或者容器网络里的 `http://ollama:11434/v1`。`localhost` 指向执行检查的后端，不是浏览器所在的电脑：Go 能连到服务器访问得到的内网服务，云端 Worker 连不到你的本机，要填它能访问的地址。

HTTP 会明文传输密钥，公网服务请用 HTTPS。文件路径、URL 里的凭据、查询参数和片段都不支持，云元数据地址也会被拒绝。

| 接口协议 | 基础地址示例 | 自动追加的生成路径 | 模型 ID 示例 |
| --- | --- | --- | --- |
| OpenAI Chat Completions | `https://api.openai.com/v1` | `/chat/completions` | `gpt-4.1-mini` |
| OpenAI Responses | `https://api.openai.com/v1` | `/responses` | `gpt-4.1-mini` |
| Anthropic Messages | `https://api.anthropic.com/v1` | `/messages` | `claude-sonnet-4-5` |
| Gemini generateContent | `https://generativelanguage.googleapis.com/v1beta` | `/models/模型ID:generateContent` | `gemini-2.5-flash` |

用中转渠道时，填中转地址，并选它实际支持的协议。模型 ID 以渠道给的为准。Gemini 只填模型名称，不带 `models/` 前缀或其他路径。改渠道协议会影响这个渠道下的所有模型，切到 Gemini 之前先把格式不对的模型 ID 改好。请求失败后不会自动换协议重试。

检查发的是非流式文本生成请求。默认提示词是 `Reply OK.`，最多 2000 个字符；输出上限默认 64 tokens，可设 1～4096。期望文本留空时，有效且非空的回复就算通过；填了之后，回复要包含这段文本，区分大小写，不支持正则。对不上时显示“响应不匹配”。

模型的“自定义请求体（JSON）”用来加协议参数，也可以替换默认消息。OpenAI 兼容接口可以这样填：

```json
{
  "temperature": 0.2,
  "top_p": 0.9,
  "messages": [
    { "role": "system", "content": "Answer briefly." },
    { "role": "user", "content": "Reply OK." }
  ]
}
```

对象和默认请求体递归合并，数组整体替换。模型 ID、非流式模式和输出上限仍以表单为准，Responses 始终带 `store: false`。Gemini 的生成参数放在 `generationConfig` 里，支持哪些参数取决于渠道和模型。请求体最多 64 KiB，填 `{}` 可清除附加参数。手动和定时检查用同一份配置。

推理内容、拒绝块和工具调用都不算文本输出。Responses 的 `incomplete` 结果要带可见文字才算通过，失败或还在处理的不通过。部分推理模型把输出上限耗在思考上，最后没有可见文字，这时显示“返回结果无效”。调高上限通常能解决，但会更贵。图片、音频和流式输出不检查，换个渠道或模型都要单独看。

OpenAI 协议用 Bearer 认证；Anthropic 用 `x-api-key` 和 `anthropic-version: 2026-10-21`；Gemini 用 `x-goog-api-key`，密钥不放进 URL。请求格式见 [OpenAI Responses](https://developers.openai.com/api/reference/resources/responses/methods/create)、[Anthropic Messages](https://platform.claude.com/docs/en/api/messages) 和 [Gemini generateContent](https://ai.google.dev/api/generate-content)。

**定时检查是真实的 API 调用，会产生费用。** 每 5 分钟检查一个模型，一天最多 288 次。表单只显示每日计划次数，不算金额：实际花多少看渠道单价和输入输出。手动检查要单独确认费用，也不计入定时历史和可用率。

## 查看结果

模型列表显示定时检查的结果、检查时间和完整响应耗时，不是首字延迟。认证失败、没有权限、模型或接口不可用、已知限流、已知额度不足、超时和无效响应分别有各自的标签。原因不明的 HTTP 429 只显示请求或额度受限。

渠道的连接结果和模型结果分开算。暂停、改配置等下次检查、请求预算用完、密钥不可用、渠道冷却、结果过期，这些情况不会显示成正常，也不会记成一次模型故障。过期时仍能看到上次实际检查的时间和结果。

后台和公开页的可用性条显示最近最多 60 次定时检查。手动检查和没执行的轮次不计入，空位也不会补成正常。改名称、公开设置或通知渠道不会清空状态条；只有探测配置变了，才从新配置的检查重新积累。

“检查记录”能切换最近 7、30、90 个 UTC 自然日，包含当天。可用率 = 成功次数 ÷ 实际检查次数，没执行的检查不进分母，缺的时段也不补。Worker 的明细来自 Analytics Engine，可能有延迟，也可能是采样数据；每日汇总是精确计数。明细暂时读不到时，已有的汇总和状态条照常显示。

## 通知与公开展示

在 AI 渠道设置里选通知渠道，这个渠道下的模型共用这项设置。留空时走全局规则：AI 告警发给没有限定监控分组的已启用渠道。选了之后就只发到这些渠道，不再按分组筛。故障确认阈值和维护窗口沿用站点设置，状态变化时发故障或恢复通知；停用的渠道不会收到。

勾选“公开”并启用的模型可以显示在独立 AI 页面，也能显示在主监控页。展示设置里的“在主监控页显示 AI 模型”控制是否参与主监控页的统计和筛选；关掉后独立页面照常可用。

独立页面在 `/ai`，也可以给“AI 展示页域名”配一个单独域名。先做完 DNS 和部署侧的域名绑定，再保存映射。进入“主题管理 → AI 模型展示页”配置标题、说明、颜色、宽度、列表或卡片布局、密度、列数和显示内容，预览后保存。

内置 AI 页默认用列表，访客选的视图和主监控页分开记。模型按渠道分组，每组有状态汇总，可以折叠；搜索渠道名会列出对应模型并展开分组。展开检查记录时，历史内容和模型区域同宽。

关闭公开或暂停后，匿名访问就读不到这个模型和历史了。公开数据里只有用于分组的渠道 ID 和渠道名称，没有渠道地址、API Key、自定义请求头、提示词、匹配文本和供应商响应正文。模型名和渠道名会公开，别把密钥或敏感内容写进名称。

## 密钥保存与恢复

保存后的 API Key 不再显示。编辑渠道默认沿用原密钥，点“替换 API Key”才更新。删除渠道会连带删掉下面的模型。

| 部署方式 | 加密材料 |
| --- | --- |
| Worker | 使用已有 `ADMIN_TOKEN`，不需要新增 AI Secret；数据库和 `ADMIN_TOKEN` 一起备份 |
| Go + SQLite | 第一次保存渠道密钥时，在数据目录建立 `ai-credential.key`；随数据目录一起备份 |
| Go + PostgreSQL | 首次添加渠道前，通过 `POLARIS_AI_KEY_FILE` 指定受保护的密钥文件；所有实例用同一份 32 字节内容 |

Go 的显式密钥文件装的是 **32 个原始随机字节**，不是 32 位的密码，也不是十六进制或 Base64 文本。用密钥管理工具生成文件，比如挂到 `/run/secrets/polaris-ai-key`，再设置：

```dotenv
POLARIS_AI_KEY_FILE=/run/secrets/polaris-ai-key
```

POSIX 上文件权限设为 `0600`，只让运行账号读写。Windows 上收紧 DACL，只给运行账号和 SYSTEM 需要的权限，不能用符号链接。这个文件单独备份，不要提交到 Git。SQLite 换到 PostgreSQL 时保留原来的 `ai-credential.key`，把它当作目标实例的显式密钥文件。

恢复时把数据库和加密材料一起恢复。文件丢了不会自动生成一个新的来冒充原密钥，先从备份恢复。实在恢复不了，就配置新的受保护材料，再一个个换掉渠道 API Key。别用轮换 Worker `ADMIN_TOKEN` 的方式修 AI 密钥：它还保护初始化时的选库记录。

## English

Manage channels and models on **AI monitoring** at `/admin/ai`. A channel holds a base URL and API key; every model under it has its own schedule and results. Both the Worker and the Go backend support this.

Turn on **AI monitoring** under presentation settings the first time you use it. Switching it off stops scheduled checks, queued AI tasks and manual calls, and keeps channels, models and history. Sites that already had channels stay enabled after an upgrade; new sites start disabled.

### Add a channel and model

1. Add a channel, pick its protocol, and enter a name, base URL and API key. Keep the version path in the base URL and do not append a generation endpoint. See the table below.
2. **Check connection** requests the model list without generating text. When a channel has no list endpoint, the page shows that the list is unsupported; whether a model works still comes from that model's own checks.
3. Open the channel and add the models you want, using the exact model ID the channel accepts. Models in the list are not enabled automatically.
4. Set the prompt, output limit, expected text, interval, timeout and visibility, then save. Defaults are 300 seconds and a 30-second timeout. Intervals run from 60 to 86400 seconds, timeouts from 1 to 60 seconds and must be shorter than the interval.

**Import from channel** reads the list, lets you tick several models, and applies one interval, enabled state and visibility. Reading the list does not call a model; scheduled checks start once an import is enabled. The single-model editor can pick an ID from the same list, or you can type one when the list is unavailable.

Custom headers cover cases like gateway authentication or an OpenAI organization ID. Edit them as key/value rows or JSON, with no limit on the number of entries. Values are encrypted, and reopening the channel editor brings them back so you don't retype them. Delete every row or submit an empty object to clear them. The whole JSON is capped at 64 KiB, names at 64 characters, and each value at 2048 printable ASCII characters. Authentication, `Content-Type`, `Host`, `Cookie` and connection-control headers cannot be overridden. The API key stays in its own field and is not shown after saving.

Base URLs accept HTTP, HTTPS, local and private hosts, such as `http://127.0.0.1:11434/v1` or `http://ollama:11434/v1` on a container network. `localhost` means the machine running the check, not your browser: Go reaches services its server can see, while a cloud Worker cannot reach your computer and needs an address it can open. HTTP sends the key in clear text, so use HTTPS for public services. File paths, credentials in the URL, query parameters and fragments are not supported, and cloud metadata addresses are rejected.

| Protocol | Example base URL | Appended generation path | Example model ID |
| --- | --- | --- | --- |
| OpenAI Chat Completions | `https://api.openai.com/v1` | `/chat/completions` | `gpt-4.1-mini` |
| OpenAI Responses | `https://api.openai.com/v1` | `/responses` | `gpt-4.1-mini` |
| Anthropic Messages | `https://api.anthropic.com/v1` | `/messages` | `claude-sonnet-4-5` |
| Gemini generateContent | `https://generativelanguage.googleapis.com/v1beta` | `/models/MODEL_ID:generateContent` | `gemini-2.5-flash` |

For a gateway, enter its base URL and the protocol it actually serves. Use the model IDs the channel provides. Gemini takes the bare model name without `models/` or another path. Changing a channel's protocol affects every model in it, so fix incompatible IDs before switching to Gemini. A failed request does not fall back to another protocol or retry elsewhere.

Checks send a non-streaming text request. The default prompt is `Reply OK.` and allows up to 2000 characters. The output limit defaults to 64 tokens and accepts 1 to 4096. With expected text empty, any valid nonempty reply passes; with text set, the reply must contain it exactly, case-sensitive, without regular expressions. A mismatch shows a response-mismatch result.

**Custom request body (JSON)** adds protocol options or replaces the default messages. Objects merge recursively and arrays are replaced. The model ID, non-streaming mode and output limit still come from the form, and Responses always sets `store: false`. Put Gemini options in `generationConfig`; what a channel supports depends on the channel and model. The body is capped at 64 KiB, and `{}` clears it. Manual and scheduled checks share one configuration.

Reasoning, refusal blocks and tool calls are not text output. A Responses `incomplete` result passes only with visible text; failed or pending ones do not. Some reasoning models spend the whole limit thinking and return no visible text, which shows as an invalid response. Raising the limit usually fixes it and costs more. Images, audio and streaming are not checked, and one model's result says nothing about another.

OpenAI protocols use Bearer authentication. Anthropic uses `x-api-key` and `anthropic-version: 2026-10-21`. Gemini uses `x-goog-api-key` and never a key in the URL. Request references: [OpenAI Responses](https://developers.openai.com/api/reference/resources/responses/methods/create), [Anthropic Messages](https://platform.claude.com/docs/en/api/messages), [Gemini generateContent](https://ai.google.dev/api/generate-content).

**Scheduled checks are real API calls and cost money.** A five-minute interval means up to 288 calls per model per day. The form shows planned call counts, not a price: the bill depends on the channel's rates and on input and output. Manual checks ask for confirmation separately and stay out of scheduled history and availability.

### Read results

The model list shows scheduled results, check times and full-response duration, not time to first token. Authentication, permission, missing model or endpoint, known rate limits, known quota exhaustion, timeouts and invalid responses each get their own label. An unexplained HTTP 429 only says the request or quota was limited.

Channel connection results are separate from model results. Paused models, models waiting for a check after a config change, runs skipped for lack of request budget, unavailable keys, channel cooldowns and stale results never appear healthy and are not counted as model failures. Stale results still show the last actual check time and outcome.

Status rails in the console and on the public page show up to 60 scheduled checks. Manual checks and skipped rounds are excluded, and gaps are not filled in as healthy. Renaming a model, changing its visibility or changing notification channels keeps the current rail; only probe configuration changes start a fresh rail.

**Check history** covers 7, 30 or 90 UTC calendar days including today. Availability is successes divided by actual checks; skipped checks stay out of the denominator and gaps are not filled. Worker details come from Analytics Engine and may arrive late or be sampled, while daily summaries are exact counts. When details are temporarily unavailable, existing summaries and rails stay visible.

### Alerts and public visibility

Choose notification channels in the AI channel settings, and every model in that channel shares the choice. Leaving it empty follows global rules: AI alerts go to enabled channels with no monitor-group restriction. An explicit choice sends only to those channels and skips group filtering. Failure confirmation and maintenance windows follow site settings, and state changes send failure or recovery alerts; disabled channels receive nothing.

Enabled models marked public appear on the separate AI page and, optionally, on the main status page. **Show AI models on the main status page** controls whether they count in that page's statistics and filters; switching it off leaves the standalone page working.

The standalone page lives at `/ai`, or you can map a separate AI domain after setting up DNS and the deployment-side binding. Under **Themes → AI model page**, set the title, description, colors, width, list or card layout, density, columns and visible fields, preview, then save.

The built-in AI page defaults to a list and remembers its view separately from the main status page. Models are grouped by channel, each group showing a state summary and folding on demand; searching a channel name lists its models and opens the group. Expanded history spans the same width as the model area.

Making a model private or pausing it removes anonymous access to it and its history. Public data includes channel IDs and names for grouping, and nothing else from the channel: no URL, key, custom headers, prompt, matching text or provider response body. Model and channel names are public, so keep secrets out of them.

### Protect and restore keys

A saved API key is never shown again. Editing a channel keeps the current key unless **Replace API key** is selected. Deleting a channel deletes its models.

| Deployment | Encryption material |
| --- | --- |
| Worker | The existing `ADMIN_TOKEN`; back it up together with the database |
| Go with SQLite | `ai-credential.key` is written to the data directory on the first channel-key save; back it up with the data |
| Go with PostgreSQL | Set `POLARIS_AI_KEY_FILE` before adding a channel; every instance uses the same 32-byte material |

A Go key file holds **32 raw random bytes**, not a password, hex string or Base64 text. Provision it with your secret tooling, for example by mounting it at `/run/secrets/polaris-ai-key`, then set `POLARIS_AI_KEY_FILE` to that path. On POSIX the file must be readable only by the runtime account (`0600`). On Windows, restrict the DACL to the runtime account and SYSTEM, and do not use symlinks. Back the file up on its own and keep it out of Git. When moving from SQLite to PostgreSQL, keep the original `ai-credential.key` and use it as the explicit key file on the new instance.

Restore the database and its encryption material together. A missing file is never silently replaced with a fresh key: restore the backup first. If recovery is impossible, provision new protected material and replace every channel API key. Do not rotate the Worker's `ADMIN_TOKEN` to fix AI keys; it also protects the setup database-selection records.
