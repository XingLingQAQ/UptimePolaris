import { ApiError } from '@/api/errors';
import { ThemeSwitch } from '@/components/ui/ThemeSwitch';
import { LocaleSwitch } from '@/i18n/LocaleSwitch';
import { buildIconProxyUrl } from '@/lib/icon-proxy';
import { CONTENT_TRANSITION } from '@/lib/motion';
import { PROJECT_NAME } from '@/lib/project';
import '@/styles/console.css';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import { Button, Input } from '@heroui/react';
import { motion } from 'framer-motion';
import {
  AlertCircle,
  ArrowRight,
  ArrowUpRight,
  Loader2,
  Lock,
  UserRound,
} from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { useTranslations } from 'use-intl';
import { AuthSplash, useAuth } from './AuthContext';
import { AuthProductPanel } from './AuthProductPanel';
import { PasswordInput } from './PasswordInput';

/**
 * The brand mark, cropped to its ink.
 *
 * `tight` matters: the mark occupies only 72% of its canvas, so a padded 28px
 * render showed a ring about 20px across and read as undersized next to the
 * wordmark. The `v` query comes from the shared helper so caches can be busted.
 * 图形只占画布 72%，紧裁后才不会显得比字标小。
 */
const BRAND_ICON = buildIconProxyUrl(undefined, { tight: true });

/** Where to land after a successful sign-in when no origin was recorded. / 未记录来源时登录成功后的默认目的地。 */
const DEFAULT_REDIRECT = '/admin';

/**
 * Full-page sign-in, deliberately outside the console shell.
 *
 * The console chrome (nav rail, account menu, page title) presupposes a
 * signed-in user, and rendering it around a login form would make the one
 * screen that must not leak console information render the most of it.
 * 全页登录；控制台外壳假定已登录，套在登录页会泄露最多的后台信息。
 */
