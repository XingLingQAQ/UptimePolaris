/** Notification channel configuration; provider fields are declared in CHANNEL_FIELDS. / 通知渠道配置；服务商字段在 CHANNEL_FIELDS 中声明。 */
export type NotificationType =
  | 'telegram'
  | 'feishu'
  | 'slack'
  | 'discord'
  | 'webhook'
  | 'apprise'
  | 'serverchan';

export interface NotificationChannel {
  id: string;
  name: string;
  type: NotificationType;
  /** Parsed from storage on the Worker side, so the form can edit it directly. / 由 Worker 从存储中解析，供表单直接编辑。 */
  config: Record<string, string>;
  /** Group UUIDs; an empty scope receives all monitors, including ungrouped monitors. / 分组 UUID；空范围接收所有监控项，包括未分组项。 */
  group_ids: string[];
  active: number;
  created_at: number;
  updated_at: number;
}

export interface NotificationInput {
  name: string;
  type: NotificationType;
  config: Record<string, string>;
  /** Replaces the complete scope; [] means all monitors, while omission preserves the stored scope. / 替换完整范围；[] 表示所有监控项，省略则保留已存范围。 */
  group_ids: string[];
  active?: number;
}

/** Observed 24-hour delivery statistics; channels without attempts are absent, hourly slots run oldest first. / 观测到的 24 小时发送统计；无发送尝试的渠道不出现，小时数据按时间从旧到新。 */
export interface ChannelDeliveryStats {
  /** Pushes attempted in the last 24 hours. / 过去 24 小时的推送尝试次数。 */
  sent24h: number;
  /** Of those, how many the provider refused or never answered. / 其中服务商拒绝或未响应的次数。 */
  failed24h: number;
  /** Mean provider round trip, milliseconds. / 服务商平均往返时间，单位毫秒。 */
  avgLatencyMs: number;
  /** Epoch seconds of the last attempt, or null if the channel has never sent. / 上次尝试的 Unix 秒数；渠道从未发送时为 null。 */
  lastSentAt: number | null;
  lastOk: boolean | null;
  /** Attempts per hour for the last 24 hours, oldest first. / 过去 24 小时每小时的尝试次数，按时间从旧到新。 */
  hourly: number[];
}

/** One logged push attempt, as `/api/notifications/deliveries` returns it. / `/api/notifications/deliveries` 返回的单条推送尝试记录。 */
export interface DeliveryRecord {
  id: string;
  channel_id: string;
  monitor_id: string | null;
  /** Denormalised so a delivery for a deleted monitor still says what it was about. / 冗余保存名称，以便监控项删除后仍能识别发送记录。 */
  monitor_name: string | null;
  /** The transition that was pushed: 0 down, 1 recovered, 2 warning. / 推送的状态变更：0 故障、1 恢复、2 警告。 */
  status: 0 | 1 | 2;
  ok: boolean;
  latency_ms: number;
  /** The provider's own error text when `ok` is false. Already scrubbed. / `ok` 为 false 时服务商返回的错误文本；已清理敏感信息。 */
  error: string | null;
  created_at: number;
}
