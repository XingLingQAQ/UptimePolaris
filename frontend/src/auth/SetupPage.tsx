import { settingsApi } from '@/admin/settings/api';
import { ApiError } from '@/api/errors';
import { ThemeSwitch } from '@/components/ui/ThemeSwitch';
import { Select } from '@/components/ui/MotionOverlays';
import { LocaleSwitch } from '@/i18n/LocaleSwitch';
import { buildIconProxyUrl } from '@/lib/icon-proxy';
import { CONTENT_TRANSITION } from '@/lib/motion';
import { PROJECT_NAME } from '@/lib/project';
import '@/styles/console.css';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import { Button, Input, SelectItem } from '@heroui/react';
import { motion } from 'framer-motion';
import {
  AlertCircle,
  ArrowRight,
  Check,
  CircleCheck,
  CircleDashed,
  KeyRound,
  Loader2,
  Lock,
  RefreshCw,
  Sparkles,
  UserRound,
} from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { useTranslations } from 'use-intl';
import { AuthSplash, useAuth } from './AuthContext';
import { AuthProductPanel } from './AuthProductPanel';
import { PasswordInput } from './PasswordInput';
import type { SetupDatabaseType, SetupRequirement, SetupRequirementKey } from '../../../shared/setup';

/** Brand mark, cropped to its ink - the same helper the sign-in page uses. / 裁去留白的品牌标记，与登录页使用相同辅助函数。 */
const BRAND_ICON = buildIconProxyUrl(undefined, { tight: true });

/** The minimum the Worker enforces; mirrored so the field can say so before a round trip. / 与 Worker 一致的最小密码长度，供前端提前提示。 */
const MIN_PASSWORD = 8;

/**
 * First-run initialization.
 *
 * A separate page rather than a sign-in variant: the two answer opposite
 * questions, and folding them into one made every field and error message
 * change meaning behind a flag. The site name is optional here; blank means
 * keep the default, so nobody is blocked at the door.
 * 独立于登录页；站点名称可留空，留空即保留默认值。
 */
