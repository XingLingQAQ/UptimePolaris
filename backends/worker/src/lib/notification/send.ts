import type { ExternalRequestBudget } from '../http/request-budget';
import { budgetedFetch } from '../http/request-budget';
import type { MonitorType } from '../../types';
import { publicTarget } from '../public/redaction';
import { errMsg } from '../util';
import type { NotificationChannel } from './channels';
import { scrubError } from './delivery-history';
import type { NotifyEvent } from './message';
import { buildMessage, buildTitle, escapeHtml, STATE_LABEL } from './message';

/** Hard send timeout; shorter than a monitor timeout because alerts are best-effort. / 发送硬超时；通知尽力而为，故短于监控超时。 */
export const SEND_TIMEOUT_MS = 10_000;

/** Bounds an error string taken from a provider so one failure cannot fill the log. / 限制提供商错误字符串长度，避免一次失败填满日志。 */
const MAX_ERROR_CHARS = 300;

/** First non-empty provider error string, capped for the log. / 取第一个非空的提供商错误文本，并限制长度。 */
function describe(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}

function scrubNotificationText(text: string, config: Record<string, string>, target = false): string {
  const secrets = new Set<string>();
  const add = (value: string) => {
    if (!value) return;
    secrets.add(value);
    try {
      const encoded = encodeURIComponent(value);
      secrets.add(encoded);
      secrets.add(encoded.replace(/%20/g, '+'));
    } catch {
      // Keep the original value when it cannot be URI-encoded.
    }
  };
  for (const [key, raw] of Object.entries(config)) {
    if (!['bot_token', 'secret', 'sendkey', 'key', 'url', 'webhook_url', 'urls'].includes(key)) continue;
    const value = raw.trim();
    add(value);
    if (key !== 'url' && key !== 'webhook_url' && key !== 'urls') continue;
    for (const part of value.split(/[\s,]+/)) {
      add(part);
      try {
        const address = /^[a-z][a-z0-9+.-]*:\/\//i.test(part) ? part : `http://${part}`;
        const url = new URL(address);
        add(decodeURIComponent(url.username));
        add(decodeURIComponent(url.password));
        if (!target) {
          for (const segment of url.pathname.split('/')) {
            const decoded = decodeURIComponent(segment);
            if (decoded.length >= 4) add(decoded);
          }
        }
        url.searchParams.forEach(add);
        add(decodeURIComponent(url.hash.slice(1)));
        new URLSearchParams(url.hash.slice(1)).forEach(add);
      } catch {
        // Invalid URLs are still redacted as configured above.
      }
    }
  }
  const values = [...secrets].sort((a, b) => b.length - a.length);
  const patterns = [
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/i.source,
    /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/.source,
    /\bBearer\s+[^\s"']+/i.source,
    /\b(?:bot_token|access_token|api_key|token|key|secret|password|sendkey)["']?\s*[:=]\s*["']?[^\s&,"'}]+/i.source,
    ...values.map((value) => {
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return value.length <= 3 && /^\w+$/.test(value) ? `\\b${escaped}\\b` : escaped;
    }),
  ];
  text = text.replace(new RegExp(patterns.join('|'), 'gi'), (match) => {
    const field = match.match(/^(bot_token|access_token|api_key|token|key|secret|password|sendkey)["']?\s*[:=]/i);
    if (field) return `${field[1]}=[redacted]`;
    if (/^Bearer\s/i.test(match)) return 'Bearer [redacted]';
    return '[redacted]';
  });
  if (target) return text;
  return scrubError(text).slice(0, MAX_ERROR_CHARS);
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body = (await res.json()) as unknown;
    return body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Send one event to one channel. Never throws.
 *
 * Telegram, Feishu and ServerChan return HTTP 200 for a logical failure
 * (`{"ok":false}`, `{"code":19001}`, `{"code":40001}`), so success is
 * decided by the body where the provider defines one; a body that cannot be
 * read counts as failure. Slack and Discord are the exception: their failures
 * are 4xx, and Slack's success body is the literal text `ok`, not JSON.
 * 有正文成功标志的提供商必须查正文；Slack/Discord 只看状态码。
 */
export async function sendToChannel(
  channel: NotificationChannel,
  event: NotifyEvent,
  timeoutMs = SEND_TIMEOUT_MS,
  budget?: ExternalRequestBudget,
): Promise<{ ok: boolean; error?: string }> {
  let result: { ok: boolean; error?: string };
  try {
    const target = event.monitorTarget;
    event = {
      ...event,
      monitorTarget: target ? publicTarget(target, event.monitorType as MonitorType) : '',
      message: event.message ? scrubNotificationText(event.message, { url: target }, true) : event.message,
    };
    switch (channel.type) {
      case 'telegram':
        result = await sendTelegram(channel, event, timeoutMs, budget);
        break;
      case 'feishu':
        result = await sendFeishu(channel, event, timeoutMs, budget);
        break;
      case 'slack':
        result = await sendSlack(channel, event, timeoutMs, budget);
        break;
      case 'discord':
        result = await sendDiscord(channel, event, timeoutMs, budget);
        break;
      case 'apprise':
        result = await sendApprise(channel, event, timeoutMs, budget);
        break;
      case 'serverchan':
        result = await sendServerChan(channel, event, timeoutMs, budget);
        break;
      case 'webhook':
        result = await sendWebhook(channel, event, timeoutMs, budget);
        break;
      default:
        // A row written by a newer deployment than this code. Reported rather
        // than thrown or ignored, so the operator sees why nothing arrived.
        // 此记录可能由比当前代码更新的部署写入；报告错误而非抛出或忽略，
        // 使管理员知道为何没有收到消息。
        result = { ok: false, error: 'unsupported_type' };
    }
  } catch (e) {
    // A DNS failure, a TLS error, `AbortSignal.timeout` firing - all of it lands
    // here, because a notification must never be able to break the caller.
    // DNS 失败、TLS 错误和 `AbortSignal.timeout` 触发等都在此处理，
    // 因为通知绝不能使调用方失败。
    result = { ok: false, error: errMsg(e) };
  }
  if (result.error) result.error = scrubNotificationText(result.error, channel.config);
  return result;
}

async function sendTelegram(
  channel: NotificationChannel,
  event: NotifyEvent,
  timeoutMs: number,
  budget?: ExternalRequestBudget,
): Promise<{ ok: boolean; error?: string }> {
  const token = channel.config.bot_token?.trim() ?? '';
  const chatId = channel.config.chat_id?.trim() ?? '';
  if (!token) return { ok: false, error: 'telegram_token_required' };
  if (!chatId) return { ok: false, error: 'telegram_chat_required' };

  const res = await budgetedFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: escapeHtml(buildMessage(event, channel.config.language)),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  }, budget);

  if (!res.ok) return { ok: false, error: `http_${res.status}` };

  const body = await readJson(res);
  // `ok` must be boolean true; missing or non-boolean is not a delivery. / `ok` 必须是布尔 true，缺失或非布尔都不算送达。
  if (body?.ok !== true) {
    return { ok: false, error: describe(body?.description, body?.error_code && `error_${body.error_code}`) ?? 'telegram_not_ok' };
  }
  return { ok: true };
}

async function sendFeishu(
  channel: NotificationChannel,
  event: NotifyEvent,
  timeoutMs: number,
  budget?: ExternalRequestBudget,
): Promise<{ ok: boolean; error?: string }> {
  const url = channel.config.webhook_url?.trim() ?? '';
  if (!url) return { ok: false, error: 'feishu_url_required' };

  const res = await budgetedFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // No escaping: `msg_type:"text"` is rendered as plain text, so the raw
    // message is what the operator should see.
    // 不转义：`msg_type:"text"` 以纯文本呈现，管理员应看到原始消息。
    body: JSON.stringify({ msg_type: 'text', content: { text: buildMessage(event, channel.config.language) } }),
    signal: AbortSignal.timeout(timeoutMs),
  }, budget);

  if (!res.ok) return { ok: false, error: `http_${res.status}` };

  const body = await readJson(res);
  if (typeof body?.code !== 'number') return { ok: false, error: 'feishu_invalid_response' };
  if (body.code !== 0) {
    return { ok: false, error: describe(body.msg, body.StatusMessage) ?? `feishu_code_${body.code}` };
  }
  return { ok: true };
}

