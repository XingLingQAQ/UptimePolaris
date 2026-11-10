/** 前后端与 Agent 共享的可远程调整配置。 / Remotely adjustable configuration shared by the frontend, backend, and Agent. */
export interface AgentRuntimeConfig {
  sample_interval_secs: number;
  report_interval_secs: number;
  include_nics: string[];
  exclude_nics: string[];
  include_mounts: string[];
  exclude_mounts: string[];
  auto_update: boolean;
}

/** Agent 上报的安装信息与自动更新能力。 / Installation details and automatic update capability reported by the Agent. */
export interface AgentInstallationInfo {
  service_tier: string | null;
  config_path: string;
  executable_path: string;
  auto_update_supported: boolean;
}

/** 控制台展示的当前配置、期望版本及同步状态。 / Current configuration, desired revision, and sync state shown in the console. */
export interface AgentConfigurationState {
  supported: boolean;
  allowed: boolean;
  current: AgentRuntimeConfig | null;
  installation: AgentInstallationInfo | null;
  desired: AgentRuntimeConfig | null;
  desired_revision: string | null;
  applied_revision: string | null;
  status: 'unreported' | 'synced' | 'pending' | 'error';
  error: string | null;
}

/** 校验完整配置契约并去重过滤列表；无效输入返回 null。 / Validate the full configuration and deduplicate filter lists; return null for invalid input. */
export function parseAgentRuntimeConfig(value: unknown): AgentRuntimeConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = ['sample_interval_secs', 'report_interval_secs', 'include_nics', 'exclude_nics', 'include_mounts', 'exclude_mounts', 'auto_update'];
  if (Object.keys(row).length !== keys.length || Object.keys(row).some((key) => !keys.includes(key))) return null;
  const sample = row.sample_interval_secs;
  const report = row.report_interval_secs;
  if (typeof sample !== 'number' || typeof report !== 'number' || !Number.isInteger(sample) || !Number.isInteger(report) || sample < 1 || sample > report || report > 1800 || typeof row.auto_update !== 'boolean') return null;
  const lists: string[][] = [];
  for (const key of keys.slice(2, 6)) {
    const list = row[key];
    if (!Array.isArray(list) || list.length > 32 || !list.every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 256 && !/[\u0000-\u001f\u007f]/.test(entry))) return null;
    lists.push([...new Set(list)]);
  }
  return { sample_interval_secs: sample, report_interval_secs: report, include_nics: lists[0], exclude_nics: lists[1], include_mounts: lists[2], exclude_mounts: lists[3], auto_update: row.auto_update };
}

/** Filter membership is significant; order and duplicates are not. / 过滤列表按成员比较，忽略顺序和重复。 */
export function sameAgentRuntimeConfig(left: AgentRuntimeConfig, right: AgentRuntimeConfig): boolean {
  if (left.sample_interval_secs !== right.sample_interval_secs || left.report_interval_secs !== right.report_interval_secs || left.auto_update !== right.auto_update) return false;
  for (const key of ['include_nics', 'exclude_nics', 'include_mounts', 'exclude_mounts'] as const) {
    const expected = new Set(left[key]);
    const actual = new Set(right[key]);
    if (expected.size !== actual.size || [...expected].some((value) => !actual.has(value))) return false;
  }
  return true;
}