export function SetupPage() {
  const t = useTranslations('admin');
  const { session, setup } = useAuth();
  const navigate = useNavigate();

  const [credential, setCredential] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [confirmPasswordTouched, setConfirmPasswordTouched] = useState(false);
  const [siteName, setSiteName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [databaseType, setDatabaseType] = useState<SetupDatabaseType | null>(null);
  const [databaseUrl, setDatabaseUrl] = useState('');
  const [stage, setStage] = useState<'check' | 'account'>('check');
  const submissionPending = useRef(false);

  /**
   * `finishing` covers the window between "account exists" and "console is up".
   *
   * `setup()` flips the shared session to authenticated, and the guard would
   * redirect before the optional site-name write was sent, racing two
   * navigations. Holding the phase keeps the redirect on one path.
   * 先压住跳转，等站点名称写入完成，避免两次导航竞态。
   */
  const [phase, setPhase] = useState<'form' | 'creating' | 'finishing' | 'titleFailed'>('form');

  /** The tab should say which page this is, like every other console route. / 与其他控制台路由一样，为标签页设置当前页面标题。 */
  useEffect(() => {
    const previous = document.title;
    document.title = `${t('setup.title')} · ${PROJECT_NAME}`;
    return () => {
      document.title = previous;
    };
  }, [t]);

  if (!session) return <AuthSplash />;

  /*
    Already initialized: another tab finished, or the URL was revisited. Sent to
    the console when signed in and to /login when not - /setup is not a page that
    does anything in that state, and rendering an empty form for it would invite
    the operator to try a credential that no longer applies.

    若其他标签页已完成初始化，或用户重新访问该 URL，则已登录时跳转控制台，
    未登录时跳转 /login；此时表单无法继续使用，显示它会诱导用户输入已不适用的凭据。
  */
  if (!session.needsSetup && phase === 'form') {
    return <Navigate to={session.authenticated ? '/admin' : '/login'} replace />;
  }

  const databaseOptions = session.setupDatabase;
  const selectedDatabase = databaseType && databaseOptions?.types.includes(databaseType) ? databaseType : databaseOptions?.defaultType;
  const databaseAvailable = !!databaseOptions && typeof databaseOptions.postgresUrlEditable === 'boolean' && !!selectedDatabase && databaseOptions.types.includes(selectedDatabase);
  const postgresUrlEditable = databaseOptions?.postgresUrlEditable === true;
  const postgresConfigured = databaseOptions?.postgresConfigured === true && databaseOptions.defaultType === 'postgres';
  const canReusePostgres = selectedDatabase === 'postgres' && postgresConfigured;
  const postgresUrlRequired = selectedDatabase === 'postgres' && postgresUrlEditable && !postgresConfigured;
  const postgresConfigurationMissing = selectedDatabase === 'postgres' && !postgresUrlEditable && !postgresConfigured;
  const canSubmit = !submitting && databaseAvailable && !postgresConfigurationMissing && (!postgresUrlRequired || databaseUrl.trim().length > 0) && credential.length > 0 && username.trim().length > 0 && password.length > 0 && confirmPassword.length > 0;
  const passwordMismatch = confirmPasswordTouched && password !== confirmPassword;


  /**
   * Worker 先检查部署，必需项全部通过后才显示初始化表单；Go 后端不返回检查结果，直接进入表单。
   * The Worker checks its deployment first and shows the form only after every required item passes; Go reports no check and goes straight to the form.
   */
  const requirements = session.setupRequirements ?? null;
  const deploymentReady = requirements?.every((item) => !item.required || item.ok) ?? true;
  const showCheck = requirements !== null && (stage === 'check' || !deploymentReady);

  /** No setup key on Go means setup cannot succeed; show the fix, not the form. / Go 未配置初始化密钥时无法初始化；显示修复方法。 */
  const credentialMissing = requirements === null && session.setupCredential === null && !session.authenticated;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit || submissionPending.current || !selectedDatabase) return;

    /*
      Checked here rather than only at the Worker so the sentence appears while
      the password is being typed, and so a short password never costs a round
      trip that the browser could have answered.

      在前端检查密码长度，以便提前提示并避免不必要的请求。
    */
    if (password.length < MIN_PASSWORD) {
      setError(t('login.setupPasswordShort'));
      return;
    }

    if (password !== confirmPassword) {
      setConfirmPasswordTouched(true);
      return;
    }

    submissionPending.current = true;
    setSubmitting(true);
    setPhase('creating');
    setError(null);
    try {
      await setup(credential, username, password, {
        type: selectedDatabase,
        ...(selectedDatabase === 'postgres' && postgresUrlEditable && databaseUrl.trim() ? { url: databaseUrl.trim() } : {}),
      });
      setDatabaseUrl('');
      setPhase('finishing');

      const title = siteName.trim();
      if (title) {
        try {
          await settingsApi.updateSettings({ 'site.title': title });
        } catch {
          setPhase('titleFailed');
          setSubmitting(false);
          return;
        }
      }

      navigate('/admin', { replace: true });
    } catch (err) {
      setError(readableError(err, t));
      setPhase('form');
      setSubmitting(false);
    } finally {
      submissionPending.current = false;
    }
  }

  if (phase === 'finishing') return <Finishing label={t('setup.creating')} />;
  if (phase === 'titleFailed') return <main className="polaris flex min-h-dvh items-center justify-center bg-[var(--polaris-canvas)] p-6 text-[var(--polaris-ink)]"><div className="w-full max-w-md space-y-4"><h1 className="text-xl font-semibold">{t('setup.accountCreated')}</h1><p role="alert" className="text-small text-[var(--polaris-ink-3)]">{t('setup.titleSaveFailed', { title: siteName.trim() })}</p><div className="flex gap-2"><Button color="primary" isLoading={submitting} onPress={async () => { setSubmitting(true); try { await settingsApi.updateSettings({ 'site.title': siteName.trim() }); navigate('/admin', { replace: true }); } catch { setSubmitting(false); } }}>{t('setup.retryTitle')}</Button><Button variant="light" onPress={() => navigate('/admin/settings#settings-site', { replace: true })}>{t('setup.continueSettings')}</Button></div></div></main>;

  return (
    <div className="polaris flex min-h-dvh bg-[var(--polaris-canvas)] text-[var(--polaris-ink)]">
      <AuthProductPanel />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between px-6 sm:px-8">
          <span className="flex items-center gap-2.5">
            <img src={BRAND_ICON} alt="" width={22} height={22} />
            <span className="text-[15px] font-semibold tracking-[-0.02em]">{PROJECT_NAME}</span>
          </span>
          <div className="flex items-center gap-0.5 text-[var(--polaris-ink-3)] [&_button]:h-8 [&_button]:w-8 [&_button]:min-w-8 [&_svg]:h-[17px] [&_svg]:w-[17px]">
            <ThemeSwitch radius="md" />
            <LocaleSwitch />
          </div>
        </header>

        <div className="flex flex-1 items-center justify-center px-6 pb-16">
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={CONTENT_TRANSITION} className="w-full max-w-[24rem]">
            <div className="mb-7">
              {requirements ? (
                <p className="mb-2 text-[12px] font-medium text-[var(--polaris-ink-4)]">{t('setup.stepLabel', { current: showCheck ? 1 : 2, total: 2 })}</p>
              ) : null}
              <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.025em]">{t('setup.title')}</h1>
              <p className="mt-1.5 text-[13.5px] text-[var(--polaris-ink-3)]">{t(showCheck ? 'setup.checkSubtitle' : 'setup.subtitle')}</p>
            </div>

            {/*
              A form that cannot succeed is not rendered at all.

              The alternative - showing the fields with the button disabled and a
              warning underneath - was rejected because it still presents the page
              as a thing to fill in. When no secret is bound, filling it in is not
              the missing step; setting the secret is, and that happens outside
              this page. So the form gives way to instructions that say so.

              缺少密钥时不显示无法成功提交的表单，而是提示在页面外配置密钥。
              若仍显示字段、禁用按钮并在下方警告，页面看起来仍像需要填写；
              真正缺少的是在此页面之外设置密钥，而不是填写表单。
            */}
            {showCheck && requirements ? (
              <DeploymentCheck requirements={requirements} ready={deploymentReady} onNext={() => setStage('account')} />
            ) : credentialMissing ? (
              <NoCredential />
            ) : (
              <>
                <div className="mb-5 flex gap-3 rounded-xl border border-[var(--polaris-line)] bg-[var(--polaris-well)] px-3.5 py-3 text-[13px]">
                  <Sparkles size={16} className="mt-0.5 shrink-0 text-[var(--polaris-ink-2)]" />
                  <p className="text-[12.5px] text-[var(--polaris-ink-3)]">{t('login.setupHint')}</p>
                </div>

                <form onSubmit={onSubmit} className="flex flex-col gap-3.5" noValidate>
                  {databaseOptions && databaseAvailable ? (
                    <div className="flex flex-col gap-2">
                      <Select
                        id="setup-database"
                        label={t('setup.databaseLabel')}
                        labelPlacement="outside"
                        selectedKeys={selectedDatabase ? [selectedDatabase] : []}
                        disallowEmptySelection
                        onSelectionChange={(keys) => {
                          const value = [...keys][0] as SetupDatabaseType;
                          if (databaseOptions.types.includes(value)) setDatabaseType(value);
                        }}
                        isDisabled={submitting}
                      >
                        {databaseOptions.types.map((type) => <SelectItem key={type}>{type === 'd1' ? 'Cloudflare D1' : type === 'sqlite' ? 'SQLite' : 'PostgreSQL'}</SelectItem>)}
                      </Select>
                      {selectedDatabase === 'postgres' && postgresUrlEditable ? (
                        <Input
                          label={t('setup.databaseUrl')}
                          labelPlacement="outside"
                          type="password"
                          autoComplete="off"
                          spellCheck="false"
                          isRequired={postgresUrlRequired}
                          value={databaseUrl}
                          onValueChange={setDatabaseUrl}
                          isDisabled={submitting}
                          description={t(canReusePostgres ? 'setup.databaseUrlConfigured' : 'setup.databaseUrlRequired')}
                        />
                      ) : selectedDatabase === 'postgres' ? (
                        <p
                          role={postgresConfigurationMissing ? 'alert' : undefined}
                          className={`rounded-lg border px-3 py-2 text-[12px] leading-relaxed ${postgresConfigurationMissing ? 'border-warning/30 bg-warning/[0.05] text-warning-700' : 'border-[var(--polaris-line)] bg-[var(--polaris-well)] text-[var(--polaris-ink-3)]'}`}
                        >
                          {t(postgresConfigurationMissing ? 'setup.databaseUrlUnavailable' : 'setup.databaseUrlDeploymentOnly')}
                        </p>
                      ) : null}
                    </div>
                  ) : <DatabaseUnavailable />}
                  <Input
                    isRequired
                    label={t('login.installationCredential')}
                    labelPlacement="outside"
                    type="password"
                    autoComplete="off"
                    value={credential}
                    onValueChange={setCredential}
                    isDisabled={submitting}
                    description={t('setup.credentialSource')}
                    startContent={<KeyRound size={15} className="shrink-0 text-[var(--polaris-ink-4)]" />}
                  />

                  <Input
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
                    isRequired
                    name="password"
                    label={t('login.password')}
                    labelPlacement="outside"
                    // `new-password` lets a password manager generate and offer to
                    // save one; `current-password` here would suppress both.
                    // `new-password` 允许密码管理器生成并保存密码；此处使用 `current-password` 会阻止这些行为。
                    autoComplete="new-password"
                    value={password}
                    onValueChange={setPassword}
                    isDisabled={submitting}
                    description={t('account.newPasswordHint')}
                    startContent={<Lock size={15} className="shrink-0 text-[var(--polaris-ink-4)]" />}
                  />

                  <PasswordInput
                    isRequired
                    name="confirmPassword"
                    label={t('setup.confirmPassword')}
                    labelPlacement="outside"
                    autoComplete="new-password"
                    value={confirmPassword}
                    onValueChange={setConfirmPassword}
                    onBlur={() => setConfirmPasswordTouched(true)}
                    isDisabled={submitting}
                    isInvalid={passwordMismatch}
                    errorMessage={passwordMismatch ? t('setup.passwordMismatch') : undefined}
                    startContent={<Lock size={15} className="shrink-0 text-[var(--polaris-ink-4)]" />}
                  />

                  {/*
                    Optional. Its own autocomplete token on purpose: "organization" is
                    what a browser's autofill understands here, and reusing "off" (the
                    credential's) would put two fields in the same bucket for both
                    autofill and the tests that address these inputs by that attribute.

                    站点名称可选，使用浏览器识别的 `organization` 自动填充标记；
                    若与凭据字段共用 `off`，自动填充和通过该属性定位输入的测试
                    都会把两个字段归入同一组。
                  */}
                  <Input
                    label={t('setup.siteName')}
                    labelPlacement="outside"
                    autoComplete="organization"
                    value={siteName}
                    onValueChange={setSiteName}
                    isDisabled={submitting}
                    description={t('setup.siteNameHint')}
                  />

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
                    isDisabled={!canSubmit}
                    startContent={submitting ? <Loader2 className="animate-spin" size={16} /> : null}
                    endContent={submitting ? null : <ArrowRight size={16} />}
                  >
                    {submitting ? t('setup.creating') : t('login.setupSubmit')}
                  </Button>

                  {requirements ? (
                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() => setStage('check')}
                      className="self-center text-[12.5px] font-medium text-[var(--polaris-ink-3)] transition-colors hover:text-[var(--polaris-ink)] disabled:opacity-50"
                    >
                      {t('setup.checkBack')}
                    </button>
                  ) : null}
                </form>
              </>
            )}
          </motion.div>
        </div>

        <p className="px-6 pb-6 text-center text-[11.5px] text-[var(--polaris-ink-4)] lg:text-left">{t('login.footer', { year: new Date().getFullYear() })}</p>
      </main>
    </div>
  );
}

