import { PageConfigProvider } from '@/components/context/PageConfigContext';
import { PresentationViewContext } from '@/components/context/PresentationViewContext';
import { MonitorDetailContent } from '@/components/monitor/MonitorDetailContent';
import { MonitorDataPreload } from '@/components/status-page/MonitorDataPreload';
import { StatusPageShell } from '@/components/status-page/StatusPageShell';
import { toPageConfig } from '@/config/api';
import { usePublicConfig } from '@/config/usePublicConfig';
import { useParams, useSearchParams } from 'react-router';
import { RouteError, RouteLoading } from './RouteStates';

export function MonitorDetailRoute() {
  const { id: monitorId } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const { data, error, mutate, key } = usePublicConfig(searchParams.get('pageId') ?? undefined);
  if (!data) return error ? <RouteError code="render" error={error} onRetry={() => { void mutate(); }} /> : <RouteLoading />;
  const config = toPageConfig(data);

  return (
    <PageConfigProvider key={key} initialConfig={config} configKey={key}>
      <PresentationViewContext.Provider value={data.presentation}>
        <StatusPageShell>
          <MonitorDataPreload pageId={config.pageId} />
          <MonitorDetailContent monitorId={monitorId ?? ''} />
        </StatusPageShell>
      </PresentationViewContext.Provider>
    </PageConfigProvider>
  );
}
