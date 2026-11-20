# 订阅公开监控

Uptime Polaris 能读别的站点公开的网站状态和模型状态，汇总到自己的页面里。打开“订阅 → 订阅仓库”，选一个配置，预览条目，再保存订阅。网站和模型分开管理；订阅模型之前要先在设置里开启 AI 监控。

## 从仓库添加

1. 在订阅仓库里选通用模板或站点配置。默认接入[官方仓库](https://github.com/XingLingQAQ/UptimePolaris-Subscriptions)。
2. 填数据地址和模板参数。Uptime Kuma 要的是状态页的基础地址和 slug，比如 `https://status.example.com/status/main` 对应基础地址 `https://status.example.com`、slug `main`。
3. 点“读取预览”，核对名称、状态、时间和错误提示，勾选要订阅的条目。
4. 设置名称、分组、公开范围和通知，然后创建。

新订阅默认不公开，监控告警和同步告警也默认关着。第一次读取只用来建立基线，不会把来源里已有的故障报出来。开了“自动订阅新增条目”以后，新条目还是保持私有。

公开的网站页和模型页按订阅分组，每组可以折叠。打开“设置 → 站点 → 同步监控网站图标”后，订阅来源也会去取图标，取不到就保留默认图形。取图标只读公开的 HTTPS 地址，不带订阅凭据。

仓库连不上时，页面继续用缓存和内置的 Kuma 模板。已有订阅跑的是本地保存的描述文件，不依赖每轮重新下载仓库。

## 导入自定义接口

支持 HTTPS 链接、上传 JSON 和粘贴 JSON。普通的 GitHub 文件链接会自动换成分支上的原始文件地址；其他网页请直接给 JSON 直链。导入的文件存在本地配置库，之后能反复拿来建订阅。移除本地配置不会删掉已经建好的订阅。

描述文件用 `schemaVersion: 1`，完整格式见 [JSON Schema](../shared/subscription.schema.json)。里面写清楚输入参数、只读请求、条目身份、状态和时间映射。接口支持 GET、只读 POST、JSON 响应、有界分页和跨请求关联。不知道从哪下手，就复制官方仓库的 `json-website`、`json-model` 或 `statuspage` 模板来改。

请求地址必须是公开主机名加 HTTPS。认证值声明成 `secret` 输入，走参数表单填写，导出的描述文件里不含这些值。改了秘密参数发往的来源，凭据要重新填。

`sourcePage` 用来指定公开列表里“来源”链接指向的状态页，例如 `{"baseUrlInput":"baseUrl","path":"/status/{slug}"}`。路径参数不能引用秘密输入；不配置时只显示来源名称。条目自己的网址和描述文件下载地址不会拿来顶替状态页。

Worker 部署保留 `global_fetch_strictly_public` 兼容标记，外部请求先查公开 DNS，实际连接走 Cloudflare 隔离的公网出口。Go 会校验 DNS 结果，连的是校验过的地址。自托管 workerd 要保留公网出口限制，别为了订阅请求给内网权限。

条目 ID 选来源里稳定的那个。名称会改，不能拿来当身份。来源会标“过期”“暂停”这类有效性时，可以用 `observations.currentWhen` 声明判断条件，条件不满足的条目显示数据已过期，保留最后一次有效观测。

```json
{
  "currentWhen": {
    "op": "eq",
    "path": "$.live.freshness",
    "value": "current"
  }
}
```

上面只是 `observations` 里的一个字段，不是完整的描述文件。条件支持 `eq`、`in`、`exists` 和 `and`，作用在目录里的当前条目上。

## 周期、时间和历史

同步周期可设 60～86400 秒。模板可以让目录和状态用不同周期，比如 Kuma 目录每 300 秒、心跳每 60 秒。点“立即同步”会请求刷新，但来源的限流照样生效。

心跳按来源给的探测时间判断是否有效。Kuma 一般建议 300 秒，实际填多少按来源的探测间隔来。快照按成功获取的时间判断。同步成功只说明读到了数据，来源报告的服务状态是另一回事；同步失败也不会把条目全改成故障。

每个条目保留最近 60 条观测和最多 90 天的日汇总。心跳的正常率只统计收到的观测；快照只记首次获取和状态变化，不按轮询次数算可用率。来源自己给的可用率会单标窗口，不和本地探测的 SLA 混在一起。

429 和临时错误会退避重试，认 `Retry-After`。认证和格式错误低频重试，需要管理员看参数或映射。同步记录里能看到获取、解析和保存三个阶段，大来源分批保存，中断后能接着提交。

## 更新配置与恢复

在“接口配置”里检查更新，比较描述，预览后应用。运行时不自动套用远端改动。同一个版本内容却不一样时会提示冲突，这时候你核对一下来源。

打开订阅列表会按需检查配置更新，同一份配置的结果缓存 24 小时。发现更新后列表上有比较入口；手动检查最快 60 秒一次。外部文件支持 ETag 和 Last-Modified 条件请求。

改了条目身份或数据来源，预览会列出新旧 ID。你明确关联的条目保留历史，没关联的旧条目归档，新条目重新建基线。上一份有效配置可以从“预览上一版”恢复，恢复同样要预览并确认身份关系。凭据不跟着描述版本回退。

远端同步会保留本地的名称、分组、排序、公开和静默设置。取消订阅某个条目，它就停止追加观测，也退出公开展示；归档整个订阅会停掉同步和通知，历史留下。永久删除会连同配置、历史和待发通知一起清掉。

## 通知与密钥备份

监控告警管来源条目的故障、降级和恢复；同步告警管 Polaris 读不到来源。两者各自配置，同步告警默认等连续异常 300 秒。静默条目只关掉这个条目的监控告警。

走全局规则时，通知渠道要允许“外部订阅”和对应的事件类别。指定渠道会绕过全局范围，但渠道的启用状态、维护和通知开关照样生效。接收预览不发消息，测试通知会真发。详见[通知配置](notifications.md)。

Worker 用部署的 `ADMIN_TOKEN` 加密订阅凭据和响应缓存，备份、迁移都得带上它。Go 复用 AI 凭据的密钥：SQLite 默认在数据目录建 `ai-credential.key`，PostgreSQL 要配 `POLARIS_AI_KEY_FILE`。密钥文件是 32 字节，和数据一起备份。密钥丢了就恢复原文件，或者重新配置订阅；换成新密钥解不开旧数据。

---

## English

Uptime Polaris reads public website and model status published by other sites and folds it into your own page. Open **Subscriptions → Subscription library**, pick a configuration, preview the items and save. Websites and models are managed separately, and model subscriptions need AI monitoring enabled first.

### Add from the library

1. Choose a generic template or a site configuration in the library. The default library is the [official repository](https://github.com/XingLingQAQ/UptimePolaris-Subscriptions).
2. Fill in the data address and template parameters. Uptime Kuma takes a status-page base URL and slug: `https://status.example.com/status/main` means base URL `https://status.example.com` and slug `main`.
3. Select **Read preview**, check names, states, timestamps and any errors, then tick the items to subscribe.
4. Set the name, group, public scope and notifications, then create.

New subscriptions are private, with monitor and sync alerts off. The first read only establishes a baseline and does not report outages the source already had. With automatic subscription to new items enabled, new items still stay private.

Public website and model pages group items by subscription, and each group folds. With **Settings → Site → Sync monitor icons** enabled, sources also get their favicons; missing ones keep the default glyph. Icon requests read public HTTPS addresses and carry no subscription credentials.

When the library is unreachable, the page keeps using its cache and the built-in Kuma template. Existing subscriptions run on locally saved descriptors and do not re-download the library each cycle.

### Import a custom interface

HTTPS links, uploaded JSON and pasted JSON are all accepted. A regular GitHub file link becomes its raw address automatically; for other pages, provide a direct JSON link. Imported files live in the local configuration library and can be reused for more subscriptions. Removing a local configuration does not delete subscriptions created from it.

Descriptors use `schemaVersion: 1`; the full format is in the [JSON Schema](../shared/subscription.schema.json). They describe inputs, read-only requests, item identity, and status and time mappings. Interfaces may use GET, read-only POST, JSON responses, bounded pagination and cross-request joins. The quickest way in is copying the `json-website`, `json-model` or `statuspage` template from the official repository.

Request addresses must use public hostnames over HTTPS. Declare credentials as `secret` inputs and fill them in the parameter form; exported descriptors omit them. Changing where a secret is sent means entering it again.

`sourcePage` sets the status page the public "source" link points at, for example `{"baseUrlInput":"baseUrl","path":"/status/{slug}"}`. Its path cannot reference secret inputs, and without it only the source name is shown. An item's own URL and the descriptor's download address do not stand in for the status page.

Worker deployments keep the `global_fetch_strictly_public` compatibility flag: requests check public DNS first and connect through Cloudflare's isolated public egress. Go validates DNS results and connects to the validated address. Self-hosted workerd must keep public-only egress; do not grant intranet access for subscriptions.

Pick a stable source ID for each item. Names change and cannot serve as identity. When a source marks items expired or paused, `observations.currentWhen` can test that condition; items failing it show stale data and keep their last valid observation.

That snippet is one field inside `observations`, not a complete descriptor. Conditions support `eq`, `in`, `exists` and `and`, evaluated against the current item in the directory.

### Intervals, time and history

Sync intervals run from 60 to 86400 seconds. A template can use different intervals for metadata and state, such as Kuma's 300-second directory read and 60-second heartbeat read. **Sync now** asks for a refresh, and source rate limits still apply.

Heartbeats use the source's probe time to judge freshness; Kuma typically suggests 300 seconds, so match the source's real probe interval. Snapshots use the time of a successful fetch. A successful sync only means data arrived: whether the service the source reports is healthy is a separate question, and a failed sync does not turn every item into a failure.

Each item keeps its last 60 observations and up to 90 daily summaries. Heartbeat availability counts only observations that arrived; snapshots record the first fetch and later state changes and do not estimate probe counts. Availability the source provides keeps its own window and is never merged into a local probe SLA.

429s and transient errors back off and honour `Retry-After`. Auth and format errors retry rarely, because they need an administrator to fix parameters or mappings. Sync records show the fetch, parse and save phases; large sources save in batches and resume after an interruption.

### Update and recover configuration

Under **Interface configuration**, check for updates, compare descriptors, preview and apply. The runtime never applies remote changes on its own. When the same version carries different content, the page reports a conflict, and you decide which side is right.

Opening the subscription list checks for configuration updates on demand and caches each result for 24 hours. An available update links to the comparison screen; manual checks are limited to one per 60 seconds. External files support ETag and Last-Modified conditional requests.

Changing item identity or the data source lists old and new IDs in the preview. Items you link keep their history, unlinked old items are archived, and new items start a fresh baseline. **Preview previous version** restores the last valid configuration, with the same preview and identity confirmation. Credentials do not roll back with a descriptor.

Remote sync preserves local names, groups, ordering, visibility and mute settings. Unsubscribing an item stops new observations and removes it from public pages; archiving the whole subscription stops sync and alerts and keeps history. Permanent deletion removes the configuration, history and any pending notifications.

### Notifications and key backup

Monitor alerts cover failures, degradation and recovery of source items. Sync alerts cover Polaris being unable to read the source. They are configured separately, and sync alerts wait 300 seconds by default. Muting an item turns off only its monitor alerts.

Under global rules, notification channels must allow **external subscriptions** and the matching event type. Explicit channels bypass global scope while still respecting enabled state, maintenance and notification switches. Previewing recipients sends nothing; a test notification really sends. See the [notification guide](notifications.md#notification-guide).

Worker deployments encrypt subscription credentials and response caches with the deployment's `ADMIN_TOKEN`, so back it up and carry it through migrations. Go reuses the AI credential key: SQLite creates `ai-credential.key` in its data directory, while PostgreSQL needs `POLARIS_AI_KEY_FILE`. The key is 32 bytes and must be backed up with the database. If it is lost, restore the original file or reconfigure the subscriptions; a new key cannot decrypt old data.