function DatabaseUnavailable() {
  const t = useTranslations('admin');
  const { refresh } = useAuth();
  const [retrying, setRetrying] = useState(false);
  return (
    <div role="alert" className="rounded-xl border border-warning/30 bg-warning/[0.05] px-3.5 py-3 text-[12.5px]">
      <p>{t('setup.databaseOptionsUnavailable')}</p>
      <button type="button" disabled={retrying} onClick={async () => {
        setRetrying(true);
        try { await refresh(); } finally { setRetrying(false); }
      }} className="mt-2 inline-flex items-center gap-1.5 font-medium text-[var(--polaris-ink-2)] disabled:opacity-50">
        <RefreshCw size={13} className={retrying ? 'animate-spin' : undefined} />
        {t('setup.databaseRetry')}
      </button>
    </div>
  );
}

const REQUIREMENT_TEXT: Record<SetupRequirementKey, { label: string; hint: string }> = {
  database: { label: 'setup.checkDatabase', hint: 'setup.checkDatabaseHint' },
  adminToken: { label: 'setup.checkAdminToken', hint: 'setup.checkAdminTokenHint' },
  themes: { label: 'setup.checkThemes', hint: 'setup.checkThemesHint' },
  analytics: { label: 'setup.checkAnalytics', hint: 'setup.checkAnalyticsHint' },
};

