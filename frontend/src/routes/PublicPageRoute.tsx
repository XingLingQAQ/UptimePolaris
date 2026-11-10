import { useEffect } from 'react';
import { useTranslations } from 'use-intl';
import { StatusPageRoute } from './StatusPageRoute';
import { RouteError, RouteLoading } from './RouteStates';
import { PresentationViewContext } from '@/components/context/PresentationViewContext';
import { PublicServersPage } from '@/components/servers/PublicServersPage';
import { usePublicConfig } from '@/config/usePublicConfig';
import { applyDefaultTheme } from '@/lib/browser-preferences';
import { useTheme } from 'next-themes';
import { useLocale } from '@/i18n/IntlProvider';

export function PublicPageRoute() {
  const { data: config, error, refresh, isValidating } = usePublicConfig();
  const t = useTranslations('presentation');
  const { setTheme } = useTheme();
  const { applyDefaultLocale } = useLocale();
  useEffect(() => {
    if (!config || config.presentation.kind !== 'agent') return;
    applyDefaultTheme(config.presentation.colorMode, setTheme);
    const controller = new AbortController();
    void applyDefaultLocale(config.presentation.locale, controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [config?.presentation.kind, config?.presentation.colorMode, config?.presentation.locale, setTheme, applyDefaultLocale]);
  if (!config) return error ? <RouteError code="render" error={error} onRetry={() => { void refresh().catch(() => undefined); }} /> : <RouteLoading />;
  if (!config.presentation.configured || !config.presentation.enabled) return <main className="mx-auto max-w-3xl px-6 py-20"><h1 className="text-2xl font-semibold">{t(!config.presentation.configured ? 'unconfigured' : 'disabled')}</h1><p className="mt-3 text-default-500">{t(!config.presentation.configured ? 'unconfiguredHint' : 'disabledHint')}</p></main>;
  return <PresentationViewContext.Provider value={config.presentation}>{config.presentation.kind === 'agent' ? <PublicServersPage config={config} configError={error} configRefreshing={isValidating} onRefreshConfig={refresh} /> : <StatusPageRoute />}</PresentationViewContext.Provider>;
}
