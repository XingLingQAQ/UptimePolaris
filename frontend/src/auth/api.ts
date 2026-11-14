import { requestJson as request } from '../api/client';
import type { AccountAvatarInfo, SessionInfo } from './types';
import type { SetupDatabaseSelection } from '../../../shared/setup';

/** Requires the current password; omitted next/username fields are unchanged, but omitting both is rejected. / 需要当前密码；省略的 next 或 username 保持不变，但不能同时省略。 */
function changeAccount(current: string, fields: { next?: string; username?: string }) {
  return request<{ ok: true; username: string }>('/api/auth/account', {
    method: 'POST',
    body: JSON.stringify({ current, ...fields }),
  });
}

export const authApi = {
  session: () => request<SessionInfo>('/api/auth/session'),

  setup: (credential: string, username: string, password: string, database?: SetupDatabaseSelection) =>
    request<{ ok: true; user: { id: string; username: string } }>(
      '/api/auth/setup',
      { method: 'POST', body: JSON.stringify({ credential, username, password, database }) },
    ),

  configureDatabase: (credential: string, database: SetupDatabaseSelection) =>
    request<{ ok: true; type: SetupDatabaseSelection['type']; configurationId?: string }>('/api/auth/setup/database', {
      method: 'POST', body: JSON.stringify({ credential, database }),
    }),

  login: (username: string, password: string) =>
    request<{ ok: true; user: { id: string; username: string } }>(
      '/api/auth/login',
      {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      },
    ),

  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),

  changeAccount,

  /** Change the password only. The route is the same one, without a username. / 仅修改密码；使用相同路由但不传用户名。 */
  changePassword: (current: string, next: string) => changeAccount(current, { next }),
};

export const accountAvatarApi = {
  read: () => request<AccountAvatarInfo>('/api/auth/avatar'),
  upload: (image: Blob) => request<AccountAvatarInfo>('/api/auth/avatar', {
    method: 'POST', headers: { 'content-type': 'image/png' }, body: image,
  }),
  remove: () => request<AccountAvatarInfo>('/api/auth/avatar', { method: 'DELETE' }),
};
