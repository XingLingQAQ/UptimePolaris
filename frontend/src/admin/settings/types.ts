export type { MaintenanceWindow } from '../../../../shared/maintenance-window';

/** A setting's declared shape, as the form needs it. / 表单所需的设置声明结构。 */
export interface SettingSpec {
  key: string;
  default: unknown;
  /** True when an operator has chosen a value; false means the default applies. / 操作人员设置过值时为 true；false 表示使用默认值。 */
  stored: boolean;
  kind: 'string' | 'number' | 'boolean' | 'list';
}

/** Deployment-observed counters; mirrors UsageReport in src/lib/settings/usage.ts. / 部署环境观测到的计数，与 src/lib/settings/usage.ts 的 UsageReport 一致。 */
export interface UsageReport {
  runtime?: GoRuntimeUsage;
  /** The UTC day the counters cover, YYYY-MM-DD. / 计数覆盖的 UTC 日期，格式 YYYY-MM-DD。 */
  day: string;
  d1RowsRead: number;
  d1RowsWritten: number;
  statements: number;
  ticks: number;
  /** The busiest single tick today, against the per-invocation ceiling. / 今日最繁忙的一次 tick，用于对照每次调用的上限。 */
  peakSubrequests: number;
  limits: { d1RowsRead: number; d1RowsWritten: number; subrequests: number };
  /** False when nothing has been recorded today yet. / 今日尚无记录时为 false。 */
  observed: boolean;
  /** Which plan `limits` describes. / `limits` 对应的计划。 */
  plan: 'free' | 'paid';
}

export interface GoRuntimeUsage {
  backend: 'go';
  uptimeSeconds: number;
  goVersion: string;
  goroutines: number;
  heapAllocBytes: number;
  database: { type: 'sqlite' | 'postgres'; sizeBytes?: number; queries?: number };
  themes: { storage: 'filesystem' };
}

export interface SettingsResponse {
  values: Record<string, unknown>;
  /** Keys whose stored value failed validation and fell back to the default. / 存储值校验失败并回退到默认值的键。 */
  invalid: Array<{ key: string; reason: string }>;
  specs: SettingSpec[];
}

/** Icon metadata with an inline preview; uploaded:false selects the generated mark. / 含内联预览的图标元数据；uploaded:false 表示使用生成的标记。 */
export type SiteIconInfo =
  | { uploaded: false }
  | {
      uploaded: true;
      contentType: string;
      byteSize: number;
      filename: string | null;
      updatedAt: number;
      dataUrl: string;
    };
