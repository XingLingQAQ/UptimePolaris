import { authApi } from './api';
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
import { DeploymentCheck } from './DeploymentCheck';
import type { SetupDatabaseType } from '../../../shared/setup';

const BRAND_ICON = buildIconProxyUrl(undefined, { tight: true });
const MIN_PASSWORD = 8;

export function SetupPage() {
  const t = useTranslations('admin');
  const { session, sessionError, setup, refresh } = useAuth();
  const navigate = useNavigate();
  const [credential, setCredential] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [confirmPasswordTouched, setConfirmPasswordTouched] = useState(false);
  const [siteName, setSiteName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [checkingDatabase, setCheckingDatabase] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [databaseType, setDatabaseType] = useState<SetupDatabaseType | null>(null);
  const [databaseUrl, setDatabaseUrl] = useState('');
  const [savedDatabase, setSavedDatabase] = useState<{ type: SetupDatabaseType; configurationId?: string } | null>(null);
  const [stage, setStage] = useState<'check' | 'database' | 'account'>('check');
  const [phase, setPhase] = useState<'form' | 'creating' | 'finishing' | 'titleFailed'>('form');
  const submissionPending = useRef(false);

  useEffect(() => {
    const previous = document.title;
    document.title = `${t('setup.title')} · ${PROJECT_NAME}`;
    return () => { document.title = previous; };
  }, [t]);

  useEffect(() => {
    const options = session?.setupDatabase;
    if (options) setDatabaseType(current => current && options.types.includes(current) ? current : options.defaultType);
  }, [session?.setupDatabase]);

  if (!session) return <AuthSplash />;
  if (!session.needsSetup && phase === 'form') return <Navigate to={session.authenticated ? '/admin' : '/login'} replace />;

  const options = session.setupDatabase;
  const selectedDatabase = databaseType && options?.types.includes(databaseType) ? databaseType : options?.defaultType;
  const databaseAvailable = !!options && typeof options.postgresUrlEditable === 'boolean' && !!selectedDatabase && options.types.includes(selectedDatabase);
  const editable = options?.postgresUrlEditable === true;
  const configured = options?.postgresConfigured === true;
  const needsUrl = selectedDatabase === 'postgres' && !configured;
  const requirements = session.setupRequirements ?? null;
  const deploymentReady = requirements?.every(item => !item.required || item.ok) ?? true;
  const showCheck = requirements !== null && (stage === 'check' || !deploymentReady || sessionError);
  const showDatabase = requirements !== null && !showCheck && stage === 'database';
  const syncingDatabase = showDatabase && savedDatabase?.configurationId && options?.configurationId !== savedDatabase.configurationId;
  const credentialMissing = requirements === null && session.setupCredential === null && !session.authenticated;
  const busy = submitting || checkingDatabase;
  const databaseReady = databaseAvailable && (!needsUrl || editable && databaseUrl.trim().length > 0);
  const canConfigure = !busy && !sessionError && deploymentReady && databaseReady && credential.length > 0;
  const canSubmit = canConfigure && username.trim().length > 0 && password.length > 0 && confirmPassword.length > 0;
  const passwordMismatch = confirmPasswordTouched && password !== confirmPassword;

  function selection() {
    return { type: selectedDatabase!, ...(selectedDatabase === 'postgres' && editable && databaseUrl.trim() ? { url: databaseUrl.trim() } : {}) };
  }

  async function recover(err: unknown) {
    setError(readableError(err, t));
    const code = err instanceof Error ? err.message : String(err);
    if (!requirements) return;
    if (['deployment_incomplete', 'credential_unconfigured'].includes(code)) {
      setStage('check');
      await refresh();
    } else if (['invalid_setup_credential', 'invalid_database_type', 'invalid_database_url', 'database_connection_failed', 'database_initialization_failed', 'database_configuration_failed'].includes(code)) {
      setStage('database');
      await refresh();
    }
  }

  async function onConfigureDatabase(e: FormEvent) {
    e.preventDefault();
    if (!canConfigure || submissionPending.current) return;
    submissionPending.current = true;
    setCheckingDatabase(true);
    setError(null);
    try {
      const saved = savedDatabase ?? await authApi.configureDatabase(credential, selection());
      setSavedDatabase(saved);
      const latest = await refresh();
      if (!latest) { setError(t('setup.databaseOptionsUnavailable')); return; }
      if (saved.configurationId && latest.setupDatabase?.configurationId !== saved.configurationId) {
        return;
      }
      setDatabaseUrl('');
      setStage('account');
    } catch (err) { await recover(err); }
    finally { setCheckingDatabase(false); submissionPending.current = false; }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit || submissionPending.current) return;
    if (password.length < MIN_PASSWORD) { setError(t('login.setupPasswordShort')); return; }
    if (password !== confirmPassword) { setConfirmPasswordTouched(true); return; }
    submissionPending.current = true;
    setSubmitting(true);
    setPhase('creating');
    setError(null);
    try {
      await setup(credential, username, password, selection());
      setDatabaseUrl('');
      setPhase('finishing');
      const title = siteName.trim();
      if (title) {
        try { await settingsApi.updateSettings({ 'site.title': title }); }
        catch { setPhase('titleFailed'); setSubmitting(false); return; }
      }
      navigate('/admin', { replace: true });
    } catch (err) {
      setPhase('form');
      setSubmitting(false);
      await recover(err);
    } finally { submissionPending.current = false; }
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
            <ThemeSwitch radius="md" /><LocaleSwitch />
          </div>
        </header>
        <div className="flex flex-1 items-center justify-center px-6 pb-16">
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={CONTENT_TRANSITION} className="w-full max-w-[24rem]">
            <div className="mb-7">
              {requirements ? <p className="mb-2 text-[12px] font-medium text-[var(--polaris-ink-4)]">{t('setup.stepLabel', { current: showCheck ? 1 : showDatabase ? 2 : 3, total: 3 })}</p> : null}
              <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.025em]">{t(showDatabase ? 'setup.databaseTitle' : requirements && !showCheck ? 'setup.accountTitle' : 'setup.title')}</h1>
              <p className="mt-1.5 text-[13.5px] text-[var(--polaris-ink-3)]">{t(showCheck ? 'setup.checkSubtitle' : showDatabase ? 'setup.databaseSubtitle' : 'setup.subtitle')}</p>
            </div>
            {showCheck && requirements ? (
              <DeploymentCheck requirements={requirements} ready={deploymentReady} onNext={() => { setError(null); setStage('database'); }} />
            ) : credentialMissing ? <NoCredential /> : (
              <>
                {!showDatabase ? <div className="mb-5 flex gap-3 rounded-xl border border-[var(--polaris-line)] bg-[var(--polaris-well)] px-3.5 py-3 text-[13px]">
                  <Sparkles size={16} className="mt-0.5 shrink-0 text-[var(--polaris-ink-2)]" />
                  <p className="text-[12.5px] text-[var(--polaris-ink-3)]">{t('login.setupHint')}</p>
                </div> : null}
                <form onSubmit={showDatabase ? onConfigureDatabase : onSubmit} className="flex flex-col gap-3.5" noValidate aria-busy={busy}>
                  {!requirements || showDatabase ? <>
                    {options && databaseAvailable ? <div className="flex flex-col gap-3.5">
                      <Select
                        id="setup-database"
                        label={t('setup.databaseLabel')}
                        labelPlacement="outside"
                        selectedKeys={selectedDatabase ? [selectedDatabase] : []}
                        disallowEmptySelection
                        onSelectionChange={keys => {
                          const value = [...keys][0] as SetupDatabaseType;
                          if (options.types.includes(value)) { setDatabaseType(value); setSavedDatabase(null); setError(null); }
                        }}
                        isDisabled={busy}
                      >
                        {options.types.map(type => <SelectItem key={type}>{type === 'd1' ? 'Cloudflare D1' : type === 'sqlite' ? 'SQLite' : 'PostgreSQL'}</SelectItem>)}
                      </Select>
                      {selectedDatabase === 'postgres' && editable ? <Input
                        label={t('setup.databaseUrl')}
                        labelPlacement="outside"
                        type="password"
                        autoComplete="off"
                        spellCheck="false"
                        placeholder="postgresql://user:password@host:5432/database?sslmode=require"
                        isRequired={needsUrl}
                        value={databaseUrl}
                        onValueChange={value => { setDatabaseUrl(value); setSavedDatabase(null); }}
                        isDisabled={busy}
                        description={t(configured ? 'setup.databaseUrlConfigured' : 'setup.databaseUrlRequired')}
                      /> : selectedDatabase === 'postgres' ? <p role={needsUrl ? 'alert' : undefined} className="rounded-lg border border-[var(--polaris-line)] bg-[var(--polaris-well)] px-3 py-2 text-[12px] leading-relaxed text-[var(--polaris-ink-3)]">{t(needsUrl ? 'setup.databaseUrlUnavailable' : 'setup.databaseUrlDeploymentOnly')}</p> : null}
                    </div> : <DatabaseUnavailable />}
                    <Input
                      isRequired
                      label={t('login.installationCredential')}
                      labelPlacement="outside"
                      type="password"
                      autoComplete="off"
                      value={credential}
                      onValueChange={setCredential}
                      isDisabled={busy}
                      description={t('setup.credentialSource')}
                      startContent={<KeyRound size={15} className="shrink-0 text-[var(--polaris-ink-4)]" />}
                    />
                  </> : null}
                  {!showDatabase ? <>
                    <Input
                      isRequired
                      label={t('login.username')}
                      labelPlacement="outside"
                      autoComplete="username"
                      value={username}
                      onValueChange={setUsername}
                      isDisabled={busy}
                      startContent={<UserRound size={15} className="shrink-0 text-[var(--polaris-ink-4)]" />}
                    />
                    <PasswordInput
                      isRequired
                      name="password"
                      label={t('login.password')}
                      labelPlacement="outside"
                      autoComplete="new-password"
                      value={password}
                      onValueChange={setPassword}
                      isDisabled={busy}
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
                      isDisabled={busy}
                      isInvalid={passwordMismatch}
                      errorMessage={passwordMismatch ? t('setup.passwordMismatch') : undefined}
                      startContent={<Lock size={15} className="shrink-0 text-[var(--polaris-ink-4)]" />}
                    />
                    <Input
                      label={t('setup.siteName')}
                      labelPlacement="outside"
                      autoComplete="organization"
                      value={siteName}
                      onValueChange={setSiteName}
                      isDisabled={busy}
                      description={t('setup.siteNameHint')}
                    />
                  </> : null}
                  {syncingDatabase && !error ? <p role="status" className="rounded-lg bg-[var(--polaris-well)] px-3 py-2.5 text-[13px] leading-relaxed text-[var(--polaris-ink-3)]">{t('setup.databaseConfigurationPending')}</p> : null}
                  {error ? <p role="alert" className="flex items-start gap-2 rounded-[10px] border border-danger/20 bg-danger/[0.04] px-3 py-2.5 text-[12.5px] text-danger-600"><AlertCircle size={15} className="mt-px shrink-0" />{error}</p> : null}
                  <Button
                    type="submit"
                    color="primary"
                    className="mt-2 h-10 w-full text-[13.5px] font-medium shadow-[0_1px_2px_rgb(0_0_0/0.12),inset_0_1px_0_rgb(255_255_255/0.08)]"
                    isDisabled={showDatabase ? !canConfigure : !canSubmit}
                    startContent={busy ? <Loader2 className="animate-spin" size={16} /> : null}
                    endContent={busy ? null : <ArrowRight size={16} />}
                  >
                    {showDatabase ? t(checkingDatabase ? 'setup.databaseChecking' : 'setup.databaseContinue') : submitting ? t('setup.creating') : t('login.setupSubmit')}
                  </Button>
                  {requirements ? <button type="button" disabled={busy} onClick={() => { setError(null); setStage(showDatabase ? 'check' : 'database'); }} className="self-center text-[12.5px] font-medium text-[var(--polaris-ink-3)] hover:text-[var(--polaris-ink)] disabled:opacity-50">{t(showDatabase ? 'setup.checkBack' : 'setup.databaseBack')}</button> : null}
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