export function LoginPage() {
  const t = useTranslations('admin');
  const { session, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Password field ref.
   *
   * HeroUI's type says the ref is the input, but at runtime it forwards the
   * wrapper `<div>`, so `ref.current.focus()` silently did nothing and focus
   * fell to `<body>`. Look one level down for the real `<input>`; tolerate both
   * shapes in case the library changes.
   * HeroUI 运行时转发外层 div；直接 focus 无效，需要再找真实 input。
   */
  const passwordRef = useRef<HTMLInputElement>(null);

  function focusPassword() {
    const node = passwordRef.current;
    if (!node) return;
    if (node instanceof HTMLInputElement) {
      node.focus();
      return;
    }
    (node as unknown as HTMLElement).querySelector('input')?.focus();
  }

  /**
   * Post-login target, read from router state populated by `RequireAuth`.
   * Only same-origin paths are honoured: a crafted `from` pointing at another
   * origin would turn the login page into an open redirect.
   * 只接受同源路径，避免登录页变成开放重定向。
   */
  const from = (() => {
    const candidate = (location.state as { from?: string } | null)?.from;
    if (candidate && candidate.startsWith('/') && !candidate.startsWith('//')) return candidate;
    return DEFAULT_REDIRECT;
  })();

  // Already signed in: skip the form. Covers the Back button after a login and
  // a revisited bookmarked /login.
  // 已登录时跳过表单，覆盖登录后后退及再次打开登录书签的情况。
  useEffect(() => {
    if (session?.authenticated) navigate(from, { replace: true });
  }, [session, navigate, from]);

  /** Per-page tab title, restored on unmount. / 页面标题，卸载时恢复。 */
  useEffect(() => {
    const previous = document.title;
    document.title = `${t('login.title')} · ${PROJECT_NAME}`;
    return () => {
      document.title = previous;
    };
  }, [t]);

  /*
    A deployment with no account yet.

    This page used to grow a second mode for that case - an extra credential
    field, a different button label, a different `autocomplete` token - which left
    every part of the form meaning one of two things depending on a flag, with no
    single place to read what it did. Initialization is a different job, so it is
    a different page; all that is left to do here is send the operator to it.

    Placed after every hook, not beside the redirects above: an early return from
    the middle of the component would skip the title effect on the way to /setup
    and change the hook list between renders.

    尚未创建账户时跳转到独立初始化页，避免登录表单的凭据字段、按钮、自动填充标记
    和错误文案随模式改变含义。该判断放在所有 Hook 之后，避免跳过标题 effect
    或改变不同渲染之间的 Hook 列表。
  */
  if (session?.needsSetup) return <Navigate to="/setup" replace state={location.state} />;

  if (!session) return <AuthSplash />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting || !username.trim() || !password) return;

    setSubmitting(true);
    setError(null);
    try {
      await login(username, password);
      // AuthProvider has the session by now; the effect above performs the
      // redirect. Navigating here as well would race it and could push a
      // duplicate history entry.
      // AuthProvider 更新会话后由上方 effect 跳转，避免重复导航和历史记录。
    } catch (err) {
      setError(readableError(err, t));
      /** Focus next frame, after `isDisabled` clears. / 下一帧再聚焦，等 `isDisabled` 清除。 */
      requestAnimationFrame(focusPassword);
    } finally {
      setSubmitting(false);
    }
  }

  if (!session) return <AuthSplash />;

  return (
    <div className="polaris flex min-h-dvh bg-[var(--polaris-canvas)] text-[var(--polaris-ink)]">
      <AuthProductPanel />

      {/* Form column / 表单列 */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between px-6 sm:px-8">
          <Brand compact />
          <div className="flex items-center gap-0.5 text-[var(--polaris-ink-3)] [&_button]:h-8 [&_button]:w-8 [&_button]:min-w-8 [&_svg]:h-[17px] [&_svg]:w-[17px]">
            <ThemeSwitch radius="md" />
            <LocaleSwitch />
          </div>
        </header>

        <div className="flex flex-1 items-center justify-center px-6 pb-16">
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={CONTENT_TRANSITION} className="w-full max-w-[22rem]">
            <div className="mb-8">
              <span className="mb-6 inline-flex h-11 w-11 items-center justify-center rounded-xl border border-[var(--polaris-line)] bg-[var(--polaris-card)] shadow-[0_1px_2px_rgb(0_0_0/0.05)]">
                <img src={BRAND_ICON} alt="" width={24} height={24} />
              </span>
              <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.025em]">{t('login.title')}</h1>
              <p className="mt-1.5 text-[13.5px] text-[var(--polaris-ink-3)]">{t('login.subtitle')}</p>
            </div>

            <form onSubmit={onSubmit} className="flex flex-col gap-3.5" noValidate>
              <Input
                autoFocus
                isRequired
                label={t('login.username')}
                labelPlacement="outside"
                autoComplete="username"
                value={username}
                onValueChange={setUsername}
                isDisabled={submitting}
                startContent={<UserRound size={15} className="shrink-0 text-[var(--polaris-ink-4)]" />}
              />

              <PasswordInput
                ref={passwordRef}
                isRequired
                label={t('login.password')}
                labelPlacement="outside"
                // `current-password` is what lets a password manager fill it and
                // offer to save a changed one; `new-password` here would break both.
                // `current-password` 允许密码管理器填充并提供保存；此处使用 `new-password` 会破坏这些行为。
                autoComplete="current-password"
                value={password}
                onValueChange={setPassword}
                isDisabled={submitting}
                startContent={<Lock size={15} className="shrink-0 text-[var(--polaris-ink-4)]" />}
              />

              {/*
                role="alert" so the failure is announced. The message is generic
                on purpose and matches what the Worker returns.
                使用 role="alert" 播报错误；文案有意保持通用并与 Worker 的返回一致。
              */}
              {error ? (
                <p
                  role="alert"
                  className="flex items-start gap-2 rounded-[10px] border border-danger/20 bg-danger/[0.04] px-3 py-2.5 text-[12.5px] text-danger-600"
                >
                  <AlertCircle size={15} className="mt-px shrink-0" />
                  {error}
                </p>
              ) : null}

              <Button
                type="submit"
                color="primary"
                className="mt-2 h-10 w-full text-[13.5px] font-medium shadow-[0_1px_2px_rgb(0_0_0/0.12),inset_0_1px_0_rgb(255_255_255/0.08)]"
                isDisabled={submitting || !username.trim() || !password}
                startContent={submitting ? <Loader2 className="animate-spin" size={16} /> : null}
                endContent={submitting ? null : <ArrowRight size={16} />}
              >
                {submitting ? t('login.submitting') : t('login.submit')}
              </Button>
            </form>

            <div className="mt-8 flex items-center gap-3 text-[12px] text-[var(--polaris-ink-4)]">
              <span className="h-px flex-1 bg-[var(--polaris-line)]" />
              <span>{t('login.backToStatus')}</span>
              <span className="h-px flex-1 bg-[var(--polaris-line)]" />
            </div>
            <a
              href="/"
              className="mt-3 flex h-10 items-center justify-center gap-1.5 rounded-lg border border-[var(--polaris-line-strong)] bg-[var(--polaris-card)] text-[13px] font-medium text-[var(--polaris-ink-2)] shadow-[0_1px_1px_rgb(0_0_0/0.03)] transition-colors hover:border-[var(--polaris-ink-4)] hover:text-[var(--polaris-ink)]"
            >
              {t('nav.viewStatus')}
              <ArrowUpRight size={14} />
            </a>
          </motion.div>
        </div>

        <p className="px-6 pb-6 text-center text-[11.5px] text-[var(--polaris-ink-4)] lg:text-left">{t('login.footer', { year: new Date().getFullYear() })}</p>
      </main>


    </div>
  );
}

/** Mark plus wordmark; the ring is sized up to match optical weight. / 图标加字标；圆环放大以匹配视觉重量。 */
function Brand({ compact = false }: { compact?: boolean }) {
  const markSize = compact ? 22 : 30;
  // No sub-wordmark: the page already prints the localized tagline. / 不叠加字标：页面已显示本地化标语。
  return (
    <span className="flex items-center gap-2.5">
      <img src={BRAND_ICON} alt="" width={markSize} height={markSize} />
      <span className={compact ? 'text-[15px] font-semibold tracking-[-0.02em]' : 'text-lg font-semibold tracking-tight'}>
        {PROJECT_NAME}
      </span>
    </span>
  );
}

/** Map transport errors to actionable text; 401 is invalid credentials. / 把传输错误映射为可操作文本；401 是凭据错误。 */
function readableError(err: unknown, t: ReturnType<typeof useTranslations>): string {
  const code = err instanceof Error ? err.message : String(err);
  if (code === 'invalid_credentials') return t('login.invalid');
  if (code === 'invalid_auth_config') return t('login.authConfigInvalid');
  if (code === 'database_unavailable') return t('login.dbUnavailable');
  if (code === 'network_error') return t('login.network');
  if (err instanceof ApiError && err.status >= 500) return t('login.dbUnavailable');
  return t('login.failed');
}
