import { requestJson as request } from '../../api/client';
import type { SettingsResponse, SiteIconInfo, UsageReport } from './types';

export const settingsApi = {
  /** Observed usage counters and configured plan limits, rather than account quota remaining. / 观测到的使用计数和配置的计划上限，不是账户剩余额度。 */
  usage: () => request<UsageReport>('/api/admin/usage'),
  /** Runtime settings, plus the spec metadata a form needs to render them. / 运行时设置及表单渲染所需的声明元数据。 */
  listSettings: () => request<SettingsResponse>('/api/admin/settings'),
  updateSettings: (values: Record<string, unknown>) =>
    request<{ ok: true; values: Record<string, unknown> }>('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify(values),
    }),
  resetSetting: (key: string) =>
    request<{ ok: true; value: unknown }>(`/api/admin/settings/${encodeURIComponent(key)}`, { method: 'DELETE' }),
};

/** Icon uploads send a raw image body and filename header. / 图标上传发送原始图片请求体和文件名请求头。 */
export const siteIconApi = {
  /** The stored icon, or `{uploaded:false}` when the generated mark is in use. / 已存储图标；使用生成标记时返回 `{uploaded:false}`。 */
  read: () => request<SiteIconInfo>('/api/admin/site-icon'),

  upload: (file: File) => request<{ ok: true; contentType: string; byteSize: number; filename: string | null; updatedAt: number }>(
    '/api/admin/site-icon', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': file.type || 'application/octet-stream',
        'x-icon-filename': encodeURIComponent(file.name),
      },
      body: file,
    },
  ),

  remove: () => request<{ ok: true; uploaded: false }>('/api/admin/site-icon', { method: 'DELETE' }),
};
