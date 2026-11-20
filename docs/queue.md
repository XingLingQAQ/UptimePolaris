# Worker Queue 分批检查

[English](#english)

监控多起来以后，一轮到期的检查会超出一个 Worker 调用能处理的量。Queue 把这批检查拆成多次调用，普通主动监控和 AI 模型共用。它不会提高单次调用的外部请求上限，检查照样按次计费，每次消费仍有请求、执行时间和 Analytics Engine 点数预算。

这个功能只有 Worker 版本有，默认关闭。不开的时候还是原来的定时检查，初始化、Go 后端、Push 和 Agent 上报都不受影响。开起来之后，如果绑定丢了或者发送失败，程序不会偷偷退回直接检查，要么把队列恢复好，要么在后台把分批检查关掉。

每分钟的 Cron 继续保留。入队、Push 超时、Agent 状态和通知都还靠它，Queue 不接管这部分。

## 绑定并检查

1. 在 Cloudflare 控制台建一个 Queue。
2. 给当前 Worker 加 producer 绑定，变量名 `CHECK_QUEUE`，指向刚建的队列。
3. 在队列的消费者设置里选同一个 Worker。建议最大批大小 **1 条消息**、并发 **1**、等待时间 5 秒。
4. 保存并部署，然后进后台“设置 → 运维操作”，运行 Queue 连接检查。
5. 检查会发一条不碰监控目标的探测消息，等消费者确认。通过之后再启用分批检查。只配了 producer、没配 consumer 是过不了的。

一条消息不等于一个监控：程序会让每条消息带最多 10 项任务，所以批大小设成 1，一次调用也能跑好几项检查。别把批大小调到 100 去提高吞吐，那只是把更多任务挤进同一次调用，预算还是一份。

Fork 和按钮部署会保留 `CHECK_QUEUE` 和属于当前 Worker 的消费者配置，包括等待、重试、并发和死信队列。读不到现有配置就停止部署，免得误删绑定。部署本身不建队列、不补消费者，也不接管别的 Worker 的消费者。

控制台菜单的名字可能变，别处找不到就看[官方队列配置说明](https://developers.cloudflare.com/queues/configuration/configure-queues/)。

### 手动部署的配置

用 CF CLI 手动部署的，要把队列写进 `backends/worker/cloudflare.config.ts`，否则下次部署会把控制台里的绑定覆盖掉。下面按队列名 `polaris-checks` 举例。在 `worker.env` 里加：

```ts
CHECK_QUEUE: bindings.queue({ name: "polaris-checks" }),
```

在 `worker.triggers` 数组里加消费者，原来的 Cron 保留：

```ts
triggers.queue({
  name: "polaris-checks",
  maxBatchSize: 1,
  maxBatchTimeout: 5,
  maxConcurrency: 1,
}),
```

用 Wrangler 配置的话，字段是这样，追加到实际部署用的 TOML 里，已有的数据库和其他资源配置别动：

```toml
[[queues.producers]]
binding = "CHECK_QUEUE"
queue = "polaris-checks"

[[queues.consumers]]
queue = "polaris-checks"
max_batch_size = 1
max_batch_timeout = 5
max_concurrency = 1
```

## 用量与费用

一条消息最多带 10 项检查，不够 10 项也照发。消息的写入、读取、删除各算一次 Queue 操作，一次正常成功的处理通常是 3 次；重试和重新投递会更多。把任务拼进同一条消息能省操作数，但不是每条都能凑满。

按每条约 10 项、不重试算：100 个同时到期的任务需要 10 条消息，也就是 30 次 Queue 操作。批次没凑满、错峰调度和重投递都会让实际用量更高。消费调用、数据库读写、AE 写入和供应商 API 调用各自单独计费。免费额度和价格以 [Cloudflare Queue 计费说明](https://developers.cloudflare.com/queues/platform/pricing/)为准。

Queue 至少投递一次。程序会识别已经跑完的任务，但如果消费者在供应商返回之后、结果保存之前中断，重投递还是会再调一次供应商，这笔钱省不掉。应用层的去重管不到供应商那边的计费。

## 观察积压与恢复

后台显示最近入队时间、最近处理时间、待处理任务数和最早待处理的时间。看到这些再结合 Cloudflare 的队列指标，才知道消息是不是在被消费；光看 producer 绑上了没有意义。

程序最多同时存 1000 项待处理任务，每项有效期 15 分钟。过期任务不会变成检查结果，还没到期的监控等下一轮入队。超时时间长的任务可能分几次消费，不会为了塞进一次调用就去改配置里的请求超时。

- 检查不通过：确认 producer 和 consumer 指向同一个队列、消费者是当前 Worker，保存部署后重新检查。
- 积压一直涨：看消费者报错、目标响应时间、请求预算和 Cloudflare 用量，也可以把监控间隔调长。
- 模型限流或额度不足：照常按渠道冷却处理，别靠立即重投递绕过退避。
- 暂停、删除或改动了监控：旧任务不会用旧配置盖掉新状态，没执行的任务也不会记成成功或故障。

想退回直接检查，先在后台关掉分批检查，再动绑定。队列里可能还有没消费完的消息，删队列不能代替关功能。

## English

Once enough monitors share one due cycle, a single Worker invocation runs out of budget. Queues split that cycle across several invocations for ordinary active monitors and AI models. They do not raise the per-invocation request limit, checks still cost money, and each invocation keeps its own request, execution-time and Analytics Engine budgets.

This Worker-only feature is off by default. Until you turn it on, the original scheduler runs unchanged, and setup, Go, Push and Agent reporting are unaffected. Once enabled, a missing binding or a failed send does not quietly fall back to direct checks: either restore the Queue or turn batching off in the console.

Keep the per-minute Cron. It still handles enqueueing, Push timeouts, Agent state and notifications; Queue does not take that over.

### Bind and verify

1. Create a Queue in Cloudflare.
2. Add a producer binding named `CHECK_QUEUE` to the current Worker and point it at that Queue.
3. Add the same Worker as the Queue's consumer. Start with a maximum batch size of **1 message**, concurrency **1** and a five-second batch timeout.
4. Save and deploy, then run the Queue connection check under settings and operations in the console.
5. The check sends a probe that does not touch monitoring targets and waits for the consumer to confirm it. Enable batched checks only after it passes. A producer without a consumer cannot pass.

One message is not one monitor: the application puts up to 10 tasks in each message, so a batch size of 1 still runs several checks in one invocation. Do not raise the batch size to 100 for throughput; that only packs more tasks into the same invocation with the same budget.

Fork and button deployments keep `CHECK_QUEUE` and the current Worker's consumer settings, including timeout, retries, concurrency and dead-letter queue. Deployment stops when those settings cannot be read, so bindings are not dropped. It does not create queues, add missing consumers or take over another Worker's consumer.

Console menus move around between versions; see [Cloudflare's queue configuration guide](https://developers.cloudflare.com/queues/configuration/configure-queues/) if a step is not where this page says.

For manual CF CLI deployment, declare the Queue in `backends/worker/cloudflare.config.ts` or the next deployment overwrites the dashboard bindings. With the Queue name `polaris-checks`, add `CHECK_QUEUE: bindings.queue({ name: "polaris-checks" })` to `worker.env` and the `triggers.queue(...)` consumer shown above to `worker.triggers`, keeping the Cron. For Wrangler, append the producer and consumer TOML blocks above to the configuration you actually deploy, and leave existing database and resource settings alone.

### Usage and charges

A message carries up to 10 tasks, and partial messages still count. Writing, reading and deleting a message are separate Queue operations, so a normal successful delivery usually costs three. At 10 tasks per message without retries, 100 due tasks need 10 messages and 30 operations. Partial batches, staggered scheduling and redelivery all raise the real number. Consumer invocations, database access, AE and provider calls are billed separately; check [current Queue pricing](https://developers.cloudflare.com/queues/platform/pricing/).

Delivery is at least once. The application recognises tasks that already finished, but a consumer interrupted after the provider answered and before the result was saved will call that provider again on redelivery, and that call is billed. Application-level deduplication cannot make upstream billing exactly once.

### Backlog and recovery

The console reports last enqueue and processing times, pending tasks and the oldest pending task. Read those alongside Cloudflare's Queue metrics; a bound producer on its own proves nothing about consumption.

The application holds up to 1000 pending tasks, each valid for 15 minutes. Expired tasks do not become check results, and monitors still due are enqueued on the next cycle. Long-timeout tasks may take several invocations rather than having their configured request timeout shortened.

If verification fails, confirm that the producer and the current Worker's consumer use the same Queue, save, deploy and verify again. If backlog keeps growing, look at consumer errors, target duration, request budgets and platform usage, and consider longer intervals. Rate limits and quota failures keep their cooldown instead of retrying immediately. Paused, deleted or changed monitors do not have old tasks overwrite current state, and unexecuted tasks never become successes or failures.

To go back to direct checks, turn batching off in the console before touching bindings. Messages may still be in the Queue; deleting the Queue is not the same as turning the feature off.
