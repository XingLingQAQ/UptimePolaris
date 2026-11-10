/** Runtime defaults and validation for app_settings; deployment bindings and secrets remain in Worker configuration. / app_settings 的运行时默认值和验证；部署绑定与密钥仍留在 Worker 配置中。 */

import type { Env } from '../../types';
import { PROJECT_NAME } from '../../../../../shared/project';
import { getDB } from '../db/factory';
import { databaseIdentity } from '../db/setup-control';
import { settingsSQL } from '../db/sql/settings';

/** Every setting this build understands, with its default and validator. / 此构建认识的所有设置及其默认值和验证器。 */
export interface SettingSpec<T> {
  default: T;
  /** Validate writes and stored values; readAll reports rejected rows and uses the declared default. / 验证写入值和存储值；readAll 报告被拒绝的记录并使用声明的默认值。 */
  parse: (value: unknown) => T | null;
}

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

/** Accept JSON numbers within the inclusive integer range. / 接受闭区间整数范围内的 JSON 数字。 */
function intIn(min: number, max: number): (value: unknown) => number | null {
  return (value) => (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null);
}

/** Require nonblank text within the length limit; preserve the submitted whitespace. / 要求长度限制内的非空白文本；保留提交的空白字符。 */
function text(maxLength: number): (value: unknown) => string | null {
  return (value) =>
    typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength ? value : null;
}

/** An HTTP(S) URL, or a site-relative path (which is how the built-in icon works). / HTTP(S) URL 或站点相对路径（内置图标采用后者）。 */
function urlOrPath(maxLength: number): (value: unknown) => string | null {
  return (value) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return null;
    if (value.startsWith('/')) return value;
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? value : null;
    } catch {
      return null;
    }
  };
}

export { parseWindow, type MaintenanceWindow } from '../../../../../shared/maintenance-window';
import { parseWindow, type MaintenanceWindow } from '../../../../../shared/maintenance-window';

function windowList(maxItems: number): (value: unknown) => MaintenanceWindow[] | null {
  return (value) => {
    if (!Array.isArray(value) || value.length > maxItems) return null;
    const out: MaintenanceWindow[] = [];
    for (const item of value) {
      const parsed = parseWindow(item);
      if (!parsed) return null;
      out.push(parsed);
    }
    return out;
  };
}

/** Setting keys derive from this registry; validators and defaults travel together. / 设置键从此注册表派生，使验证器和默认值保持一致。 */
export const SPECS = {
  'site.title': { default: PROJECT_NAME, parse: text(120) },
  'site.description': { default: '服务可用性监控', parse: text(300) },
  'site.icon': { default: '/api/public/icon', parse: urlOrPath(2048) },

  /** Defaults applied on creation; the minute scheduler sets the 60-second interval floor. / 创建时应用的默认值；分钟调度器规定最短间隔为 60 秒。 */
  'monitor.defaultIntervalSec': { default: 60, parse: intIn(60, 86400) },
  'monitor.defaultTimeoutMs': { default: 10000, parse: intIn(1000, 60000) },
  'monitor.defaultRetries': { default: 3, parse: intIn(0, 10) },

  /** Retention defaults used by sync cleanup. / 同步清理使用的默认保留期。 */
  'retention.availabilityDays': { default: 400, parse: intIn(7, 3650) },
  'retention.detailDays': { default: 90, parse: intIn(1, 3650) },
  'retention.eventDays': { default: 90, parse: intIn(1, 3650) },

  /** Maintenance windows: checks still run, alerts are held. / 维护窗口：检查继续运行，告警暂缓发送。 */
  'alerts.maintenanceWindows': { default: [] as MaintenanceWindow[], parse: windowList(32) },
  'alerts.maintenanceNote': { default: '', parse: (v) => (typeof v === 'string' && v.length <= 300 ? v : null) },
  'maintenance.enabled': { default: false, parse: (v) => (isBool(v) ? v : null) },
  'maintenance.scheduleEnabled': { default: false, parse: (v) => (isBool(v) ? v : null) },
  'maintenance.announcementTitle': { default: '', parse: (v) => (typeof v === 'string' && v.length <= 120 ? v : null) },
  'maintenance.announcementDescription': { default: '', parse: (v) => (typeof v === 'string' && v.length <= 1000 ? v : null) },
  'maintenance.title': { default: '', parse: (v) => (typeof v === 'string' && v.length <= 120 ? v : null) },
  'maintenance.description': { default: '', parse: (v) => (typeof v === 'string' && v.length <= 1000 ? v : null) },

  /** Runtime session and throttle settings; password-hashing cost remains a deployment setting. / 运行时会话和限流设置；密码哈希成本仍由部署配置。 */
  'security.sessionTtlDays': { default: 14, parse: intIn(1, 365) },
  'security.loginMaxAttempts': { default: 8, parse: intIn(3, 100) },
  'security.loginWindowSec': { default: 300, parse: intIn(60, 86400) },

  /** Agent command channel, default off because it widens the trust surface. / Agent 指令通道，默认关闭，因为它扩大信任面。 */
  'security.allowAgentCommands': { default: false, parse: (v) => (isBool(v) ? v : null) },

  /** Fetch monitored sites' favicons; default off because it makes outbound calls to arbitrary hosts. / 抓取被监控站点图标，默认关闭，因为它会访问任意主机。 */
  'site.syncMonitorIcons': { default: false, parse: (v) => (isBool(v) ? v : null) },
} as const satisfies Record<string, SettingSpec<unknown>>;