/**
 * Slack incoming webhook.
 *
 * No body check: success is `200` with the literal text `ok`, and every
 * failure is a 4xx (`invalid_payload`, `channel_not_found`). The body is not
 * JSON, so parsing it would report a delivered message as a failure.
 * Slack 成功正文是字面 ok，不是 JSON；失败都是 4xx，只看状态码。
 */
async function sendSlack(
  channel: NotificationChannel,
  event: NotifyEvent,
  timeoutMs: number,
  budget?: ExternalRequestBudget,
): Promise<{ ok: boolean; error?: string }> {
  const url = channel.config.webhook_url?.trim() ?? '';
  if (!url) return { ok: false, error: 'slack_url_required' };

  const res = await budgetedFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: buildMessage(event, channel.config.language),
      // `unfurl_links:false` keeps a monitor whose target is a webpage from
      // turning the alert into a link preview card.
      // `unfurl_links:false` 防止网页目标使告警变成链接预览卡片。
      unfurl_links: false,
      unfurl_media: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  }, budget);

  if (res.ok) return { ok: true };
  // Slack puts the reason in the body as plain text (`invalid_payload`), not JSON.
  // Slack 将原因作为纯文本放在响应体中（`invalid_payload`），而非 JSON。
  const reason = await res.text().catch(() => '');
  return { ok: false, error: reason.trim() || `http_${res.status}` };
}

