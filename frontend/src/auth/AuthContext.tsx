import { SESSION_EXPIRED_EVENT } from '@/api/errors';
import { authApi } from '@/auth/api';
import type { SessionInfo } from '@/auth/types';
import { BrandLoader } from '@/components/ui/BrandLoader';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Navigate, useLocation } from 'react-router';
import { useTranslations } from 'use-intl';
import type { SetupDatabaseSelection } from '../../../shared/setup';

interface AuthState {
  /** Null while the session is still being resolved on first load. / 首次加载时会话尚在解析期间为 null。 */
  session: SessionInfo | null;
  sessionError: boolean;
  /** Sign in. Throws on failure so the form can render the message. / 登录；失败时抛错以便表单显示消息。 */
  login: (username: string, password: string) => Promise<void>;
  setup: (credential: string, username: string, password: string, database?: SetupDatabaseSelection) => Promise<void>;
  logout: () => Promise<void>;
  /** Re-read the session, e.g. after a password change. / 重新读取会话，例如在修改密码后。 */
  refresh: () => Promise<void>;
  /** Update session fields from the account-change response without another request. / 根据账户修改响应更新会话字段，无需额外请求。 */
  applyAccountChange: (username: string) => void;
}

const AuthContext = createContext<AuthState | null>(null);

/** Share one session lookup among account and console consumers. / 账户和控制台共用一次会话查询。 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessionError, setSessionError] = useState(false);

  const refresh = useCallback(async () => {
    // 网络错误单独保留为可重试状态，避免误判为未登录。 / Preserve network errors as retryable instead of treating them as signed out.
    setSessionError(false);
    try {
      setSession(await authApi.session());
    } catch {
      setSessionError(true);
    }
  }, []);

  useEffect(() => {
    const expired = () => {
      setSession({ authenticated: false, user: null, needsSetup: false, setupCredential: null, setupDatabase: null });
      setSessionError(false);
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, expired);
    void refresh();
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, expired);
  }, [refresh]);

  const login = useCallback(
    async (username: string, password: string) => {
      const res = await authApi.login(username, password);
      // 根据登录响应更新本地会话，避免再发一次会话查询。
      // Update local session state from the login response without another session lookup.
      setSession({
        authenticated: true,
        user: res.user,
        needsSetup: false,
        setupCredential: null,
        setupDatabase: null,
      });
      setSessionError(false);
    },
    [],
  );

  const setup = useCallback(async (credential: string, username: string, password: string, database?: SetupDatabaseSelection) => {
    const res = await authApi.setup(credential, username, password, database);
    setSession({
      authenticated: true,
      user: res.user,
      needsSetup: false,
      setupCredential: null,
      setupDatabase: null,
    });
    setSessionError(false);
  }, []);

  const logout = useCallback(async () => {
    await authApi.logout();
    setSession({
      authenticated: false,
      user: null,
      needsSetup: false,
      setupCredential: null,
      setupDatabase: null,
    });
    setSessionError(false);
  }, []);

  const applyAccountChange = useCallback((username: string) => {
    setSession((prev) =>
      prev?.user
        ? { ...prev, user: { ...prev.user, username } }
        : prev,
    );
  }, []);

  const value = useMemo<AuthState>(
    () => ({ session, sessionError, login, setup, logout, refresh, applyAccountChange }),
    [session, sessionError, login, setup, logout, refresh, applyAccountChange],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  // 调用方必须位于 Provider 内，才能共享会话状态。 / Consumers must be inside the Provider to share session state.
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

/** Resolve setup before sign-in; preserve the requested route for the post-login redirect. / 登录前先处理初始化，并保留请求路径供登录后跳转。 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const location = useLocation();

  // Undetermined: show a spinner rather than the login page. Redirecting before
  // the probe resolves would flash the login form at an already-signed-in user
  // on every page load.
  // 会话未确定时显示加载状态，避免已登录用户每次加载页面都闪现登录表单。
  if (!session) return <AuthSplash />;

  if (session.needsSetup) {
    return <Navigate to="/setup" replace state={{ from: location.pathname + location.search }} />;
  }

  if (!session.authenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  return <>{children}</>;
}

/** Full-screen hold while the session resolves. / 会话解析期间的全屏加载状态。 */
function AuthSplash() {
  const { sessionError, refresh } = useAuth();
  const t = useTranslations('admin');

  if (sessionError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background px-6 text-center">
        <p className="text-small text-default-500">{t('login.sessionUnavailable')}</p>
        <button type="button" className="text-small text-primary hover:underline" onClick={() => void refresh()}>
          {t('login.retrySession')}
        </button>
      </div>
    );
  }


  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background">
      <BrandLoader label={t('console.statusLoading')} />
    </div>
  );
}

export { AuthSplash };
