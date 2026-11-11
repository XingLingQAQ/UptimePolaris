import { UnauthorizedError } from '@/api/errors';
import { useApiErrorMessage } from '@/api/useApiErrorMessage';
import { useAuth } from '@/auth/AuthContext';
import { Button, Input, Skeleton } from '@heroui/react';
import { Database, KeyRound, Loader2, RefreshCw, UserRound } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { toast } from '@/components/ui/toast';
import { useTranslations } from 'use-intl';
import { authApi } from '../../auth/api';
import { EmptyState } from '../components/ConsolePrimitives';
import { joinEvents } from '../components/event-presentation';
import { EventList } from '../components/EventList';
import { IconTile } from '../components/IconTile';
import { TimelineArt } from '../components/illustrations';
import { jobsApi } from '../jobs-api';
import { AdminPage } from '../layout/AdminPage';
import { overviewApi } from '../overview-api';
import type { AdminEvent } from '../overview-types';
import { useOverview } from '../useConsoleData';
import { SETTING_GROUPS, SettingsSections } from './SettingsSections';
import { AccountAvatarUpload } from './AccountAvatarUpload';
import { DatabaseMigration } from './DatabaseMigration';
import { PresentationPanel } from './PresentationPanel';
import { MaintenanceStatus } from './MaintenanceStatus';

/** Keep this rule aligned with USERNAME_RE in src/lib/auth/service.ts. / 此规则须与 src/lib/auth/service.ts 中的 USERNAME_RE 一致。 */
const USERNAME_RE = /^[a-z0-9._-]{2,32}$/;

/** Normalize before validating and comparing with the current username. / 校验和比较当前用户名之前先规范化。 */
const normalizedUsername = (value: string) => value.trim().toLowerCase();