/**
 * Discord webhook.
 *
 * Success is `204 No Content`, so there is no body to inspect. `content` is
 * capped at 2000 characters; exceeding it is a 400 that would silently drop
 * the alert, so the cap is applied rather than trusted.
 * 成功为 204 无正文；content 超 2000 字符会 400 并静默丢告警，必须截断。
 */
async function sendDiscord(
  channel: NotificationChannel,
  event: NotifyEvent,
  timeoutMs: number,
  budget?: ExternalRequestBudget,
): Promise<{ ok: boolean; error?: string }> {
  const url = channel.config.webhook_url?.trim() ?? '';
  if (!url) return { ok: false, error: 'discord_url_required' };

  const res = await budgetedFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: buildMessage(event, channel.config.language).slice(0, 2000) }),
    signal: AbortSignal.timeout(timeoutMs),
  }, budget);

  if (res.ok) return { ok: true };
  const body = await readJson(res);
  return { ok: false, error: describe(body?.message, body?.code && `code_${body.code}`) ?? `http_${res.status}` };
}

/** Apprise: `url` is the gateway, `urls` or `key` picks stateless/stateful. The key goes in the path, and HTTP 424 means delivery failed. / Apprise：`url` 是网关，`urls` 或 `key` 选择无状态/有状态；key 放在路径，HTTP 424 表示投递失败。 */
async function sendApprise(
  channel: NotificationChannel,
  event: NotifyEvent,
  timeoutMs: number,
  budget?: ExternalRequestBudget,
): Promise<{ ok: boolean; error?: string }> {
  const base = (channel.config.url?.trim() ?? '').replace(/\/+$/, '');
  if (!base) return { ok: false, error: 'apprise_url_required' };
  const key = channel.config.key?.trim() ?? '';
  const urls = channel.config.urls?.trim() ?? '';

  // Neither a saved configuration nor explicit destinations: nothing to notify.
  // 既没有保存的配置，也没有显式目标：没有可通知的对象。
  if (!key && !urls) return { ok: false, error: 'apprise_urls_required' };

  const res = await budgetedFetch(key ? `${base}/${encodeURIComponent(key)}` : base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      // Omitted in stateful mode: supplying `urls` alongside a key switches the
      // call to stateless and bypasses the saved configuration it was meant to use.
      // 有状态模式省略 `urls`：与 key 同时提供会使调用转为无状态，绕过本应使用的保存配置。
      ...(key ? {} : { urls }),
      title: buildTitle(event, channel.config.language),
      body: buildMessage(event, channel.config.language),
      // Apprise's own severity. Some destinations render it (colour, icon), so a
      // DOWN alert should not arrive styled as routine information.
      // Apprise 自身的严重程度；某些目标会渲染其颜色或图标，DOWN 告警不应显示为普通信息。
      type: appriseType(event),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  }, budget);

  if (res.ok) return { ok: true };

  const text = await res.text().catch(() => '');
  const detail = describe(extractAppriseError(text));
  // 424 is the actionable one: the request was accepted but a destination failed.
  // 424 是可操作的信息：请求已接受，但某个目标发送失败。
  if (res.status === 424) return { ok: false, error: detail ?? 'apprise_delivery_failed' };
  return { ok: false, error: detail ?? `http_${res.status}` };
}

/** Apprise severity for an event, which some destinations render. / 事件的 Apprise 严重程度，某些目标会将其渲染出来。 */
function appriseType(event: NotifyEvent): 'info' | 'success' | 'warning' | 'failure' {
  if (event.status === 0) return 'failure';
  if (event.status === 2) return 'warning';
  // Recovery is distinct from a first UP reading (`prevStatus === 0`). / 恢复与首次 UP 不同（`prevStatus === 0`）。
  if (event.status === 1 && event.prevStatus === 0) return 'success';
  return 'info';
}

