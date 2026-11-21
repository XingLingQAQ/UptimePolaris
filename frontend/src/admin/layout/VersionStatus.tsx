import { useBackendCapabilities } from '@/api/backend';
import { requestJson } from '@/api/client';
import { ApiError } from '@/api/errors';
import { compareVersions, STABLE_TAG as stableTag, type VersionCheck } from '../../../../shared/project-version';
import { useManagedUpdates } from '@/api/updates';
import { UpdateControls } from './UpdateControls';
import { Popover } from '@/components/ui/MotionOverlays';
import { useTimeAgo } from '@/hooks/useTimeAgo';
import { PROJECT_REPOSITORY_URL } from '@/lib/project';
import { APP_VERSION } from '@/lib/version';
import { Button, PopoverContent, PopoverTrigger } from '@heroui/react';
import clsx from 'clsx';
import { AlertCircle, ArrowRight, ArrowUpRight, BellOff, BookOpen, CircleCheck, RefreshCw, Sparkles } from 'lucide-react';
import { useRef, useState } from 'react';
import useSWR from 'swr';
import { useLocale, useTranslations } from 'use-intl';

const CACHE_KEY = 'uptime-polaris.latest-version';
const DISMISS_KEY = 'uptime-polaris.dismissed-version';
const REFRESH_MS = 6 * 60 * 60 * 1000;
const versionUrl = '/api/admin/version';

function cachedCheck(): VersionCheck | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null');
    if (value && (value.tag === null || typeof value.tag === 'string' && stableTag.test(value.tag)) && Number.isFinite(value.checkedAt) && value.checkedAt <= Date.now() && Date.now() - value.checkedAt < REFRESH_MS) return value;
  } catch {}
}

async function checkVersion(refresh = false): Promise<VersionCheck> {
  const result = await requestJson<VersionCheck>(versionUrl + (refresh ? '?refresh=1' : ''), { signal: AbortSignal.timeout(17_000) });
  if (!Number.isFinite(result.checkedAt) || !(result.tag === null || typeof result.tag === 'string' && stableTag.test(result.tag))) throw new ApiError('version_invalid_response', 502);
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(result)); } catch {}
  return result;
}

function readDismissed(): string | null {
  try { return localStorage.getItem(DISMISS_KEY); } catch { return null; }
}

const bare = (version: string) => version.replace(/^v/, '');

