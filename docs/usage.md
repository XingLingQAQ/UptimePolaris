# 使用手册

[English](#english)

完成[部署与初始化](deployment.md)后，通过 `/admin` 管理监控与状态页，公开首页 `/` 默认匿名访问。

## 目录

- [添加监控与参数边界](#添加监控与参数边界)
- [监控类型](#监控类型)
- [附加检查（SSL、域名到期、DNS）](#附加检查ssl域名到期dns)
- [Push 被动上报](#push-被动上报)
- [Agent 主机与代理探测](#agent-主机与代理探测)
- [分组、标签与通知范围](#分组标签与通知范围)
- [公开页面、域名与维护窗口](#公开页面域名与维护窗口)
- [账号、站点图标与安全](#账号站点图标与安全)
- [状态定义与公开数据脱敏](#状态定义与公开数据脱敏)

## 添加监控与参数边界

在 `/admin` 的监控管理页面新增监控，填写名称、类型、目标与检查参数，保存后等待首次调度，或对后端原生主动监控点击“立即检查”。

- **Worker 范围**：检查间隔 `60–86400` 秒，超时 `1000–60000` 毫秒。
- **Go 范围**：检查间隔 `5–86400` 秒，超时 `100–120000` 毫秒。
- 站点设置中的默认间隔和超时仅预填新建表单；“失败确认次数”在运行时对全部监控生效。
- 暂停监控会停止探测并从公开页隐藏；删除监控会清除历史与事件，但不影响关联 Agent。

## 监控类型

### HTTP

配置目标 URL、请求方法（`GET`、`POST`、`PUT`、`PATCH`、`DELETE`、`HEAD`、`OPTIONS`）、预期状态码（如 `200-299` 或 `200,301,302`）、请求头、正文、Basic/Bearer 认证、JSON 路径或响应头断言、最大延迟阈值和检查来源。

跨源重定向注意：跳转跨源时仅保留 `Accept` 和 `User-Agent`，剥离自定义请求头与认证信息，并拒绝跨源保留正文或 HTTPS 降级。需要认证或正文的接口，请直接填写最终 URL。Worker 从 Cloudflare 边缘节点发起探测，内网目标需选用可访问该目标的 Agent 作为检查来源。

### TCP

目标格式为 `host:port`。默认检测端口连通性；填写发送内容与期望响应后可校验业务应答。

### UDP 与 ICMP Ping

- **Worker**：UDP 与 ICMP 必须选用在线且具备对应能力的 Agent 作为检查来源。
- **Go**：原生支持 UDP；宿主机具备原始套接字权限时原生支持 ICMP。
- **UDP**：目标为 `host:port`，支持 UTF-8 文本或十六进制负载（上限 4096 字节），需收到目标返回报文才算正常。
- **ICMP**：目标为主机名或 IP（Linux Agent 需原始套接字权限，Windows Agent 通常需管理员权限）。

### Go 原生 DNS、TLS 与 WebSocket

仅 Go 后端支持以下三种独立类型：
- **DNS**：目标为主机名，使用系统解析器或指定 `host:port` / DoH 地址，支持 `A`、`AAAA`、`CNAME`、`MX`、`TXT`、`NS` 及子串匹配。
- **TLS**：目标为 `host:port`，可配置 SNI 与证书到期预警天数。
- **WebSocket**：目标为 `ws://` 或 `wss://` URL，可配置请求头、发送消息与预期回复。

### AI 模型

AI 渠道与模型在独立的 **AI 监控** 页面管理，详见 [AI 模型监控](ai-monitoring.md)。

## 附加检查（SSL、域名到期、DNS）

Worker 可在 HTTP/TCP 监控下挂载附加检查；Go 还支持挂载在 UDP、TLS 和 WebSocket 下。附加检查与主检查并行，耗时不计入主检查延迟。

| 检查项 | 说明 |
| --- | --- |
| **SSL 监控** | 监测证书剩余天数（预警默认 14 天，可设 `1–365`）。Worker 基于公开证书透明度（CT）日志查询，不校验证书链与实时端口；Go 和 Agent 每日执行真实 TLS 握手，同时校验证书链、有效期与主机名。 |
| **域名到期** | 查询注册商公开的域名到期时间。 |
| **DNS** | 支持 `A`、`AAAA`、`CNAME`、`MX`、`TXT`、`NS` 与期望子串匹配。Worker/Agent 默认使用 `https://cloudflare-dns.com/dns-query`，Go 默认使用系统解析器。 |

## Push 被动上报

适用于定时任务、备份脚本与只出不进的内网设备。新建 **Push** 监控后，将页面生成的上报地址与 `PUSH_TOKEN` 配置到脚本定时发送 `POST`：

```sh
curl --fail-with-body -X POST \
  'https://status.example.com/api/public/push/MONITOR_ID' \
  -H "Authorization: Bearer $PUSH_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"status":1,"message":"backup-ok"}'
```

- `status`：整数 `1`（正常）、`0`（故障）、`2`（警告），省略时默认 `1`；`message` 最多 200 个 Unicode 字符。
- 成功返回 `200 {"ok":true}`；超过监控设置的心跳期限未收到上报则标为异常。Push 不测延迟。

## Agent 主机与代理探测

在 **Agent 管理** 添加机器仅做登记，安装并启动 `polaris-agent`（见 [Agent 手册](agents.md)）后：
- 新增 **Agent 主机** 监控并关联该机器，即可监控在线状态与 CPU、内存、磁盘（百分比）及 1 分钟负载（原值，不按核数折算），支持配置持续时间与恢复比例以减少阈值抖动。
- 在其他主动监控的“检查来源”中选择该机器，即可由它代为探测内网服务。

## 分组、标签与通知范围

监控分组用于状态页分类展示与通知路由，监控标签用于筛选。开启机器公开页后，后台还会提供机器分组和同名合并的通用分组。

**注意**：删除分组会将其成员移至未分组，并清除通知渠道上的对应关联。如果某个通知渠道的分组列表因此变空，该渠道会转为接收**全部监控**的通知；调整分组后需复核通知配置。

## 公开页面、域名与维护窗口

| 页面 | 路径 | 开关位置 |
| --- | --- | --- |
| 主监控状态页 | `/` | 始终开启 |
| 机器状态页 | `/servers`、`/server/:id` | 设置 → 展示设置 |
| AI 模型页 | `/ai` | 设置 → 展示设置 |

- **独立域名**：先完成 DNS 与后端域名绑定，再在展示设置中将主机名（不含协议、端口、路径）映射到目标页面。域名映射在至少开启一个可选页面（机器页或 AI 页）后生效；各域名的后台登录会话相互独立。
- **机器公开页**：支持搜索、筛选、地图视图、2–4 台机器对比与历史导出；可在列表控制单台机器是否公开展示。主题安装与自定义见[主题指南](themes.md)。
- **维护窗口**：在 **设置 → 维护** 开启手动维护或配置 UTC 计划维护（单次或每周，可跨午夜）。进入维护后公开页切换为维护页，监控探测与 Agent 上报照常运行，自动通知暂缓。

## 账号、站点图标与安全

- **站点图标**：在 **设置 → 站点** 可直接上传图标（最大 256 KB），优先级高于配置项中的图标路径。
- **公开 Agent 网卡与挂载点**：在 **设置 → 站点** 提供“公开展示 Agent 网卡与挂载点详情”开关（默认关闭），控制监控详情页（`/monitor/:id`）中的 Agent 视图是否展示 `tailscale0`、`docker0` 等网卡名与磁盘挂载路径（不影响 `/servers` 机器页）；仅建议私有或受访问控制保护的实例开启。
- **账号管理**：在 **设置 → 账户** 修改用户名（`2–32` 位小写字母、数字或 `._-`）、密码（修改后其他设备会话立即失效）及个人头像（PNG/JPEG/WebP，最大 5 MB）。
- **安全与限流**：在 **设置 → 安全** 调整会话有效期、登录失败限流及“允许远程 Agent 指令”开关。忘记密码处理见[常见问题](troubleshooting.md#忘记管理密码)。

## 状态定义与公开数据脱敏

- **状态含义**：`UP`（正常）、`DOWN`（故障或失联）、`WARN`（资源或证书预警）、`PENDING`（待首次有效结果）、已暂停（不参与可用率统计）。可用率按实际观测分钟计算，`WARN` 与 `PENDING` 计入可用，缺口不按正常补齐，分析时需结合覆盖率查看。
- **公开数据脱敏**：匿名接口自动剥离 HTTP 目标中的凭据、查询参数与 fragment，隐藏监控在公开列表、汇总和详情接口均返回排除或 `404`。监控名称、分组名与保留路径仍会公开，Agent Token、私有请求头和认证配置永不外泄。

## English

After [deployment and setup](deployment.md#english), manage monitors at `/admin`. The public page `/` is anonymous by default.

### Contents

- [Creating monitors and limits](#creating-monitors-and-limits)
- [Monitor types](#monitor-types)
- [Add-on checks (SSL, domain expiry, DNS)](#add-on-checks-ssl-domain-expiry-dns)
- [Push monitoring](#push-monitoring)
- [Agent hosts and probe sources](#agent-hosts-and-probe-sources)
- [Groups, tags, and alert scope](#groups-tags-and-alert-scope)
- [Public pages, domains, and maintenance](#public-pages-domains-and-maintenance)
- [Account, site icon, and security](#account-site-icon-and-security)
- [Status rules and data redaction](#status-rules-and-data-redaction)

### Creating monitors and limits

Create monitors under `/admin`, then wait for the next cycle or click **Check now** for backend-run active monitors.

- **Worker**: interval `60–86400` s, timeout `1000–60000` ms.
- **Go**: interval `5–86400` s, timeout `100–120000` ms.
- Default interval and timeout prefill new forms only; failure confirmation retries apply across all monitors at runtime.
- Pausing stops checks and hides the monitor publicly; deleting permanently clears history and events without removing linked Agents.

### Monitor types

#### HTTP

Configure URL, method (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`), expected status codes (`200-299` or `200,301,302`), headers, body, Basic/Bearer auth, JSON or response-header assertions, max latency, and check source.

Cross-origin redirects strip auth and custom headers (keeping only `Accept` and `User-Agent`) and reject body preservation or HTTPS downgrades; supply the final URL directly when auth or a body is required. Use an online Agent source for private-network endpoints when running on Worker.

#### TCP

Target `host:port`. Checks port reachability by default, with optional send/expect payload matching.

#### UDP and ICMP Ping

- **Worker**: requires an online Agent advertising `probe_udp` or `probe_icmp`.
- **Go**: runs UDP natively and supports native ICMP when raw-socket privileges pass at startup.
- **UDP**: `host:port` target with UTF-8 or hex payload (up to 4096 bytes); requires a reply packet.
- **ICMP**: hostname or IP (Linux Agents need raw-socket privileges; Windows Agents typically require Administrator elevation).

#### Go-native DNS, TLS, and WebSocket

Available on Go only:
- **DNS**: hostname target with system or custom `host:port`/DoH resolver (`A`, `AAAA`, `CNAME`, `MX`, `TXT`, `NS`, substring match).
- **TLS**: `host:port` target with optional SNI and expiry threshold.
- **WebSocket**: `ws://` or `wss://` URL with optional headers, send payload, and expected reply.

#### AI models

Managed on the dedicated **AI monitoring** page; see [AI monitoring](ai-monitoring.md#english).

### Add-on checks (SSL, domain expiry, DNS)

Attachable to HTTP/TCP on Worker (and also UDP/TLS/WebSocket on Go). Add-ons run alongside the primary check without adding to primary latency.

- **SSL**: default 14-day warning (`1–365`). Worker queries public CT logs without verifying trust chains or live handshakes; Go and Agents perform a daily TLS handshake verifying chain, expiry, and hostname.
- **Domain expiry**: queries public registration expiration dates.
- **DNS**: `A`, `AAAA`, `CNAME`, `MX`, `TXT`, `NS` with substring match (`https://cloudflare-dns.com/dns-query` default on Worker/Agent; system resolver default on Go).

### Push monitoring

For cron jobs, backups, and outbound-only hosts. Save a Push monitor to obtain its reporting URL and `PUSH_TOKEN`:

```sh
curl --fail-with-body -X POST \
  'https://status.example.com/api/public/push/MONITOR_ID' \
  -H "Authorization: Bearer $PUSH_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"status":1,"message":"backup-ok"}'
```

`status` accepts `1` (up, default), `0` (down), or `2` (warning); optional `message` allows up to 200 Unicode characters. Missed deadlines mark the monitor `DOWN`. Push does not measure latency.

### Agent hosts and probe sources

After installing `polaris-agent` ([Agent guide](agents.md#english)):
- Add an **Agent** monitor for uptime and resource rules (CPU/memory/disk % and unnormalized 1-minute load with duration and recovery hysteresis).
- Pick the Agent as **Check source** on other monitors to probe internal networks.

### Groups, tags, and alert scope

Groups organize status pages and notification scope; tags classify items. Enabling the machine page adds agent and common groups. **Deleting a group moves members to ungrouped and removes channel scope links—if a channel's group list becomes empty, it switches to matching all monitors.**

### Public pages, domains, and maintenance

- `/` (monitors, always on), `/servers` & `/server/:id` (machines, opt-in), `/ai` (AI models, opt-in).
- Configure DNS and backend domain bindings before mapping hostnames (host only, no scheme/port/path) in Presentation settings (domain mappings take effect once the machine or AI page is enabled). Admin sessions are per domain.
- Public machine pages support search, filters, map view, 2–4 machine comparison, and CSV export. See [Themes](themes.md#english) for customization.
- Enable manual or UTC `once`/`weekly` maintenance schedules under **Settings → Maintenance**. Public routes display the maintenance page while checks, Agent reports, and `/admin` continue and automatic alerts pause.

### Account, site icon, and security

- **Site icon**: upload an icon (up to 256 KB) under **Settings → Site**, overriding the path setting.
- **Public Agent interfaces & mounts**: under **Settings → Site**, **Show Agent network interfaces and disk mounts publicly** defaults to off to avoid exposing interface names (`tailscale0`, `docker0`) or mount paths on monitor detail pages (`/monitor/:id`, without affecting `/servers`); enable only on private or access-controlled instances.
- **Account**: update username (`2–32` lowercase letters, digits, or `._-`), password (invalidates other sessions), and avatar (`PNG`/`JPEG`/`WebP`, up to 5 MB) under **Settings → Account**.
- **Security**: adjust session TTL, login throttling, and `Allow remote Agent commands` under **Settings → Security**. See [Troubleshooting](troubleshooting.md#english) for lost passwords.

### Status rules and data redaction

- `UP`, `DOWN`, `WARN`, `PENDING`, and Paused (excluded from SLA). Availability counts observed minutes only (`WARN` and `PENDING` count as available); always read coverage alongside availability.
- Public endpoints strip HTTP URL credentials, query strings, and fragments, exclude hidden monitors (`404`), and never expose Agent tokens, private headers, or auth settings. Keep secrets out of names and URL paths.
