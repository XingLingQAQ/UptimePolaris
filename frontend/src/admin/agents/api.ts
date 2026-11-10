import { requestJson as request } from '../../api/client';
import type { AgentCommandRecord, AgentDetailResponse, BatchCommandAction, BatchCommandResult, FleetAgent, FleetSummary } from './types';
import type { AgentConfigurationState, AgentRuntimeConfig } from '../../../../shared/agent-runtime-config';

export interface AgentGroup { id: string; name: string; weight: number; count: number }
export interface AgentTag { id: string; name: string; color: string; count: number }

export const taxonomyApi = {
  groups: () => request<{ groups: AgentGroup[] }>('/api/admin/agent-groups'),
  tags: () => request<{ tags: AgentTag[] }>('/api/admin/agent-tags'),
  save: (kind: 'groups' | 'tags', id: string | null, input: object) => request<{ id: string }>(`/api/admin/agent-${kind}${id ? `/${encodeURIComponent(id)}` : ''}`, { method: id ? 'PUT' : 'POST', body: JSON.stringify(input) }),
  remove: (kind: 'groups' | 'tags', id: string) => request<{ ok: true }>(`/api/admin/agent-${kind}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  assign: (id: string, group_id: string | null, tag_ids: string[]) => request<{ ok: true }>(`/api/admin/agents/${encodeURIComponent(id)}/taxonomy`, { method: 'PUT', body: JSON.stringify({ group_id, tag_ids }) }),
};

export const agentsApi = {
  createAgent: (input: { name: string; probe_enabled: boolean; is_public?: boolean }) => request<{ id: string; token: string }>('/api/admin/agents', { method: 'POST', body: JSON.stringify(input) }),
  setVisibility: (ids: string[], is_public: boolean) => request<{ok:true;updated:number;is_public:boolean}>('/api/admin/agents/visibility',{method:'POST',body:JSON.stringify({ids,is_public})}),
  configuration: (id: string) => request<AgentConfigurationState>(`/api/admin/agents/${encodeURIComponent(id)}/config`),
  saveConfiguration: (id: string, config: AgentRuntimeConfig, expected_revision: string | null) => request<{ ok: true; revision: string }>(`/api/admin/agents/${encodeURIComponent(id)}/config`, { method: 'PUT', body: JSON.stringify({ config, expected_revision }) }),
  listAgents: () => request<{ agents: FleetAgent[]; summary: FleetSummary }>('/api/admin/agents'),
  renameAgent: (id: string, name: string) =>
    request<{ ok: true; name: string }>(`/api/admin/agents/${encodeURIComponent(id)}/rename`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  /** Pause or resume an agent. / 暂停或恢复 Agent。 */
  setAgentActive: (id: string, active: boolean) =>
    request<{ ok: true; active: boolean }>(`/api/admin/agents/${encodeURIComponent(id)}/active`, {
      method: 'POST',
      body: JSON.stringify({ active }),
    }),
  /** Take an agent in or out of edge probe rotation. / 将 Agent 加入或移出边缘探测轮转。 */
  setAgentProbeEnabled: (id: string, enabled: boolean) =>
    request<{ ok: true; probe_enabled: boolean }>(`/api/admin/agents/${encodeURIComponent(id)}/probe`, {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }),
  removeAgent: (id: string) =>
    request<{ ok: true }>(`/api/admin/agents/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** Command lists include the feature switch and required capability for button availability. / 命令列表包含功能开关和所需能力，用于确定按钮是否可用。 */
  issueCommand: (id: string, action: string) =>
    request<{ ok: true; id: string }>(`/api/admin/agents/${encodeURIComponent(id)}/commands`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    }),
  listCommands: (id: string, limit = 20, signal?: AbortSignal) =>
    request<{ commands: AgentCommandRecord[]; enabled: boolean; capability: string }>(
      `/api/admin/agents/${encodeURIComponent(id)}/commands?limit=${limit}`,
      { signal },
    ),
  /** Everything the detail dialog shows beyond the fleet row. / 详情对话框中除 Agent 列表行之外的内容。 */
  agentDetail: (id: string, signal?: AbortSignal) =>
    request<AgentDetailResponse>(`/api/admin/agents/${encodeURIComponent(id)}/detail`, { signal }),
  /** Queue one action for many machines; the response is per machine. / 为多台机器排队执行同一操作；响应按机器返回。 */
  batchCommands: (ids: string[], action: BatchCommandAction) =>
    request<{ results: BatchCommandResult[] }>('/api/admin/agents/batch-commands', {
      method: 'POST',
      body: JSON.stringify({ ids, action }),
    }),
};
