import { ArrowUpRight, CalendarClock, Wrench } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Outlet } from 'react-router';
import { useTranslations } from 'use-intl';
import { useLocale } from '@/i18n/IntlProvider';
import type { PublicMaintenanceState as MaintenanceState } from '../../../../shared/maintenance';
import { RouteLoading } from '@/routes/RouteStates';
import { publicConfigKey } from '@/config/api';
import { usePublicConfigResource } from '@/config/usePublicConfig';
import {
  BRAND_BLUE,
  BRAND_RING_PATH,
  RING,
  TIGHT_VIEWBOX,
} from '../../../../shared/brand-mark';
import { MAINTENANCE_STYLE } from '../../../../shared/maintenance-style';

// 按服务器时间靠近维护边界重查；卸载后不再提交轮询结果。
// Recheck near maintenance boundaries using server time and ignore results after unmount.
export function PublicMaintenance() {
  const [state, setState] = useState<MaintenanceState | null>(null);
  const [ready, setReady] = useState(false);
  const { locale, applyDefaultLocale } = useLocale();
  const t = useTranslations('publicMaintenance');
  const { data: config } = usePublicConfigResource(state?.active ? publicConfigKey() : null);

  useEffect(() => {
    let stopped = false;
    let timer: number;
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      let delay = 15_000;
      try {
        const response = await fetch('/api/public/maintenance', {
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('maintenance request failed');
        const state = (await response.json()) as MaintenanceState;
        if (stopped) return;
        const preview = new URLSearchParams(window.location.search).get(
          'preview',
        );
        if (state.active && (preview === 'monitor' || preview === 'agent')) {
          const previewResponse = await fetch(
            `/api/public/config?preview=${preview}`,
            { cache: 'no-store' },
          ).catch(() => null);
          if (stopped) return;
          if (previewResponse?.ok) {
            setState({ ...state, active: false, scheduled: [] });
            setReady(true);
            timer = window.setTimeout(load, delay);
            return;
          }
        }
        if (state.active && window.location.pathname !== '/') {
          window.location.replace('/');
          return;
        }
        setState(state);
        setReady(true);
        const boundary = state.active
          ? state.endsAt
          : state.scheduled[0]?.startsAt;
        if (boundary) {
          const remaining = Date.parse(boundary) - Date.parse(state.serverNow);
          if (Number.isFinite(remaining))
            delay = Math.max(250, Math.min(delay, remaining + 100));
        }
      } catch {
        if (!stopped) setReady(true);
      } finally {
        inFlight = false;
      }
      if (!stopped) timer = window.setTimeout(load, delay);
    };
    void load();
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        window.clearTimeout(timer);
        void load();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  useEffect(() => {
    if (!state?.active || !config) return;
    const controller = new AbortController();
    void applyDefaultLocale(config.presentation.locale, controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [state?.active, config?.presentation.locale, applyDefaultLocale]);

  if (!ready) return <RouteLoading />;
  if (state?.active) return <MaintenancePage state={state} />;

  return (
    <>
      {!!state?.scheduled.length && (
        <aside
          aria-label={t('scheduled')}
          className="border-b border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
        >
          <div className="mx-auto flex max-w-[1120px] items-start gap-3 px-4 py-3 sm:px-6">
            <CalendarClock
              size={18}
              className="mt-0.5 shrink-0"
              aria-hidden="true"
            />
            <div className="min-w-0 space-y-2 text-sm">
              {state.scheduled.map((period, index) => (
                <div key={`${period.startsAt}:${index}`}>
                  <p className="font-semibold">
                    {period.title || t('scheduled')}
                  </p>
                  {period.description && (
                    <p className="mt-0.5 whitespace-pre-wrap break-words">
                      {period.description}
                    </p>
                  )}
                  <p className="mt-0.5 text-xs">
                    <time dateTime={period.startsAt}>
                      {new Date(period.startsAt).toLocaleString(locale, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </time>
                    {' – '}
                    <time dateTime={period.endsAt}>
                      {new Date(period.endsAt).toLocaleString(locale, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </time>
                  </p>
                </div>
              ))}
            </div>
          </div>
        </aside>
      )}
      <Outlet />
    </>
  );
}

export function MaintenancePage({ state }: { state: MaintenanceState }) {
  const { locale } = useLocale();
  const t = useTranslations('publicMaintenance');
  const maintenance = useTranslations('maintenance');
  return (
    <main className="polaris-maintenance">
      <style>{MAINTENANCE_STYLE}</style>
      <div className="maintenance-wrap">
        <header className="maintenance-header">
          <span className="maintenance-brand">
            <MaintenanceMark size={28} />
            Uptime Polaris
          </span>
          <a href="/login" className="maintenance-login">
            {t('signIn')}
            <ArrowUpRight size={15} aria-hidden="true" />
          </a>
        </header>
        <section className="maintenance-content">
          <div className="maintenance-copy">
            <h1>{state.title || maintenance('InProgress')}</h1>
            <p className="maintenance-description">
              {state.description || t('description')}
            </p>
            {state.endsAt && (
              <p className="maintenance-end">
                <span>{t('expectedEnd')}</span>
                <time dateTime={state.endsAt}>
                  {new Date(state.endsAt).toLocaleString(locale, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </time>
              </p>
            )}
          </div>
          <div className="maintenance-visual" aria-hidden="true">
            <MaintenanceMark size={240} className="maintenance-orbit" />
            <Wrench className="maintenance-tool" strokeWidth={1.5} />
          </div>
        </section>
      </div>
    </main>
  );
}

function MaintenanceMark({
  size,
  className,
}: {
  size: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      viewBox={TIGHT_VIEWBOX}
      width={size}
      height={size}
      aria-hidden="true"
    >
      <path
        d={BRAND_RING_PATH}
        fill="none"
        stroke={BRAND_BLUE}
        strokeWidth={RING.strokeWidth}
        strokeLinecap="round"
      />
    </svg>
  );
}