/**
 * Worker 初始化的第一步：逐项列出绑定和密钥，未通过的项说明在 Cloudflare 控制台怎么配置。
 * Step one of Worker setup: list each binding and secret, and say how to configure any that fail in the Cloudflare dashboard.
 */
function DeploymentCheck({ requirements, ready, onNext }: { requirements: SetupRequirement[]; ready: boolean; onNext: () => void }) {
  const t = useTranslations('admin');
  const { refresh } = useAuth();
  const [checking, setChecking] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <ul className="divide-y divide-[var(--polaris-line)] overflow-hidden rounded-xl border border-[var(--polaris-line)] bg-[var(--polaris-card)]">
        {requirements.map((item) => {
          const text = REQUIREMENT_TEXT[item.key];
          const Icon = item.ok ? CircleCheck : item.required ? AlertCircle : CircleDashed;
          const tone = item.ok ? 'text-success-600' : item.required ? 'text-danger-600' : 'text-[var(--polaris-ink-4)]';
          return (
            <li key={item.key} className="flex gap-3 px-3.5 py-3">
              <Icon size={16} className={`mt-0.5 shrink-0 ${tone}`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[13px] font-medium">{t(text.label)}</span>
                  <span className={`shrink-0 text-[12px] ${tone}`}>
                    {t(item.ok ? 'setup.checkOk' : item.required ? 'setup.checkMissing' : 'setup.checkOptional')}
                  </span>
                </div>
                {item.ok ? null : <p className="mt-1 text-[12px] leading-relaxed text-[var(--polaris-ink-3)]">{t(text.hint)}</p>}
              </div>
            </li>
          );
        })}
      </ul>

      {ready ? null : <p className="text-[12px] leading-relaxed text-[var(--polaris-ink-4)]">{t('setup.checkAfter')}</p>}

      <div className="flex gap-2">
        <Button
          variant="bordered"
          className="h-10 flex-1 text-[13.5px]"
          isLoading={checking}
          startContent={checking ? null : <RefreshCw size={15} />}
          onPress={async () => {
            setChecking(true);
            try { await refresh(); } finally { setChecking(false); }
          }}
        >
          {t('setup.checkRetry')}
        </Button>
        <Button
          color="primary"
          className="h-10 flex-1 text-[13.5px] font-medium"
          isDisabled={!ready || checking}
          endContent={<ArrowRight size={16} />}
          onPress={onNext}
        >
          {t('setup.checkNext')}
        </Button>
      </div>
    </div>
  );
}

