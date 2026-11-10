import type { Tone } from '../../types/tone';
import type { MonitorType, ProbeAgentSource } from './types';
import { requiresAgentProbe, requiredProbeCapabilities } from '../../../../shared/probe-capabilities';

export function probeSourceReadiness(agent: ProbeAgentSource, required: string[]): 'ready' | 'waiting' | 'disabled' | 'upgrade' | 'offline' {
  if (!agent.active || !agent.probe_enabled) return 'disabled';
  if (!agent.installed) return 'waiting';
  if (!agent.online) return 'offline';
  if (!required.every(capability => agent.capabilities.includes(capability))) return 'upgrade';
  return 'ready';
}

export function canUseProbeType(type: MonitorType, agents: ProbeAgentSource[]): boolean {
  return !requiresAgentProbe(type) || agents.some(agent => probeSourceReadiness(agent, requiredProbeCapabilities(type)) === 'ready');
}

/** The console maps semantic status colors to its own palette. / 控制台将语义状态颜色映射到自己的调色板。 */

/**
 * Expiry and DNS checks are add-ons, not monitor types - see
 * `AddonChip` and `DnsChip`.
 *
 * Literal strings rather than message keys, deliberately. A protocol name is not
 * prose: `HTTP`, `TCP` and `PUSH` are identical in all nine catalogs.
 *
 * 到期与 DNS 检查是附加项而非监控类型；协议名在九种语言中相同，直接使用字面量。
 */
export const TYPE_LABEL: Record<MonitorType, string> = {
  http: 'HTTP',
  tcp: 'TCP',
  udp: 'UDP',
  icmp: 'ICMP',
  dns: 'DNS',
  tls: 'TLS',
  websocket: 'WebSocket',
  push: 'PUSH',
  agent: 'AGENT',
};

/**
 * What to print in the Reading column, or null for nothing.
 *
 * `v` is latency and nothing else for http/tcp; agent monitors carry CPU percent
 * there. Day counts live on the add-on readings.
 *
 * HTTP/TCP 的读数是延迟，Agent 的读数是 CPU 百分比；到期天数保存在附加项中。
 */
export function readingLabel(
  value: number,
  status: 0 | 1 | 2 | 4 | null,
  type?: MonitorType,
): string | null {
  if (status === null || type === 'push') return null;
  if (type === 'agent') return `${Math.round(value)}%`;
  return `${Math.round(value)}ms`;
}

/**
 * Map a monitor's live status to a tone.
 *
 * `null` (never checked) maps to the neutral tone rather than to `down`: a
 * monitor with no reading has not failed. `pending` (st 4) is its own orange:
 * "still retrying" and "add-on warning" are different operations.
 *
 * 未检查的 null 使用中性色而非故障色；pending 使用独立橙色，区分重试与附加项警告。
 */
export function toneForStatus(st: 0 | 1 | 2 | 4 | null): Tone {
  if (st === null) return 'idle';
  return st === 1 ? 'up' : st === 2 ? 'warn' : st === 4 ? 'pending' : 'down';
}