/** 管理站点设置、账号信息、事件和运维操作。 / Manage site settings, account details, events, and operational actions. */
export function SettingsPage() {
  const t = useTranslations('admin');
  const apiErrorMessage = useApiErrorMessage();
  const navigate = useNavigate();
  const location = useLocation();
  const { session, applyAccountChange } = useAuth();
  const [events, setEvents] = useState<AdminEvent[] | null>(null);
  const [eventsError, setEventsError] = useState(false);
  const [eventsBusy, setEventsBusy] = useState(false);
  const [eventsCursor, setEventsCursor] = useState<string | null>(null);
  const eventsRequest = useRef<AbortController | null>(null);
  const requestedCursor = useRef<string | null>(null);
  const overview = useOverview();
  const eventRows = useMemo(
    () => (events ? joinEvents(events, overview.data?.monitors ?? []) : null),
    [events, overview.data],
  );
  const [busy, setBusy] = useState<string | null>(null);

  // Account form. / 账户表单。
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [username, setUsername] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);

  const signedInAs = session?.user?.username ?? '';

  // Seed the field from the session once it resolves, without clobbering what
  // the user has already typed: `username` is only set while it is still empty.
  // 会话加载完成后填充字段，且只在 `username` 仍为空时设置，避免覆盖用户已输入内容。
  useEffect(() => {
    setUsername((prev) => (prev === '' ? signedInAs : prev));
  }, [signedInAs]);

  /** Expired session: send to /login, keeping this page as the return target. / 会话过期时跳转 /login，并将当前页面保留为返回目标。 */
  const requireLogin = useCallback(() => {
    navigate('/login', { replace: true, state: { from: '/admin/settings' } });
  }, [navigate]);

  const loadEvents = useCallback(async (cursor: string | null = null) => {
    if (cursor && eventsRequest.current && !eventsRequest.current.signal.aborted) return;
    eventsRequest.current?.abort();
    const controller = new AbortController();
    eventsRequest.current = controller;
    requestedCursor.current = cursor;
    setEventsBusy(true);
    setEventsError(false);
    try {
      const result = await overviewApi.listEvents(50, cursor, controller.signal);
      if (controller.signal.aborted) return;
      setEvents((previous) => [...new Map((cursor ? [...(previous ?? []), ...result.events] : result.events).map((event) => [event.id, event])).values()]);
      setEventsCursor(result.nextCursor ?? null);
      if (!cursor && window.location.hash === '#settings-events') window.requestAnimationFrame(() => { if (window.location.hash === '#settings-events') document.getElementById('settings-events')?.scrollIntoView({ block: 'start' }); });
    } catch (e) {
      if (controller.signal.aborted) return;
      if (e instanceof UnauthorizedError) requireLogin();
      setEventsError(true);
    } finally {
      if (!controller.signal.aborted && eventsRequest.current === controller) {
        eventsRequest.current = null;
        setEventsBusy(false);
      }
    }
  }, [requireLogin]);

  useEffect(() => {
    void loadEvents();
    return () => eventsRequest.current?.abort();
  }, [loadEvents, location.key]);

  async function run(key: 'tick' | 'sync') {
    setBusy(key);
    try {
      if (key === 'tick') {
        const r = await jobsApi.runTick();
        if (r.tick === 'skipped') toast.info(t('toast.checkSkipped'));
        else toast.success(t('toast.checkDone', { ms: r.ms, n: r.monitors }));
      } else {
        const r = await jobsApi.runSync();
        if (r.status === 'disabled') toast.info(t('toast.syncDisabled'));
        else if (r.status === 'partial') toast.warning(t('toast.syncPartial', { succeeded: r.succeeded, failed: r.failed }));
        else toast.success(t('toast.syncDone', { days: r.succeeded, n: r.monitors }));
      }
      await loadEvents();
    } catch (e) {
      if (e instanceof UnauthorizedError) requireLogin();
      else toast.error(apiErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  /** What the Worker would say about the typed username, or null when fine. / 输入用户名对应的 Worker 校验结果；有效时为 null。 */
  const usernameProblem = useMemo(() => {
    const normalized = normalizedUsername(username);
    // Unchanged (or emptied) means "leave the name alone", which is valid. / 未修改或清空表示保留原用户名，属于有效状态。
    if (normalized === '' || normalized === signedInAs) return null;
    return USERNAME_RE.test(normalized) ? null : t('account.usernameInvalid');
  }, [username, signedInAs, t]);

  /** An empty username field is omitted from the account update. / 账户更新时省略空用户名字段。 */
  const usernameChanged =
    normalizedUsername(username) !== '' && normalizedUsername(username) !== signedInAs;
  const passwordChanged = next.length > 0;

  /** Save name and password together; the Worker applies them atomically and reissues this session. / 同时保存名称和密码；Worker 原子处理并重发当前会话。 */
  async function saveAccount() {
    setPwBusy(true);
    setPwError(null);
    try {
      const res = await authApi.changeAccount(current, {
        ...(passwordChanged ? { next } : {}),
        ...(usernameChanged ? { username } : {}),
      });
      applyAccountChange(res.username);

      setCurrent('');
      setNext('');
      setUsername(res.username);

      /** A password change is the headline even when the name changed too. / 即使名称也改了，密码变更仍是重点。 */
      if (passwordChanged) toast.success(t('account.passwordChanged'));
      else toast.success(t('account.usernameChanged'));    } catch (e) {
      const code = e instanceof Error ? e.message : '';
      if (code === 'unauthorized') requireLogin();
      else if (code === 'password_too_short') setPwError(t('account.passwordTooShort'));
      else if (code === 'invalid_credentials') setPwError(t('account.wrongPassword'));
      else if (code === 'username_taken') setPwError(t('account.usernameTaken'));
      else if (code === 'invalid_username') setPwError(t('account.usernameInvalid'));
      else if (code === 'no_change') setPwError(t('account.accountUnchanged'));
      else setPwError(apiErrorMessage(e));
    } finally {
      setPwBusy(false);
    }
  }

  return (
    <AdminPage title={t('settings.title')} description={t('settings.desc')}>
      {/*
        No width of its own.

        This page used to cap itself (`max-w-3xl`, then `max-w-4xl`) while the
        monitor table did not, so moving between them shifted the content edge by
        hundreds of pixels. Width is now owned by `AdminPage`, which applies one
        centred container to every console page. A page that sets its own cap is
        how the inconsistency started, so the rule is that none does.

        One column rather than two: the panels here are of genuinely different
        lengths (operations is short, the event log is long), and splitting them
        side by side left the short column ending early above a large empty
        region. Columns only work when their contents are comparable.

        页面自身不限制宽度：过去此页依次使用 max-w-3xl 和 max-w-4xl，而监控表不限制，
        切换时内容边缘会移动数百像素。现在统一由 AdminPage 提供居中容器，页面不再自设上限。
        使用单列而非双列：操作面板短、事件日志长，并排会让短列提前结束并留下大块空白；
        只有内容长度相近时分列才合适。
      */}
      <div className="flex flex-col gap-6">


        {/*
          The configuration groups.

          Placed above operations and account: this is the part of the page an
          operator comes for, and the run-now buttons below are the exceptional
          path (the cron already does both automatically). Account last, because
          changing your own credentials is something you do once.

          Grouped with a sticky rail rather than one long column - see
          SettingsSections' own note on why the shape is anchors and not routes.

          配置组放在操作和账户之前，因为这是用户进入页面的主要目的；下面的立即运行按钮
          属于例外操作，定时任务已自动执行；账户修改通常只做一次，因此放最后。
          配置组使用分组加吸顶导航而非长列；锚点而非路由的原因见 SettingsSections 注释。
        */}
        <SettingsSections
          groups={SETTING_GROUPS}
          renderGroup={(group) => {
            if (group === 'presentation') return <PresentationPanel />;
            if (group === 'maintenance') return <MaintenanceStatus />;
            if (group === 'migration') return <DatabaseMigration />;
            if (group === 'operations') {
              return (
                <>
                  <ActionRow
                    icon={<RefreshCw size={15} />}
                    busyIcon={<Loader2 className="animate-spin" size={15} />}
                    busy={busy === 'tick'}
                    label={t('settings.runCheck')}
                    hint={t('settings.runCheckHint')}
                    disabled={busy !== null}
                    onPress={() => void run('tick')}
                  />
                  <ActionRow
                    icon={<Database size={15} />}
                    busyIcon={<Loader2 className="animate-spin" size={15} />}
                    busy={busy === 'sync'}
                    label={t('settings.runSync')}
                    hint={t('settings.runSyncHint')}
                    disabled={busy !== null}
                    onPress={() => void run('sync')}
                  />
                </>
              );
            }

            if (group === 'account') {
              return (
                <>
                  <AccountAvatarUpload username={signedInAs} />
                  <div className="flex flex-col divide-y divide-[var(--polaris-line-soft)]">
                    <AccountField label={t('account.username')} hint={t('account.usernameHint')}>
                      <Input
                        size="sm"
                        variant="bordered"
                        classNames={{ input: 'text-tiny' }}
                        aria-label={t('account.username')}
                        autoComplete="username"
                        value={username}
                        onValueChange={setUsername}
                        isDisabled={pwBusy}
                        isInvalid={Boolean(usernameProblem)}
                        errorMessage={usernameProblem ?? undefined}
                        startContent={<UserRound className="shrink-0 text-default-400" size={15} />}
                      />
                    </AccountField>
                    <AccountField label={t('account.currentPassword')} hint={t('account.currentPasswordHint')}>
                      <Input
                        type="password"
                        size="sm"
                        variant="bordered"
                        classNames={{ input: 'text-tiny' }}
                        aria-label={t('account.currentPassword')}
                        autoComplete="current-password"
                        value={current}
                        onValueChange={setCurrent}
                        isDisabled={pwBusy}
                        startContent={<KeyRound className="shrink-0 text-default-400" size={15} />}
                      />
                    </AccountField>
                    <AccountField label={t('account.newPassword')} hint={t('account.newPasswordKeep')}>
                      <Input
                        type="password"
                        size="sm"
                        variant="bordered"
                        classNames={{ input: 'text-tiny' }}
                        aria-label={t('account.newPassword')}
                        autoComplete="new-password"
                        startContent={<KeyRound className="shrink-0 text-default-400" size={15} />}
                        value={next}
                        onValueChange={setNext}
                        isDisabled={pwBusy}
                      />
                    </AccountField>
                  </div>

                  {pwError ? (
                    <p className="rounded-lg border border-danger/20 bg-danger/[0.06] px-3 py-2 text-small text-danger-600">
                      {pwError}
                    </p>
                  ) : null}

                  <div className="flex justify-end">
                    <Button
                      color="primary"
                      size="sm"
                      isLoading={pwBusy}
                      startContent={pwBusy ? <Loader2 className="animate-spin" size={15} /> : null}
                      onPress={() => void saveAccount()}
                    >
                      {pwBusy ? t('account.savingAccount') : t('account.saveAccount')}
                    </Button>
                  </div>
                </>
              );
            }

            if (group === 'events') {
              return (
                <>
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-tiny text-default-500">{events ? t('settings.eventsLoaded', { n: events.length }) : ''}</span>
                    <Button size="sm" variant="flat" startContent={<RefreshCw size={14} />} isLoading={eventsBusy && requestedCursor.current === null} isDisabled={eventsBusy} onPress={() => void loadEvents()}>{t('agents.refresh')}</Button>
                  </div>
                  {eventsError ? (
                    <div role="alert" className="flex flex-wrap items-center gap-3 text-small text-danger">
                      <p>{t('settings.eventsLoadFailed')}</p>
                      <Button size="sm" variant="light" isDisabled={eventsBusy} onPress={() => void loadEvents(requestedCursor.current)}>{t('action.retry')}</Button>
                    </div>
                  ) : null}
                  {eventRows === null && eventsError ? null : eventRows === null ? (
                    <div className="flex flex-col gap-2">
                      {[0, 1, 2].map((i) => (
                        <Skeleton key={i} className="h-12 rounded-xl" />
                      ))}
                    </div>
                  ) : eventRows.length === 0 ? (
                    <EmptyState art={<TimelineArt />} title={t('settings.eventsEmpty')} className="py-8" />
                  ) : (
                    <EventList rows={eventRows} absolute className="-mx-2" />
                  )}
                  {eventsCursor ? <div className="mt-3 flex justify-center"><Button size="sm" variant="flat" isLoading={eventsBusy && requestedCursor.current !== null} isDisabled={eventsBusy} onPress={() => void loadEvents(eventsCursor)}>{t('settings.eventsMore')}</Button></div> : eventRows && eventRows.length > 0 && !eventsError ? <p className="mt-3 text-center text-tiny text-default-400">{t('settings.eventsEnd')}</p> : null}
                </>
              );
            }

            return null;
          }}
        />

      </div>
    </AdminPage>
  );
}

/** Operations row: label and hint on the left, control pinned right. / 操作行：左侧标签和说明，右侧固定控件。 */
function ActionRow({
  icon,
  busyIcon,
  busy,
  label,
  hint,
  disabled,
  onPress,
}: {
  icon: React.ReactNode;
  busyIcon: React.ReactNode;
  busy: boolean;
  label: string;
  hint: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--polaris-line-soft)] py-3 first:pt-0 last:border-0 last:pb-0">
      <IconTile icon={icon} hue="violet" size="sm" />
      <div className="min-w-0 flex-1">
        <p className="text-small font-medium">{label}</p>
        <p className="text-tiny text-default-500">{hint}</p>
      </div>
      <Button
        className="shrink-0"
        variant="flat"
        size="sm"
        startContent={busy ? busyIcon : icon}
        onPress={onPress}
        isDisabled={disabled}
      >
        {label}
      </Button>
    </div>
  );
}

/** Account field row matching the settings-section layout, rather than HeroUI's in-box label. / 账号字段行沿用设置分区布局，不用 HeroUI 的内嵌标签。 */
function AccountField({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-2 py-4 first:pt-0 last:pb-0 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
      <div className="min-w-0">
        <p className="text-small font-medium">{label}</p>
        <p className="text-tiny leading-snug text-default-500">{hint}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