export function VersionStatus() {
  const t = useTranslations('admin.versionStatus');
  const locale = useLocale();
  const ago = useTimeAgo();
  const runtime = useBackendCapabilities().data?.runtime;
  const updater = useManagedUpdates(runtime === 'go');
  const current = runtime === 'go' ? updater.data?.current ?? APP_VERSION : APP_VERSION;
  const [cached] = useState(cachedCheck);
  const [dismissed, setDismissed] = useState(readDismissed);
  const refreshRequested = useRef(false);
  const resource = useSWR(runtime === 'worker' ? versionUrl : null, () => {
    const refresh = refreshRequested.current;
    refreshRequested.current = false;
    return checkVersion(refresh);
  }, {
    fallbackData: cached, revalidateOnMount: !cached, revalidateOnFocus: false, revalidateOnReconnect: false,
    refreshInterval: REFRESH_MS, dedupingInterval: 60_000, shouldRetryOnError: false,
  });
  const latest = runtime === 'go' ? updater.data?.latest ?? null : resource.data?.tag ?? null;
  const comparable = /^v?\d+\.\d+\.\d+(?:[-+].*)?$/.test(current);
  const prerelease = !comparable || current.includes('-');
  const available = Boolean(latest && comparable && (compareVersions(latest, current) > 0 || compareVersions(latest, current) === 0 && current.includes('-')));
  const quiet = available && dismissed === latest;
  const loud = available && !quiet;
  const checking = runtime === 'go' ? updater.data?.phase === 'checking' : resource.isValidating;
  const failed = runtime === 'go' ? Boolean(updater.error && !updater.busy || updater.data?.phase === 'failed') : Boolean(resource.error);
  const failureCode = resource.error instanceof ApiError ? resource.error.code : '';
  const failureKey = failureCode === 'version_rate_limited' ? 'rateLimited' : ['version_timeout', 'request_timeout'].includes(failureCode) ? 'timedOut' : failureCode === 'version_invalid_response' ? 'invalidTags' : 'failed';
  const checkedAt = runtime === 'go' ? updater.data?.checkedAt : resource.data?.checkedAt && Math.floor(resource.data.checkedAt / 1000);

  const tagPrefix = latest?.startsWith('v') ? 'v' : '';
  const changesUrl = latest
    ? /^\d+\.\d+\.\d+$/.test(bare(current)) && available
      ? `${PROJECT_REPOSITORY_URL}/compare/${tagPrefix}${bare(current)}...${encodeURIComponent(latest)}`
      : `${PROJECT_REPOSITORY_URL}/commits/${encodeURIComponent(latest)}`
    : `${PROJECT_REPOSITORY_URL}/releases`;
  const guideUrl = `${PROJECT_REPOSITORY_URL}/blob/main/docs/operations.md#${locale.startsWith('zh') ? '%E5%8D%87%E7%BA%A7%E6%B5%81%E7%A8%8B' : 'upgrade'}`;
  const label = available ? t('available', { version: latest! }) : t('check');

  const dismiss = () => {
    if (!latest) return;
    try { localStorage.setItem(DISMISS_KEY, latest); } catch {}
    setDismissed(latest);
  };
  const undismiss = () => {
    try { localStorage.removeItem(DISMISS_KEY); } catch {}
    setDismissed(null);
  };

  const state = failed ? 'failed' : available ? 'available' : latest ? 'latest' : 'none';
  const Icon = state === 'failed' ? AlertCircle : state === 'available' ? Sparkles : CircleCheck;

  return (
    <Popover placement="bottom-start" offset={8}>
      <PopoverTrigger>
        <button
          type="button"
          aria-label={label}
          title={label}
          className={clsx(
            'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full pr-1 pl-2 text-[12px] transition-colors',
            loud ? 'bg-[var(--polaris-active)] text-[var(--polaris-accent)] ring-1 ring-[var(--polaris-accent)]/25 hover:ring-[var(--polaris-accent)]/45' : 'text-[var(--polaris-ink-3)] hover:bg-[var(--polaris-hover)] hover:text-[var(--polaris-ink-2)]',
            !loud && 'pr-2',
          )}
        >
          <RefreshCw size={15} className="sm:hidden" aria-hidden="true" />
          <span className="polaris-num hidden font-mono sm:inline">{comparable ? `v${bare(current)}` : current}</span>
          {loud ? (
            <span className="hidden h-5 items-center gap-1 rounded-full bg-[var(--polaris-accent)] px-1.5 text-xs font-semibold text-white sm:inline-flex">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inset-0 animate-ping rounded-full bg-white/70 motion-reduce:hidden" />
                <span className="relative h-1.5 w-1.5 rounded-full bg-white" />
              </span>
              {t('newBadge')}
            </span>
          ) : quiet ? (
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[var(--polaris-accent)]/60" />
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent className="max-h-[calc(100dvh-5rem)] w-[19.5rem] max-w-[calc(100vw-1rem)] items-stretch gap-0 overflow-y-auto border border-[var(--polaris-line)] bg-[var(--polaris-card)] p-0 text-[var(--polaris-ink)]">
        <div className="flex items-start gap-3 px-4 pt-4 pb-3">
          <span
            aria-hidden="true"
            className={clsx(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border',
              state === 'available' ? 'border-transparent bg-[var(--polaris-accent)] text-white' : state === 'failed' ? 'border-danger/20 bg-danger/[0.06] text-danger-600' : state === 'latest' ? 'border-success/25 bg-success/[0.08] text-success-700' : 'border-[var(--polaris-line)] bg-[var(--polaris-well)] text-[var(--polaris-ink-3)]',
            )}
          >
            <Icon size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold">{t('title')}</p>
            <p role={failed ? 'alert' : 'status'} className={clsx('mt-0.5 text-[12.5px] leading-snug', failed ? 'text-danger-600' : 'text-[var(--polaris-ink-3)]')}>
              {failed ? t(failureKey) : checking && !latest ? t('checking') : available ? label : !latest ? t('noTags') : comparable ? t('currentLatest') : t('latest', { version: latest })}
            </p>
          </div>
        </div>

        <div className="mx-4 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 rounded-xl bg-[var(--polaris-well)] px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-xs text-[var(--polaris-ink-4)]">{t('currentLabel')}</p>
            <p className="flex items-center gap-1.5 truncate font-mono text-[13px] font-medium">
              {comparable ? `v${bare(current)}` : current}
              {prerelease ? <span className="rounded bg-warning/15 px-1 font-sans text-xs font-medium text-warning-700">{t('devBuild')}</span> : null}
            </p>
          </div>
          <ArrowRight size={14} className="text-[var(--polaris-ink-4)]" aria-hidden="true" />
          <div className="min-w-0 text-right">
            <p className="text-xs text-[var(--polaris-ink-4)]">{t('latestLabel')}</p>
            <p className={clsx('truncate font-mono text-[13px] font-medium', available ? 'text-[var(--polaris-accent)]' : 'text-[var(--polaris-ink)]')}>
              {latest ? `v${bare(latest)}` : checking ? '…' : '—'}
            </p>
          </div>
        </div>

        {runtime === 'go' ? <UpdateControls updater={updater} available={available} /> : available ? (
          <p className="mx-4 mt-3 text-[12px] leading-relaxed text-[var(--polaris-ink-3)]">{t('workerHint')}</p>
        ) : null}

        <div className="flex flex-col gap-1 px-2 pt-3 pb-2">
          {latest ? (
            <a href={changesUrl} target="_blank" rel="noopener noreferrer" className="flex h-8 items-center gap-2 rounded-lg px-2 text-[13px] transition-colors hover:bg-[var(--polaris-hover)]">
              <ArrowUpRight size={14} className="text-[var(--polaris-ink-4)]" aria-hidden="true" />
              <span className="flex-1">{available ? t('releaseNotes') : t('changes', { version: latest })}</span>
            </a>
          ) : null}
          {available || runtime === 'go' && !updater.data?.supported ? (
            <a href={guideUrl} target="_blank" rel="noopener noreferrer" className="flex h-8 items-center gap-2 rounded-lg px-2 text-[13px] transition-colors hover:bg-[var(--polaris-hover)]">
              <BookOpen size={14} className="text-[var(--polaris-ink-4)]" aria-hidden="true" />
              <span className="flex-1">{t('upgradeGuide')}</span>
            </a>
          ) : (
            <a href={`${PROJECT_REPOSITORY_URL}/releases`} target="_blank" rel="noopener noreferrer" className="flex h-8 items-center gap-2 rounded-lg px-2 text-[13px] transition-colors hover:bg-[var(--polaris-hover)]">
              <BookOpen size={14} className="text-[var(--polaris-ink-4)]" aria-hidden="true" />
              <span className="flex-1">{t('releases')}</span>
            </a>
          )}
          {available ? (
            quiet ? (
              <button type="button" onClick={undismiss} className="flex h-8 items-center gap-2 rounded-lg px-2 text-left text-[13px] text-[var(--polaris-ink-3)] transition-colors hover:bg-[var(--polaris-hover)] hover:text-[var(--polaris-ink)]">
                <BellOff size={14} className="text-[var(--polaris-ink-4)]" aria-hidden="true" />
                <span className="flex-1">{t('dismissed')}</span>
                <span className="text-[12px] underline underline-offset-4">{t('undo')}</span>
              </button>
            ) : (
              <button type="button" onClick={dismiss} className="flex h-8 items-center gap-2 rounded-lg px-2 text-left text-[13px] text-[var(--polaris-ink-3)] transition-colors hover:bg-[var(--polaris-hover)] hover:text-[var(--polaris-ink)]">
                <BellOff size={14} className="text-[var(--polaris-ink-4)]" aria-hidden="true" />
                <span className="flex-1">{t('dismiss')}</span>
              </button>
            )
          ) : null}
        </div>

        <div className="flex items-center gap-2 border-t border-[var(--polaris-line-soft)] px-4 py-2.5 text-[11.5px] text-[var(--polaris-ink-4)]">
          <span className="min-w-0 flex-1 truncate">
            {checkedAt ? t('checkedAt', { time: ago(checkedAt) }) : t('notChecked')}
          </span>
          <Button
            size="sm"
            variant="light"
            className="h-7 min-w-0 gap-1.5 px-2 text-[12px]"
            isLoading={checking}
            isDisabled={runtime === 'go' && (!updater.data?.supported || updater.busy)}
            startContent={checking ? undefined : <RefreshCw size={12} />}
            onPress={() => {
              if (runtime === 'go') void updater.command('check');
              else { refreshRequested.current = true; void resource.mutate().catch(() => undefined); }
            }}
          >
            {checking ? t('checking') : t('check')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