export type SettingKey = keyof typeof SPECS;

/** The value type of one key, derived from its spec so the two cannot drift. / 根据键的规格派生其值类型，避免两者不一致。 */
export type SettingValue<K extends SettingKey> = (typeof SPECS)[K]['default'];

export const SETTING_KEYS = Object.keys(SPECS) as SettingKey[];

/** All declared runtime settings are currently writable through the console. / 当前所有声明的运行时设置均可通过控制台写入。 */
export const WRITABLE_KEYS: ReadonlySet<SettingKey> = new Set(SETTING_KEYS);

// Writes invalidate this isolate; other isolates refresh after the TTL.
// 写入使当前 isolate 的缓存失效；其他 isolate 在 TTL 后刷新。
const CACHE_TTL_MS = 15_000;
let cache: { at: number; target: string | D1Database; values: Record<SettingKey, unknown> } | null = null;

/** Test hook: drop the cache so a suite can assert a value it just wrote. / 测试钩子：清除缓存，使测试可断言刚写入的值。 */
export function resetSettingsCache(): void {
  cache = null;
}

/** Values resolved against declared defaults; invalid lists rejected stored rows on a fresh read. / 按声明默认值解析的设置；invalid 列出本次新读取中被拒绝的存储记录。 */
export interface SettingsSnapshot {
  values: Record<SettingKey, unknown>;
  /** Keys whose stored value was rejected, with the reason. / 存储值被拒绝的键及其原因。 */
  invalid: Array<{ key: string; reason: string }>;
}

export async function readAll(env: Env, fresh = false): Promise<SettingsSnapshot> {
  const now = Date.now();
  if (!fresh && cache && cache.target === databaseIdentity(env) && now - cache.at < CACHE_TTL_MS) {
    return { values: cache.values as Record<SettingKey, unknown>, invalid: [] };
  }

  const values = {} as Record<SettingKey, unknown>;
  for (const key of SETTING_KEYS) values[key] = SPECS[key].default;

  const invalid: Array<{ key: string; reason: string }> = [];
  let rows: Array<{ key: string; value_json: string }> = [];
  try {
    const db = getDB(env);
    rows = await db.query<{ key: string; value_json: string }>(settingsSQL[db.type].load);
  } catch {
    // A settings query failure yields the complete default configuration.
    // 设置查询失败时返回完整默认配置。
    return { values, invalid };
  }

  for (const row of rows) {
    if (!Object.hasOwn(SPECS, row.key)) {
      // A dropped setting stays in the table but is reported as leftover. / 已移除的设置保留在表中，但会报告为遗留项。
      invalid.push({ key: row.key, reason: 'unknown_key' });
      continue;
    }
    const key = row.key as SettingKey;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(row.value_json);
    } catch {
      invalid.push({ key, reason: 'invalid_json' });
      continue;
    }
    const accepted = SPECS[key].parse(parsedJson);
    if (accepted === null) {
      invalid.push({ key, reason: 'invalid_value' });
      continue;
    }
    values[key] = accepted;
  }

  cache = { at: now, target: databaseIdentity(env), values };
  return { values, invalid };
}

/** Read one setting, already narrowed to its declared type. / 读取单项设置，结果已收窄为声明的类型。 */
export async function readSetting<K extends SettingKey>(env: Env, key: K): Promise<SettingValue<K>> {
  const { values } = await readAll(env);
  return values[key] as SettingValue<K>;
}

export async function writeSettings(env: Env, values: Partial<Record<SettingKey, unknown>>): Promise<void> {
  const db = getDB(env);
  const now = Math.floor(Date.now() / 1000);
  await db.commit(Object.entries(values).map(([key, value]) => ({
    sql: settingsSQL[db.type].upsert,
    params: [key, JSON.stringify(value), now],
  })));
  resetSettingsCache();
}

/** Remove an override, so the key falls back to its declared default. / 删除覆盖值，使键回退到声明的默认值。 */
export async function clearSetting(env: Env, key: string): Promise<boolean> {
  if (!Object.hasOwn(SPECS, key)) return false;
  const db = getDB(env);
  await db.execute(settingsSQL[db.type].remove, [key]);
  resetSettingsCache();
  return true;
}

/** Public site identity resolved from the shared settings snapshot. / 从共享设置快照解析的公共站点信息。 */
export interface SiteMetadata {
  title: string;
  description: string;
  icon: string;
}

export async function readSiteMetadata(env: Env): Promise<SiteMetadata> {
  const { values } = await readAll(env);
  return {
    title: values['site.title'] as string,
    description: values['site.description'] as string,
    icon: values['site.icon'] as string,
  };
}