/** First non-empty of `error`/`message`/`detail`, else the last line of a text log. / 依次取 `error`/`message`/`detail`，否则取文本日志最后一行。 */
function extractAppriseError(text: string): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const json = JSON.parse(trimmed) as Record<string, unknown>;
      const direct = describe(json.error, json.message, json.detail);
      if (direct) return direct;
    } catch {
      // Not JSON after all; fall through to the text handling.
      // 实际不是 JSON，继续按文本处理。
    }
  }
  const lines = trimmed.split('\n').filter((l) => l.trim());
  return lines.length ? lines[lines.length - 1] : undefined;
}


async function sendServerChan(
  channel: NotificationChannel,
  event: NotifyEvent,
  timeoutMs: number,
  budget?: ExternalRequestBudget,
): Promise<{ ok: boolean; error?: string }> {
  const key = channel.config.sendkey?.trim() ?? '';
  if (!key) return { ok: false, error: 'serverchan_key_required' };

  const title = buildTitle(event, channel.config.language);
  const body = buildMessage(event, channel.config.language);

  // `sctp<digits>t<token>` -> the account id is embedded in the key and becomes
  // the hostname.
  // `sctp<digits>t<token>` 的账户 ID 嵌在密钥中，并用作主机名。
  const current = key.match(/^sctp(\d+)t[A-Za-z0-9_-]+$/);
  if (!current) return { ok: false, error: 'serverchan_key_invalid' };
  const url = `https://${current[1]}.push.ft07.com/send/${encodeURIComponent(key)}.send`;

  const res = await budgetedFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    // Form-encoded, not JSON: ServerChan's API reads `title`/`desp` from the form
    // body. `desp` is the long field and `title` the short one.
    // 使用表单编码而非 JSON：ServerChan API 从表单体读取 `title`/`desp`；
    // `desp` 是长文本字段，`title` 是短文本字段。
    body: new URLSearchParams({ title, desp: body }).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  }, budget);

  if (!res.ok) return { ok: false, error: `http_${res.status}` };

  const json = await readJson(res);
  if (typeof json?.code !== 'number') return { ok: false, error: 'serverchan_invalid_response' };
  if (json.code !== 0) {
    return { ok: false, error: describe(json.message, json.info) ?? `serverchan_code_${json.code}` };
  }
  return { ok: true };
}

/** Generic webhook: structured JSON to any URL, 2xx is success; provider text surfaces on failure. / 通用 webhook：向任意 URL 发结构化 JSON，2xx 即成功；失败时显示提供商原文。 */
async function sendWebhook(
  channel: NotificationChannel,
  event: NotifyEvent,
  timeoutMs: number,
  budget?: ExternalRequestBudget,
): Promise<{ ok: boolean; error?: string }> {
  const url = channel.config.url?.trim() ?? '';
  if (!url) return { ok: false, error: 'webhook_url_required' };

  const res = await budgetedFetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Carried from the form when set, for endpoints that authenticate by header.
      // 表单设置时随请求发送，供通过请求头认证的端点使用。
      ...(channel.config.secret ? { authorization: `Bearer ${channel.config.secret.trim()}` } : {}),
    },
    body: JSON.stringify({
      event: event.status === 1 ? 'up' : event.status === 2 ? 'warn' : 'down',
      monitor: {
        name: event.monitorName,
        target: event.monitorTarget,
        type: event.monitorType,
      },
      status: event.status,
      prevStatus: event.prevStatus ?? null,
      // Stated explicitly rather than left for the consumer to infer, because
      // "went down" and "was already down" mean different things operationally.
      // 显式说明而非让消费者推断：运行上“刚刚故障”和“原本已故障”含义不同。
      transition: event.prevStatus === undefined
        ? `${STATE_LABEL[event.status]} (first reading)`
        : `${STATE_LABEL[event.prevStatus]} -> ${STATE_LABEL[event.status]}`,
      recovered: event.status === 1 && event.prevStatus === 0,
      message: event.message,
      time: new Date(event.at * 1000).toISOString(),
      text: buildMessage(event, channel.config.language),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  }, budget);

  if (res.ok) return { ok: true };
  const body = await res.text().catch(() => '');
  return { ok: false, error: body.trim() || `http_${res.status}` };
}