/**
 * The dead end on the Go backend, stated plainly.
 *
 * Shown when no setup key is configured: show how to set `POLARIS_SETUP_KEY`
 * and offer a session re-check after restarting. The Worker reports the same
 * gap in its deployment check instead.
 * Go 未配置初始化密钥时只显示修复方法；Worker 在部署检查里提示同一问题。
 */
function NoCredential() {
  const t = useTranslations('admin');
  const { refresh } = useAuth();
  const [retrying, setRetrying] = useState(false);

  const command = "POLARIS_SETUP_KEY='<setup-key>' ./polaris";

  return (
    <div
      role="alert"
      className="mt-5 rounded-xl border border-warning/30 bg-warning/[0.05] px-3.5 py-3.5 text-[12.5px]"
    >
      <p className="flex items-start gap-2 font-medium text-warning-700">
        <AlertCircle size={15} className="mt-px shrink-0" />
        {t('setup.noCredentialTitle')}
      </p>
      <p className="mt-2 leading-relaxed text-[var(--polaris-ink-3)]">{t('setup.noCredentialGoBody')}</p>

      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(command);
        }}
        className="mt-2.5 block w-full truncate rounded-lg border border-[var(--polaris-line)] bg-[var(--polaris-card)] px-2.5 py-2 text-left font-mono text-[11.5px] text-[var(--polaris-ink-2)] transition-colors hover:border-[var(--polaris-ink-4)] hover:text-[var(--polaris-ink)]"
      >
        {command}
      </button>

      <p className="mt-2.5 leading-relaxed text-[var(--polaris-ink-4)]">{t('setup.noCredentialAfter')}</p>

      <button
        type="button"
        disabled={retrying}
        onClick={async () => {
          setRetrying(true);
          await refresh();
          setRetrying(false);
        }}
        className="mt-2.5 inline-flex items-center gap-1.5 font-medium text-[var(--polaris-ink-2)] transition-colors hover:text-[var(--polaris-ink)] disabled:opacity-50"
      >
        <RefreshCw size={13} className={retrying ? 'animate-spin' : undefined} />
        {t('setup.noCredentialRetry')}
      </button>
    </div>
  );
}

