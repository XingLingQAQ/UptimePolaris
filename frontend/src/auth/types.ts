import type { SetupDatabaseOptions } from '../../../shared/setup';

export interface SessionInfo {
  authenticated: boolean;
  user: { id: string; username: string } | null;
  /** True before the first administrator account is created. / 创建首个管理员账户前为 true。 */
  needsSetup: boolean;
  /** Accepted setup binding name; null after setup or when neither setup secret is configured. / 接受的设置绑定名称；设置完成或未配置设置密钥时为 null。 */
  setupCredential: 'ADMIN_TOKEN' | 'SETUP_KEY' | null;
  setupDatabase: SetupDatabaseOptions | null;
}

export interface AccountAvatarInfo {
  uploaded: boolean;
  url: string | null;
}
