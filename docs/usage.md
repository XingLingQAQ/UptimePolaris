# 使用手册

[English](#usage-guide)

完成[部署与初始化](deployment.md)后，在 `/admin` 管理监控。公开首页 `/` 不需要登录。

## 目录

- [添加第一个监控](#添加第一个监控)
- [控制台总览](#控制台总览)
- [HTTP 监控](#http-监控)
- [TCP 监控](#tcp-监控)
- [UDP 与 ICMP Ping](#udp-与-icmp-ping)
- [Go 原生 DNS、TLS 与 WebSocket](#go-原生-dnstls-与-websocket)
- [附加检查](#附加检查)
- [Push 监控](#push-监控)
- [Agent 监控与检查来源](#agent-监控与检查来源)
- [日常管理监控](#日常管理监控)
- [监控详情与趋势](#监控详情与趋势)
- [分组与标签](#分组与标签)
- [公开页面与域名](#公开页面与域名)
- [使用公开机器页](#使用公开机器页)
- [维护窗口](#维护窗口)
- [状态与统计](#状态与统计)
- [账号与安全](#账号与安全)
- [公开数据](#公开数据)

## 添加第一个监控

1. 进入监控管理，选择新增监控。
2. 选择 HTTP，填写名称和完整 URL，例如 `https://example.com/health`。
3. 检查间隔、超时和预期状态码已有默认值，按目标调整。失败确认阈值在站点设置里统一管理。
4. 保存，等下一次调度，或点“立即检查”。
5. 打开公开页和详情，确认检查时间、状态和响应结果。

Worker 的检查间隔为 60–86400 秒，超时为 1000–60000 毫秒。Go 的检查间隔为 5–86400 秒，超时为 100–120000 毫秒。后台默认值只用于新建监控时的初始值，不会改动已有监控。`monitor.defaultRetries` 在运行时读取，用于失败确认。

“立即检查”让后端主动探测一次，不会补出过去的数据。Push 监控、Agent 主机监控和 Agent 来源监控不能同步立即检查：Agent 来源要等正常调度、机器领取任务并提交结果。表单里的“测试”只测试当前配置，Agent 来源同样不会立刻产生远端结果。

## 控制台总览

登录后从 `/admin` 进入控制台。左侧导航分为监控（总览、监控项）、配置（Agent 管理、分组、通知、主题）和设置三组，导航右上角可以随时打开公开状态页。

页面顶部的状态浮层汇总当前状态：

- 全部正常时只显示通过提示；有异常或重试中的监控时显示需要处理的条目数，并单独列出离线的 Agent。
- 在浮层里可以暂停或恢复监控、立即检查、打开详情、复制一份摘要，或把浮层固定住。
- “通知动态”只列状态翻转事件。未读数按浏览器记录，可以只看未读、全部标为已读，或暂停新动态提示 15 分钟。

首页的指标卡分别显示运行中监控的平均可用率、最近的证书或域名到期时间，以及当天发生的故障次数。第一次使用时会出现“开始使用”清单，列出添加监控、设置站点名称、配置通知和接入 Agent 四项。每一步只在部署里确实存在对应内容后才算完成，不是点过按钮就算；清单可以关闭，关闭状态按浏览器保存。

在控制台任意页面按 `Ctrl+K`（macOS 为 `⌘K`）打开命令面板，可以搜索页面、监控项和 Agent，也可以执行当前页面的快捷操作。

导航上的数字表示需要关注的数量：监控项显示异常和重试中的总数，没有异常时显示监控总数；Agent 管理显示离线台数，没有离线时显示总数。

## HTTP 监控

| 项目 | 用途与示例 |
| --- | --- |
| 目标 URL | 完整 URL，含协议和主机，可带路径和查询参数 |
| 方法 | GET、POST、PUT、PATCH、DELETE、HEAD、OPTIONS |
| 预期状态 | `200-299`，或 `200,301,302` 这类范围或列表 |
| 请求头 | 目标要求的请求头。名称会公开，不要把凭据写进去 |
| 正文 | 需要请求体的方法，按目标 API 格式填写 |
| 认证 | Basic 或 Bearer。凭据只用于这次请求 |
| JSON 断言 | JSON 路径和期望值，用来检查接口返回的业务结果 |
| 响应头断言 | 响应头名称和期望值 |
| 延迟阈值 | 可接受的响应耗时上限，单位毫秒 |
| 检查来源 | 当前后端（Worker 或 Go 后端），或在线且支持探测的 Agent |

接口返回 HTTP 200，也可能因为正文、响应头或延迟不满足断言而判为异常。先只配必要条件跑出正常基线，再逐项加断言，出问题时更容易定位。

Worker 从 Cloudflare 发起检查，和你的浏览器、内网主机不在同一个网络。目标只开放在局域网时，选一台能访问它的 Agent 作为来源。

## TCP 监控

目标写成 `host:port`。只检查端口能否连接，或发送内容并检查期望响应。连接成功只说明端口接受连接；要确认业务协议，得加相应断言。

Worker 和 Agent 的出口网络、DNS 和可达性都不同。排查时从配置的检查来源验证目标，不要只在自己电脑上测试。

## UDP 与 ICMP Ping

Worker 上的 UDP 和 ICMP 只能交给 Agent 执行。只有在线、已启用探测且具备对应能力的机器才会出现在类型选择里；选中后还要指定 Agent 来源。Agent 必须上报 `probe_udp` 或 `probe_icmp`。Go 后端直接执行 UDP；ICMP 权限在启动时实测，通过后才提供服务器 ICMP 来源。

UDP 目标填 `host:port`，发送报文支持 UTF-8 文本或十六进制，最大 4096 字节。收到目标返回的报文才算正常；预期响应可留空，也可填必须包含的内容。UDP 没有连接握手，发出报文不代表端口可用。

ICMP Ping 目标填主机名或 IP，收到匹配的 Echo Reply 才算正常。Linux Agent 需要原始套接字权限，Windows Agent 通常需要管理员权限；没有权限的 Agent 不会声明这项能力。来源离线时显示来源不可用，不会转给 Worker。

## Go 原生 DNS、TLS 与 WebSocket

Go 后端另有三种独立监控：DNS 查询、TLS 证书和 WebSocket 连接。DNS 目标填主机名，使用系统解析器或指定解析器，支持六种记录类型和预期内容。TLS 目标填 `host:port`，可配置 SNI 和到期预警。WebSocket 目标填 `ws://` 或 `wss://` URL，可设置请求头、发送消息和预期响应。

这三种类型由 Go 后端直接执行，Worker 没有对应的独立类型。

## 附加检查

Worker 的附加检查挂在 HTTP/TCP 监控下。Go 还能给 UDP、TLS 和 WebSocket 配附加检查；独立 DNS 监控的查询选项在它自己的表单里设置。

| 检查 | 配置与边界 |
| --- | --- |
| SSL 监控 | 监测证书到期时间；提前告警天数默认 14，允许 1–365 |
| 域名到期 | 查询可获得的域名注册到期信息；查询失败和未知到期日分开处理 |
| DNS | 支持 A、AAAA、CNAME、MX、TXT、NS；可指定 DoH 解析器和期望内容 |

DNS 解析器留空时，Worker 和 Agent 来源使用 `https://cloudflare-dns.com/dns-query`，Go 后端来源使用系统解析器。Go 也接受 `host:port` 或 HTTPS JSON DoH 地址。期望值按子串匹配返回内容，填写时要和记录类型对得上。

使用 Worker 来源时，SSL 监控依次查询 [ctlogs.dev](https://api.ctlogs.dev/)、[CertKit](https://www.certkit.io/tools/ct-logs/)、[CertSpotter](https://sslmate.com/ct_search_api/) 和 [crt.sh](https://crt.sh/)。四家都能匿名查询，不用注册、配密钥、自建服务或装 Agent。某个来源超时、限流、返回无效或没有匹配记录时，会在本次检查的总超时内换下一家。

这些匿名接口各自限流，ctlogs.dev 的请求还是串行的。如果查到的记录确实过期，就直接给出警告，不会为了得到正常结果去换来源。

每个监控在 UTC 当天第一次执行主检查时读取 SSL 结果。之后当天的自动和手动主检查都复用这份读数，并保留原始检查时间。成功和失败结果都会落库，进程重启后当天不会重复查询。更换目标主机后会重新检查；改了提前告警天数，状态按已有读数重新计算。HTTP/TCP 主检查、域名到期和 DNS 检查仍按各自间隔执行。

查询只认完整主机名和覆盖该主机名的单层通配符，并从结果中挑有效期已开始、起始时间最新的一张。其他子域名的证书不算，也不会为了显示正常去挑最晚到期的旧证书。上游明确报告吊销时仍保持警告。启用的来源全部不可用时显示未知，不填到期天数。请求预算不够就顺延，不记为当天已完成。

证书透明度日志可能比证书签发晚出现，也看不出网站当前实际用的是哪张证书。所以 Worker 原生 SSL 监控不验证信任链、完整吊销状态，也不检查指定端口的 TLS 配置。

Go 后端的 SSL 附加检查每天做一次真实 TLS 握手，读取正在使用的证书，校验证书链、有效期和主机名。验证失败时保留能读到的到期天数并给出警告。独立 TLS 监控按自己配置的间隔执行。

使用 Agent 来源时，支持同时执行 SSL、域名到期和 DNS 检查。SSL 通过真实 TLS 握手读取目标端口当前提供的证书，并校验证书链、有效期和主机名；验证失败时保留能读到的到期天数并给出警告。SSL 仍每天检查一次，HTTP/TCP 主检查和其他附加检查按监控间隔执行，附加检查耗时不计入主检查延迟。请升级到具备所选检查能力的 Agent；表单会区分需要升级、离线、等待首次上报和探测已关闭。

## Push 监控

Push 适合备份任务、定时任务和只能主动出网的设备。创建监控后会得到一个专属 Push 地址，任务按期向它发 **POST**：

```sh
curl --fail-with-body -X POST \
  'https://status.example.com/api/public/push/PUSH_TOKEN?status=1&msg=backup-ok'
```

| 查询参数 | 含义 |
| --- | --- |
| `status` | `0` 表示异常，`2` 表示警告，其他值表示正常 |
| `msg` | 本次心跳的说明，最多 200 字符；特殊字符需 URL 编码 |
| `ping` | 可接收的上报元数据，不代表系统对目标做延迟测试 |

GET 请求返回 405，不产生心跳。不要用浏览器打开链接判断上报是否成功。

上报周期要短于监控允许的失联时间，并给任务波动留出余量。长时间没有心跳，调度会把监控判为异常。Push 页面不显示系统测量的响应延迟，不要再给它加一个“延迟探测任务”。

Push Token 等同于该监控的上报凭据，不要贴到公开页面或日志里。Shell 示例里的 Token 会留在命令历史中；自动化任务应把 Token 放在受保护的配置或凭据管理里。

## Agent 监控与检查来源

Agent 页面只登记机器，不会自动创建监控。安装并启动 `polaris-agent` 后，机器主动上报指标；安装步骤见 [Agent 手册](agents.md)。要监控机器在线状态或配置资源告警，在监控页面新增 **Agent 主机** 类型并选择已登记的机器。HTTP/TCP 监控则在“检查来源”里选择一台能访问目标的 Agent。

- 主机指标包括 CPU、内存、磁盘、负载、网络和挂载点。操作系统或权限不支持的项不会出现。
- 从未上报的机器一直显示等待，收到报告后才显示真实数据。
- 在线判断看最后上报时间和报告间隔，旧快照不算当前在线。
- 历史曲线来自真实的分钟聚合，刚上线的机器不会立刻有一整天的图。
- CPU、内存、磁盘阈值用百分比；负载规则用一分钟负载原值，不按 CPU 核数换算。

资源规则包含阈值、持续时间和恢复比例。只有连续的新报告满足持续时间后才进入告警；恢复阈值是“告警阈值 × 恢复比例 / 100”，用来减少临界值反复跳动。

HTTP/TCP 选了 Agent 来源后，由这台 Agent 领取探测任务并提交结果。Agent 离线、能力不满足或任务过期时，先恢复检查来源，不能把“没有结果”当成目标正常。

## 日常管理监控

监控列表顶部可以按状态筛选（全部、异常、重试中、警告、正常、已暂停；没有对应监控的状态不显示），也可以按分组、标签筛选，或按名称和目标搜索。列表按后端节奏自动刷新（Worker 每 60 秒，Go 每 5 秒），底部显示当前刷新周期。

点开某一行的“更多”菜单可以编辑、暂停或恢复、立即检查、在状态页隐藏或显示，以及删除监控。勾选多条后，“批量操作”目前只提供统一的“在状态页隐藏”和“在状态页显示”；分组的批量调整在“分组”页面完成。

暂停的监控不再执行新检查，也不会出现在公开页面；恢复后等下一次实际结果。删除监控会一并删除可用率历史和事件记录，无法恢复，但不会删除关联机器的凭据和采样历史。两者的完整影响见[分组与标签](#分组与标签)。

## 监控详情与趋势

点击列表行打开详情，可以看到当前读数、最近几次检查、平均延迟（Agent 监控显示平均 CPU）、检查间隔、超时、目标、分组、创建时间和最近的状态变化。Push 监控显示最近上报时间和心跳超时状态，不做延迟测量。

“性能趋势”汇总全部监控的响应时间和可用率：

- 范围可以选“最近检查”或“90 天”。最近检查按分钟聚合，失败检查记为失败，不会以零延迟拉低曲线；暂停的监控不参与。
- 90 天视图按检查次数加权，避免每小时检查一次的监控和每分钟检查的监控权重相同。日统计只在有观测记录的 UTC 日期结束后生成。
- 指标卡显示当前值、平均值、峰值、最低单日可用率和统计天数，失败次数单独标注。

趋势页的“事件”页签只记录状态翻转，稳定运行的监控不会产生记录。“到期”页签汇总开启了证书或域名到期检查的监控，按剩余天数排序，并区分已过期、未知和检查失败。Agent 图表里的 CPU 百分比不是网络延迟。

## 分组与标签

监控分组用来组织状态页和限定通知范围，监控标签用来分类，两者都在监控表单里管理。

启用机器公开页后，后台会显示 Agent 分组和标签。Agent 分类和监控分类各自独立，不改变监控的通知范围。

分组管理提供监控分组、机器分组和通用分组。通用分组由两个同名分组组成，新建时默认就是通用分组。点击卡片可分别查看两类成员、打开详情，或添加未分组的现有成员。已有归属的成员必须先移出原分组，不能直接转移。修改通用分组会同时更新两侧，也可只删其中一侧。转换类型如果会移除带成员的一侧，需要先确认取消归组；监控和 Agent 本身不会被删除。关闭机器页后，只显示监控分组，不显示类型选择。

监控换组后，匹配到的通知渠道可能变化。删除分组会把组内监控移到未分组，并删除对应的通知范围关联。**空范围等于全部监控**，删除分组后要重新检查渠道范围。

暂停后不再执行新检查；恢复后等下一次实际结果。删除监控会删掉可用率、事件等记录，但保留关联机器的凭据、运行配置和采样历史。删除机器前，先删除或更换引用它的监控；删除机器会清理采样历史。

## 公开页面与域名

Uptime Polaris 分别提供监控状态页和机器状态页。先在部署侧完成 DNS 和 Cloudflare Worker 域名绑定，确认域名能访问当前服务；后台的域名配置不会创建 DNS 记录，也不会绑定 Worker。

在后台设置的公开展示面板里启用独立机器页，再分别配置两种页面的域名。例如把 `status.example.com` 指向监控页，把 `servers.example.com` 指向机器页。只填主机名，不填协议、端口或路径。有效修改自动保存；保存失败会保留输入并允许重试。

关闭独立机器页后，所有域名映射停止生效并隐藏，所有域名都显示监控页。已保存的映射会保留，重新启用后恢复。域名添加后立即生效，没有逐项开关。配置映射后，只有匹配的域名显示对应页面，其他域名显示未配置。

两个域名的 `/admin` 进入同一套后台，登录会留在当前域名。会话 Cookie 按域名保存，第一次访问另一个域名的后台时，需要在该域名下登录。

机器页默认关闭，登记的机器默认只有后台可见。启用机器页后，在 Agent 管理列表或编辑表单里设置“公开显示”，也可批量公开或隐藏。关闭机器页后，所有 Agent 公开控制隐藏，已有选择保留；机器公开接口停止返回数据，上报和探测继续运行。停用的机器不会出现在公开页。监控状态页只展示监控自己标记为公开的条目。

“主题管理”顶部的看板分别显示监控页和机器页当前的主题。在下方已安装主题里点“应用”，会按主题声明的页面类型自动匹配，不用再选下拉框。应用后在对应看板里配置选项或恢复内置主题，选项自动保存。安装和制作主题见[主题指南](themes.md)。

## 使用公开机器页

内置机器页支持搜索，可按状态、分组、标签或地区筛选，也能在卡片、列表和地图视图间切换。地图视图至少需要一台机器提供可识别地区。列表、详情和对比只显示管理员允许公开的机器和字段。

在机器卡片或列表里选择 2～4 台机器，然后打开对比页。详情页和对比页的历史曲线只使用公开历史设置允许、并且实际采到的数据；详情页支持导出当前时间范围内已公开的历史字段。缺失读数不会被当成零。

筛选、视图和对比状态保存在地址里，可复制链接分享。收藏和自动刷新间隔只保存在当前浏览器；实时采样曲线保存在当前标签页会话里。页面顶部支持手动刷新和调整自动刷新间隔。桌面端提供快捷键帮助和墙板模式。

## 维护窗口

在“设置 → 维护”里开启手动维护或计划维护，修改后自动保存。开始前的顶部横条用公告文字，维护进行中的独立页面用页面标题和正文，两套文字分开配置。正文支持多行纯文本，留空就用本地化默认文案。关开关不会清空文字。手动维护优先；关掉后，已启用的计划维护继续生效。

开启计划维护后，添加“仅一次”或“每周”窗口，时间都用 UTC。单次维护填开始、结束日期和时间，结束后不重复；每周维护填星期和时间，可跨午夜。开始前的公告显示在公开页面顶部。

窗口开始后，访问公开首页或支持的展示详情页会进入当前域名根路径 `/` 的独立维护页面。已经打开的公开页面也会自动切换；维护结束后，各域名恢复各自的展示页面。后台、登录、初始化、API 和 Agent 通信仍可使用，检查和上报继续运行，自动通知在窗口内暂缓。窗口格式和通知行为见[通知指南](notifications.md#维护窗口)。

## 状态与统计

| 状态 | 含义 |
| --- | --- |
| 正常（UP） | 最近有效检查满足配置条件 |
| 异常（DOWN） | 检查失败、心跳超时或 Agent 失联等 |
| 警告（WARN） | 资源阈值、证书等存在需注意的情况 |
| 等待（PENDING） | 尚未产生足够的实际检查或首次上报 |
| 已暂停 | 管理员停用了监控，应与失联区别处理 |

可用率按已观测分钟计算：WARN 和 PENDING 算可用，DOWN 算不可用。覆盖率表示统计窗口里实际观测到多少时间。可用率高但覆盖率很低，不能说明整个窗口都在正常检查。

没有数据时页面应该留空或显示等待，图表缺口不会自动补成正常。事件记录只描述状态变化，不是每次检查的完整流水。Agent 图表里的 CPU 数值也不是网络延迟。

文本显示省略号时，把鼠标移上去可查看完整内容。多行截断也支持悬浮提示；提示里的长文本可滚动，按 Esc 关闭。

## 账号与安全

在“设置 → 账户”里可以修改用户名、密码和头像：

- 用户名 2–32 个字符，只能使用小写字母、数字、点、下划线和连字符。
- 修改密码需要输入当前密码；修改成功后，其他设备上的登录会立即失效。
- 头像支持 PNG、JPEG 和 WebP，原图最大 5 MB，上传后自动居中裁剪并立即保存。头像属于账号，和“设置 → 站点”里的站点图标不是一回事。

会话有效期、登录尝试次数和限流窗口都在“设置 → 安全”里调整，默认 14 天、8 次尝试、300 秒窗口。同一组里的“允许远程 Agent 指令”默认关闭，开启后才可以通过控制台让 Agent 升级或重启；远程指令的条件见 [Agent 手册](agents.md#远程配置与指令)。

登录失败达到上限后，该账号或来源 IP 会在一段时间内被拒绝登录。忘记密码的处理方式见[常见问题](troubleshooting.md#忘记管理密码)。

## 公开数据

公开页和公共 API 允许匿名读取。HTTP 目标会去掉用户名、密码、查询串和 fragment，只留 origin 和路径；TCP 目标保留主机和端口。名称和路径里的业务信息仍可能被看到。

在监控列表里打开该行的“更多”菜单，选择“在状态页隐藏”，监控就只对后台可见；选择“在状态页显示”恢复公开。勾选多条监控后，可在“批量操作”菜单里统一设置。公开列表、汇总和详情接口都会排除这个监控，知道详情地址也无法读取；后台的状态、历史和告警照常工作。监控还必须符合当前域名对应页面的展示选择。

监控页上选中的 Agent 主机监控会展示脱敏后的机器指标详情。机器页使用独立的机器选择和展示字段；关闭机器页后，机器页接口不返回机器数据，但 Agent 上报和探测仍正常运行。Agent Token、HTTP 私有请求头和认证配置不会出现在公开数据里。

公开读取有短缓存，后台保存后页面更新可能略有延迟。发布前用未登录状态检查一遍，名称和说明不要放敏感内容。

## Usage guide

This English section summarizes the Chinese guide; some detailed configuration and edge cases are only described above.

After [deployment and setup](deployment.md#english), manage monitors at `/admin`. The public home page is anonymous.

### Console overview

The console opens at `/admin`. The status popover summarises the fleet, lists offline Agents, and allows pausing or resuming a monitor, checking immediately, opening details, copying a summary, or pinning the panel. The activity feed lists state changes only; unread counts, mark-all-read and a 15-minute notification snooze are per browser. The three KPI cards show average availability across running monitors, the nearest certificate or domain expiry, and today's incidents. A first-run checklist covers adding a monitor, naming the site, configuring notifications and connecting an Agent; each step counts as done only when the object actually exists. `Ctrl+K` (`⌘K` on macOS) opens the command palette for pages, monitors, Agents and current-page actions.

### Manage monitors day to day

Filter the monitor list by status (all, down, pending, warning, up, paused; states without monitors are hidden), group or tag, and search by name or target. The list refreshes at the backend cadence (60 seconds on Worker, 5 seconds on Go), shown at the bottom. The row menu edits, pauses or resumes, checks immediately, toggles public visibility, and deletes. Bulk actions currently cover public visibility only; move members in the Groups page. Pausing stops new checks and removes the monitor from public pages. Deleting a monitor also deletes its availability history and events and cannot be undone.

The monitor detail shows the current reading, recent checks, average latency (average CPU for Agent monitors), interval, timeout, target, group, creation time and recent state changes. Performance trends offer a recent-checks range and a 90-day range: the recent view aggregates by minute and records failures as failures rather than zero latency, while the 90-day view weights days by check count so hourly and minutely monitors do not count equally. Daily statistics appear after a UTC day with observations ends. The Events tab lists state changes only; the Expiry tab ranks monitors with certificate or domain checks by days remaining.

### Account and security

Settings → Account changes the username, password and avatar. Usernames are 2–32 lowercase letters, digits, dots, underscores or hyphens. Changing the password requires the current one and signs out other devices. Avatars accept PNG, JPEG or WebP up to 5 MB and are cropped and saved immediately; this is separate from the site icon under Settings → Site. Session lifetime, login attempt limit and rate-limit window live under Settings → Security, and the Agent remote-command switch there is off by default. See [troubleshooting](troubleshooting.md#troubleshooting-guide) for a forgotten password.

### Create a monitor

In monitor management, add an HTTP monitor with a name and URL such as `https://example.com/health`. Choose an interval, timeout, expected status, and check source, then save it. Wait for the next scheduled result, or use the immediate check for a backend-run monitor. Push, Agent host, and Agent-sourced monitors do not support a synchronous immediate check.

Worker accepts intervals of 60–86,400 seconds and timeouts of 1,000–60,000 ms; Go accepts 5–86,400 seconds and 100–120,000 ms. Site defaults only fill new forms and do not rewrite existing monitors. `monitor.defaultRetries` controls failure confirmation at runtime.

### Check types and sources

- **HTTP:** configure the URL, method, status codes and, when needed, headers, body, Basic or Bearer authentication, JSON or response-header assertions, and a latency threshold. An HTTP 200 can still fail an assertion.
- **TCP:** enter `host:port`. Optional send and expected-response data check more than a successful connection.
- **UDP and ICMP:** Worker requires an online Agent advertising `probe_udp` or `probe_icmp`. Go runs UDP directly and advertises native ICMP only when its permission check succeeds. UDP requires a response; sending a packet alone is not success.
- **Go DNS, TLS and WebSocket:** these independent types run on the Go backend. DNS accepts a system or configured resolver; TLS checks a `host:port`; WebSocket uses a `ws://` or `wss://` URL.
- **Push:** create a Push monitor and POST to its tokenized URL on schedule. `status=0` means down, `status=2` means warning, and other values mean up; `msg` carries up to 200 characters. GET does not record a heartbeat. `ping` is supplied metadata, not measured latency. Treat the URL as a credential.
- **Agent host:** register and start an Agent, then create an Agent host monitor to track availability or define resource rules. An Agent can also execute supported checks for other monitors. An offline or incapable source does not mean the target is healthy. See the [Agent guide](agents.md#agent-guide).

HTTP and TCP monitors support SSL, domain-expiry and DNS add-ons; Go also supports add-ons on UDP, TLS and WebSocket. Worker SSL add-ons query public certificate-transparency records daily and do not verify the certificate currently served or its trust chain. Go and capable Agent sources use a TLS handshake. Unknown results stay unknown; they are not successful checks.

### Groups, public pages and machine view

Monitor groups organize status pages and notification scope; monitor tags classify monitors. Agent groups and tags are separate. A channel with no group scope applies to all monitors, including ungrouped ones. Recheck channel scope after moving monitors or deleting a group.

The optional machine page is disabled by default, and registered machines are private until explicitly published. Configure DNS and the Worker or server domain before setting public-page domain mappings in the console. Disabling the machine page hides its public controls and stops its public API from serving machine data; Agent reporting continues. Cookies are scoped to each domain, so a second domain may require a separate login.

The built-in machine page supports search, state/group/tag/region filters, card and list views, and a map when recognizable region data exists. Select 2–4 machines for comparison. History charts and CSV export are limited to published fields and available samples. Filter, view and comparison choices are shareable in the URL; pins and refresh interval are stored in the browser, and live samples in the current tab session.

Themes can be installed and applied separately to monitor and machine pages. See the [theme guide](themes.md#english).

### Maintenance, status and public data

Enable manual or scheduled maintenance in settings. Scheduled one-time and weekly windows use UTC; weekly windows can span midnight. Maintenance replaces supported public pages with a maintenance page while checks and Agent reports continue. Automatic notifications are suppressed during the window. See [notifications](notifications.md#maintenance-and-automatic-dispatch).

UP means the latest valid check meets its conditions, DOWN indicates failure or loss of reporting, WARN indicates a resource or certificate warning, and PENDING means there is not yet enough data. Paused is distinct from offline. Availability counts observed minutes: WARN and PENDING count as available, DOWN as unavailable. Check coverage alongside availability; missing chart data is not filled with healthy readings.

Public pages and APIs are anonymous. Public HTTP targets omit credentials, query strings and fragments but retain the origin and path; TCP retains host and port. Names and paths may still disclose information. Hide monitors from their row menu or in bulk; hidden monitors stay active in the console but are excluded from public lists, summaries and details. Machine fields have separate publication settings. Review the anonymous page before sharing it.
