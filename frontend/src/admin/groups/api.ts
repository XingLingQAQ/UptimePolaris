import { requestJson as request } from '../../api/client';
import type { MonitorGroup, Tag } from './types';
import type { GroupType, ManagedGroup } from '../../../../shared/groups';

export const managementApi = {
  list: () =>
    request<{ groups: ManagedGroup[]; agentEnabled: boolean }>(
      '/api/admin/groups',
    ),
  save: (
    key: string | null,
    input: {
      name: string;
      weight: number;
      type: GroupType;
      confirm_membership_reset?: boolean;
    },
  ) =>
    request('/api/admin/groups' + (key ? `/${encodeURIComponent(key)}` : ''), {
      method: key ? 'PUT' : 'POST',
      body: JSON.stringify(input),
    }),
  remove: (key: string, scope: 'all' | 'monitor' | 'agent') =>
    request(`/api/admin/groups/${encodeURIComponent(key)}?scope=${scope}`, {
      method: 'DELETE',
    }),
  members: (
    key: string,
    kind: 'monitor' | 'agent',
    action: 'add' | 'remove',
    ids: string[],
  ) =>
    request(`/api/admin/groups/${encodeURIComponent(key)}/members`, {
      method: 'PUT',
      body: JSON.stringify({ kind, action, ids }),
    }),
};

export const groupsApi = {
  /** Flat vocabularies; console membership counts come from overview monitors. / 平铺的分组词表；控制台成员数量来自概览中的监控项。 */
  listGroups: () => request<{ groups: MonitorGroup[] }>('/api/groups'),
  createGroup: (input: { name: string; weight?: number }) =>
    request<{ id: string }>('/api/groups', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateGroup: (id: string, input: { name?: string; weight?: number }) =>
    request<{ ok: true }>(`/api/groups/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  deleteGroup: (id: string) =>
    request<{ ok: true }>(`/api/groups/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
};

export const tagsApi = {
  listTags: () => request<{ tags: Tag[] }>('/api/tags'),
  createTag: (input: { name: string; color?: string }) =>
    request<{ id: string }>('/api/tags', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateTag: (id: string, input: { name?: string; color?: string }) =>
    request<{ ok: true }>(`/api/tags/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  deleteTag: (id: string) =>
    request<{ ok: true }>(`/api/tags/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
};
