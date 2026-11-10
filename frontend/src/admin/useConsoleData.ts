import { isRetryableApiError } from '@/api/errors';
import { useBackendCapabilities } from '@/api/backend';
import useSWR, { type SWRConfiguration } from 'swr';
import { agentsApi } from './agents/api';
import { overviewApi } from './overview-api';

const LIVE: SWRConfiguration = {
  refreshInterval: 60_000,
  revalidateOnFocus: true,
  dedupingInterval: 5_000,
  keepPreviousData: true,
  shouldRetryOnError: isRetryableApiError,
  errorRetryCount: 2,
};

export const OVERVIEW_KEY = 'console:overview';
export const FLEET_KEY = 'console:agents';

export function useConsoleRefreshInterval() {
  const backend = useBackendCapabilities();
  return backend.data?.runtime === 'go' ? 5000 : 60000;
}

function useLiveOptions() {
  return { ...LIVE, refreshInterval: useConsoleRefreshInterval() };
}

export function useOverview(enabled = true) {
  return useSWR(enabled ? OVERVIEW_KEY : null, () => overviewApi.overview(), useLiveOptions());
}

export function useFleet(enabled = true) {
  return useSWR(enabled ? FLEET_KEY : null, () => agentsApi.listAgents(), useLiveOptions());
}

export function useEvents(limit = 30, enabled = true) {
  return useSWR(enabled ? ['console:events', limit] : null, () => overviewApi.listEvents(limit), useLiveOptions());
}