/** The hold between the account existing and the console rendering. / 账户创建完成后、控制台渲染前的等待状态。 */
function Finishing({ label }: { label: string }) {
  return (
    <div className="polaris flex min-h-dvh flex-col items-center justify-center gap-4 bg-[var(--polaris-canvas)]">
      <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-[var(--polaris-line)] bg-[var(--polaris-card)]">
        <Check size={20} className="text-success-600" />
      </span>
      <p className="flex items-center gap-2 text-[13px] text-[var(--polaris-ink-3)]">
        <Loader2 size={14} className="animate-spin" />
        {label}
      </p>
    </div>
  );
}

/** Map setup errors to the same vocabulary as sign-in. / 初始化错误沿用登录页词汇。 */
function readableError(err: unknown, t: ReturnType<typeof useTranslations>): string {
  const code = err instanceof Error ? err.message : String(err);
  if (code === 'invalid_setup_credential') return t('login.setupCredentialInvalid');
  /** Secret absent, not wrong; reachable when the tab's session is stale. / 密钥缺失而非错误；标签页会话过期时也可能到达。 */
  if (code === 'credential_unconfigured') return t('setup.noCredentialTitle');
  if (code === 'deployment_incomplete') return t('setup.deploymentIncomplete');
  if (code === 'invalid_username') return t('login.setupUsernameInvalid');
  if (code === 'username_taken') return t('login.setupUsernameTaken');
  if (code === 'password_too_short') return t('login.setupPasswordShort');
  if (code === 'setup_complete') return t('login.setupComplete');
  if (code === 'invalid_auth_config') return t('login.authConfigInvalid');
  if (code === 'database_unavailable') return t('login.dbUnavailable');
  if (code === 'invalid_database_type') return t('setup.invalidDatabaseType');
  if (code === 'invalid_database_url') return t('setup.invalidDatabaseUrl');
  if (code === 'database_connection_failed') return t('setup.databaseConnectionFailed');
  if (code === 'database_initialization_failed') return t('setup.databaseInitializationFailed');
  if (code === 'database_configuration_failed') return t('setup.databaseConfigurationFailed');
  if (code === 'setup_in_progress') return t('setup.setupInProgress');
  if (code === 'network_error') return t('login.network');
  if (err instanceof ApiError && err.status >= 500) return t('login.dbUnavailable');
  return t('login.failed');
}
