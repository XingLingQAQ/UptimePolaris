import { requestJson as request } from '../../api/client';
import type { CheckResult, Monitor, MonitorCheckResult, MonitorInput, ProbeAgentSource } from './types';

export const monitorsApi = {
  probeSources: () => request<{ agents: ProbeAgentSource[] }>('/api/agents/probe-sources'),
  listMonitors: () => request<{ monitors: Monitor[] }>('/api/monitors'),
  setVisibility: (ids: string[], isPublic: boolean) => request<{ ok: true; updated: number; is_public: boolean }>('/api/monitors/visibility', {
    method: 'POST', body: JSON.stringify({ ids, is_public: isPublic }),
  }),
  createMonitor: (input: MonitorInput) =>
    request<{ id: string }>('/api/monitors', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateMonitor: (id: string, input: Partial<MonitorInput>) =>
    request<{ ok: true }>(`/api/monitors/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  deleteMonitor: (id: string) =>
    request<{ ok: true }>(`/api/monitors/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  /** Check and persist a saved Worker monitor; unavailable, paused or unsupported monitors return an error. / 检查并保存 Worker 监控项的结果；不可用、暂停或不支持时返回错误。 */
  checkMonitor: (id: string) =>
    request<MonitorCheckResult>(`/api/monitors/${encodeURIComponent(id)}/check`, {
      method: 'POST',
    }),
  /** Run a check against arbitrary params without saving a monitor. / 使用给定参数运行检查，不保存监控项。 */
  testMonitor: (input: MonitorInput, signal?: AbortSignal) =>
    request<CheckResult>('/api/monitors/check', {
      method: 'POST',
      body: JSON.stringify(input),
      signal,
    }),
};
