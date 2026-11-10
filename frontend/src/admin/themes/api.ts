import { requestJson as request } from '../../api/client';
import type { InstalledTheme, InstallResult, ThemePreview } from './types';

export const themesApi = {
  list: () => request<{ themes: InstalledTheme[]; storageReady: boolean }>('/api/themes'),
  install: (url: string) => request<InstallResult>('/api/themes/install', { method: 'POST', body: JSON.stringify({ url }) }),
  upload: (file: File) => request<InstallResult>('/api/themes/install', { method: 'POST', headers: { 'content-type': 'application/zip' }, body: file }),
  remove: (short: string) => request<{ ok: true; short: string }>(`/api/themes/${encodeURIComponent(short)}`, { method: 'DELETE' }),
  updateCheck: (short: string) => request<{ available: boolean; current: string; latest: string | null; digest?: string }>(`/api/themes/${encodeURIComponent(short)}/update-check`),
  preview: (short: string, versionKey: string, theme: string) => request<ThemePreview>(`/api/themes/${encodeURIComponent(short)}/preview?version=${encodeURIComponent(versionKey)}&theme=${encodeURIComponent(theme)}`),
};
