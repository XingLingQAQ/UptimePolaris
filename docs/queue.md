# Worker Queue 分批检查

[English](#english)

监控数量较多导致单次 Worker 调用超出请求或耗时预算时，可开启 **Worker Queue**，将普通主动监控与 AI 模型的探测拆分到多次队列消费调用中执行。

- **仅适用于 Worker 后端**，默认关闭。
- 启用后如队列绑定异常，系统会直接报错而不是静默回退直接检查；需修复队列或在后台关闭。
- 原有每分钟 Cron 仍须保留，负责任务入队、Push 超时、Agent 状态与通知。

## 绑定与启用

1. 在 Cloudflare 创建一个 Queue（如 `polaris-checks`）。
2. 为当前 Worker 添加 **Producer** 绑定，变量名为 `CHECK_QUEUE`。
3. 在队列 **Consumer** 设置中选择同一 Worker（建议：最大批大小 `1`、并发 `1`、等待时间 `5` 秒；程序内部会将最多 10 项任务打进同一条消息）。
4. 保存并部署后，进入 **设置 → 运维操作** 运行 Queue 连接检查，确认通过后开启分批检查开关。

### 保留绑定配置

- **Fork / 按钮部署**：`npm run deploy` 会自动保留现有 `CHECK_QUEUE` 及当前 Worker 的消费者配置。
- **手动 CLI 部署**：必须在 `backends/worker/cloudflare.config.ts` 和部署使用的 `wrangler.toml` 中声明队列，否则下次部署会覆盖绑定：

```ts
// backends/worker/cloudflare.config.ts -> worker.env
CHECK_QUEUE: bindings.queue({ name: "polaris-checks" }),
// worker.triggers（保留原有 Cron）
triggers.queue({ name: "polaris-checks", maxBatchSize: 1, maxBatchTimeout: 5, maxConcurrency: 1 }),
```

```toml
# backends/worker/wrangler.toml
[[queues.producers]]
binding = "CHECK_QUEUE"
queue = "polaris-checks"

[[queues.consumers]]
queue = "polaris-checks"
max_batch_size = 1
max_batch_timeout = 5
max_concurrency = 1
```

## 用量与排查

- **计费与投递**：每条消息最多带 10 项检查，正常处理消耗 3 次 Queue 操作（写、读、删）。由于 Queue 为至少一次投递，若消费者在外部接口/AI 模型扣费响应后、存库前中断，重投递可能再次调用上游。详情见 [Cloudflare Queue 计费](https://developers.cloudflare.com/queues/platform/pricing/)。
- **积压与停用**：待处理任务有效期 15 分钟（最多 1000 项），过期任务不记入结果并在下轮重新入队；积压持续增长时查看消费者报错、目标耗时或拉长监控间隔。**停用时务必先在后台关闭分批检查开关，再删除队列绑定。**

## English

When too many monitors share one cycle, **Worker Queue** splits active monitor and AI checks across multiple consumer invocations. This feature is **Worker-only** and off by default; keep the per-minute Cron trigger enabled to drive enqueueing, Push timeouts, Agent state, and notifications.

### Bind and enable

1. Create a Queue in Cloudflare (such as `polaris-checks`).
2. Add a **Producer** binding named `CHECK_QUEUE` on your Worker.
3. Add the **same Worker as Consumer** (recommended: max batch size `1`, concurrency `1`, wait `5` seconds—each message already packs up to 10 checks).
4. Deploy, run the Queue connection check under **Settings → Operations**, and enable batching once it passes.

Fork/button deploys preserve `CHECK_QUEUE` automatically; manual CLI deploys must declare producer and consumer blocks in `backends/worker/cloudflare.config.ts` and `wrangler.toml` (see snippets above).

### Usage and troubleshooting

- Up to 10 tasks pack per message (3 Queue operations on normal delivery). Delivery is at-least-once: a crash after an upstream provider response and before commit triggers redelivery (and another provider call). See [Cloudflare Queue pricing](https://developers.cloudflare.com/queues/platform/pricing/).
- Pending tasks expire after 15 minutes (cap 1,000); if backlog grows, inspect consumer errors, slow targets, or lengthen intervals. **Disable batching in the console before deleting the Queue or bindings.**
