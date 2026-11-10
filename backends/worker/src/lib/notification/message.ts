import { notificationCopy } from './locales';

/** What happened, for the message body. / 消息正文所需的事件信息。 */
export interface NotifyEvent {
  monitorName: string;
  monitorTarget: string;
  monitorType: string;
  /** Stable monitor identity for outbox deduplication; synthetic callers may use monitorName. / 用于发件箱去重的稳定监控标识；合成调用方可使用 monitorName。 */
  monitorId?: string;
  eventKey?: string;
  /** Notification status: 0 down, 1 up, 2 warn; PENDING transitions are not sent. / 通知状态：0 故障、1 正常、2 警告；不发送 PENDING 状态变化。 */
  status: 0 | 1 | 2;
  /** Previous status, or undefined on a monitor's first ever reading. / 之前的状态；监控首次观测时为 undefined。 */
  prevStatus?: 0 | 1 | 2;
  /** The check's message (may name the add-on that caused it). / 检查消息（可能指出产生消息的附加检查）。 */
  message: string;
  statusCode?: number;
  latencyMs?: number | null;
  /** epoch seconds / Unix 时间戳（秒） */
  at: number;
  /** Group UUID for scope filtering; null or omission means ungrouped. / 用于范围过滤的分组 UUID；null 或省略表示未分组。 */
  groupId?: string | null;
}

export const STATE_LABEL: Record<0 | 1 | 2, string> = { 0: 'DOWN', 1: 'UP', 2: 'WARN' };

// Telegram HTML requires escaping; replace ampersands first to avoid double escaping.
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ISO formatting avoids runtime-dependent locale data.
function utcTimestamp(epochSeconds: number): string {
  const iso = new Date(epochSeconds * 1000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

/** Localize message fields; monitor values and diagnostics stay verbatim. / 翻译消息字段，监控信息和诊断保留原文。 */
export function buildMessage(event: NotifyEvent, language?: string): string {
  const copy = notificationCopy(language);
  const states = [copy.down, copy.up, copy.warn];
  const state = states[event.status];
  const transition = event.prevStatus === undefined
    ? format(copy.firstState, { state })
    : `${states[event.prevStatus]} -> ${state}`;
  const lines = [
    buildTitle(event, language),
    format(copy.target, { value: event.monitorTarget }),
    format(copy.type, { value: event.monitorType }),
    format(copy.state, { value: transition }),
  ];
  if (event.message) lines.push(format(copy.detail, { value: event.message }));
  if (typeof event.statusCode === 'number' && Number.isFinite(event.statusCode) && event.statusCode > 0) {
    lines.push(format(copy.response, { value: String(event.statusCode) }));
  }
  if (typeof event.latencyMs === 'number' && Number.isFinite(event.latencyMs) && event.latencyMs >= 0) {
    lines.push(format(copy.latency, { value: `${Math.round(event.latencyMs)} ms` }));
  }
  let action = copy.actionWarn;
  if (event.status === 0) action = copy.actionDown;
  else if (event.status === 1) {
    action = event.prevStatus === 0 || event.prevStatus === 2 ? copy.actionUp : copy.actionUpCurrent;
  }
  lines.push(format(copy.action, { value: action }));
  lines.push(format(copy.time, { value: utcTimestamp(event.at) }));
  return lines.join('\n');
}

export function buildTitle(event: NotifyEvent, language?: string): string {
  const copy = notificationCopy(language);
  const state = [copy.down, copy.up, copy.warn][event.status];
  let template = copy.headline;
  if (event.prevStatus === undefined) template = copy.firstHeadline;
  else if (event.status === 1 && event.prevStatus === 0) template = copy.recovered;
  return format(template, { name: event.monitorName, state });
}

function format(template: string, values: Record<string, string>): string {
  return template.replace(/\{(name|state|value)\}/g, (token, key: string) => values[key] ?? token);
}
