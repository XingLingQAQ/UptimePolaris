
import { requestJson } from '@/api/client';
import { isRetryableApiError } from '@/api/errors';
import { publicApiUrl } from '@/api/public-url';
import { usePageConfig, usePageConfigKey } from '@/components/context/PageConfigContext';
import { fetchPublicConfig, publicConfigKey } from '@/config/api';
import { usePublicConfigResource } from '@/config/usePublicConfig';
import type { MonitorResponse, MonitoringData } from '@/types/monitor';
import type { SWRConfiguration } from 'swr';
import useSWR, { mutate } from 'swr';

/**
 * swr 通用 fetcher / Shared SWR fetcher
 * @param url - 请求的 URL / Request URL
 * @returns 解析后的 JSON data / Parsed JSON data
 * @throws 请求失败抛出错误 / Throws if the request fails
 */
const fetcher = async <T>(url: string): Promise<T> => {
  if (url.split('?')[0].endsWith('/api/public/config')) return fetchPublicConfig(url) as Promise<T>;
  const data = await requestJson<Record<string, unknown>>(url);
  return { ...data, receivedAt: Date.now() } as T;
};

/**
 * SWR Cache Key / SWR 缓存键
 */
export const SWR_KEYS = {
  MONITOR: (pageId: string) => publicApiUrl('/api/public/monitors', pageId),
  CONFIG: publicConfigKey,
};

/**
 * 默认配置 / Default configuration
 */
const DEFAULT_SWR_CONFIG: SWRConfiguration = {
  revalidateOnFocus: false,
  revalidateOnReconnect: true,
  dedupingInterval: 3000,
  errorRetryCount: 3,
  errorRetryInterval: 1000,
  shouldRetryOnError: isRetryableApiError,
  loadingTimeout: 5000,
};

interface PrefetchOptions {
  ttlMs?: number;
  force?: boolean;
}

const DEFAULT_PREFETCH_TTL_MS = 30_000;
const MAX_CONCURRENT_PREFETCHES = 2;

let activePrefetches = 0;
const prefetchedAt = new Map<string, number>();
const inFlightPrefetchKeys = new Set<string>();

/** 将预取结果写入 SWR 缓存；跳过或失败时返回 false。 / Populate the SWR cache; return false when skipped or failed. */
export async function prefetchSWRKey<T>(key: string, options: PrefetchOptions = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_PREFETCH_TTL_MS;
  const now = Date.now();
  const lastPrefetchedAt = prefetchedAt.get(key);

  // TTL 和并发上限共同限制反复悬停带来的预取请求。 / TTL and concurrency limits bound prefetches from repeated hovering.
  if (!options.force && lastPrefetchedAt && now - lastPrefetchedAt < ttlMs) {
    return false;
  }

  if (inFlightPrefetchKeys.has(key) || activePrefetches >= MAX_CONCURRENT_PREFETCHES) {
    return false;
  }

  activePrefetches += 1;
  prefetchedAt.set(key, now);
  inFlightPrefetchKeys.add(key);

  try {
    await mutate(key, fetcher<T>(key), {
      populateCache: true,
      revalidate: false,
    });

    return true;
  } catch {
    return false;
  } finally {
    activePrefetches -= 1;
    inFlightPrefetchKeys.delete(key);
  }
}

/**
 * 获取监控数据的 hook / Hook for fetching monitor data
 * @param config - SWR 配置 / SWR configuration
 * @returns 监控数据、加载状态和错误信息 / Monitor data, loading state, and error
 */
export function useMonitorData(config?: SWRConfiguration) {
  const { pageId } = usePageConfig();

  const {
    data,
    error,
    isLoading,
    mutate: revalidate,
  } = useSWR<MonitorResponse & { receivedAt: number }>(SWR_KEYS.MONITOR(pageId), fetcher, {
    ...DEFAULT_SWR_CONFIG,
    refreshInterval: 0,
    revalidateOnReconnect: false,
    shouldRetryOnError: false,
    keepPreviousData: true, // 页面切换时保留旧数据，避免闪烁 / Keep previous data during page switches to prevent flicker
    ...config,
  });

  return {
    monitorGroups: data?.monitorGroups || [],
    receivedAt: data?.receivedAt ?? null,
    monitoringData: data?.data || { heartbeatList: {}, uptimeList: {} },
    isLoading,
    isError: !!error,
    error,
    revalidate,
  };
}

/**
 * 获取单个 monitor 数据 / Fetch a single monitor
 * @param monitorId - 监控 ID / Monitor ID
 * @param config - SWR 配置选项 / SWR configuration options
 * @returns 特定监控的数据、加载状态和错误信息 / The monitor data, loading state, and error
 */
export function useMonitor(monitorId: number | string, config?: SWRConfiguration) {
  const numericId = typeof monitorId === 'string' ? Number.parseInt(monitorId, 10) : monitorId;
  const { pageId } = usePageConfig();

  const {
    data,
    error,
    isLoading,
    mutate: revalidate,
  } = useSWR<MonitorResponse>(SWR_KEYS.MONITOR(pageId), fetcher, {
    ...DEFAULT_SWR_CONFIG,
    refreshInterval: 0,
    revalidateOnReconnect: false,
    shouldRetryOnError: false,
    ...config,
  });

  const monitor = data?.monitorGroups
    ?.flatMap(group => group.monitorList)
    .find(m => m.id === numericId);

  const monitoringData: MonitoringData = {
    heartbeatList: {
      [numericId]: data?.data?.heartbeatList[numericId] || [],
    },
    uptimeList: {
      [`${numericId}_24`]: data?.data?.uptimeList[`${numericId}_24`] ?? null,
    },
    uptimeCoverage: {
      [`${numericId}_24`]: data?.data?.uptimeCoverage?.[`${numericId}_24`] ?? 0,
    },
  };

  return {
    monitor,
    monitoringData,
    isLoading,
    isError: !!error,
    error,
    revalidate,
  };
}

/**
 * 获取 SWR 全局配置 / Fetch global SWR configuration
 * @param config - SWR 配置选项 / SWR configuration options
 * @returns 全局配置数据、加载状态和错误信息 / Global configuration data, loading state, and error
 */
export function useConfig(config?: SWRConfiguration) {
  const key = usePageConfigKey();
  const { data, error, isLoading, refresh: revalidate } = usePublicConfigResource(key, config);
  return { config: data, isLoading, isError: !!error, error, revalidate };
}

/** Refresh the monitor/config payloads for a page; reject fetch errors so refresh controls can report failure. / 刷新页面监控和配置数据；请求失败时拒绝，使刷新控件能够报告错误。 */
export function revalidateData(pageId: string, key?: string, refreshConfig?: () => Promise<unknown>) {
  const refresh = (key: string) => mutate(key, fetcher(key), { revalidate: false, throwOnError: true });
  if (key) {
    return refresh(key);
  }

  return Promise.all([refresh(SWR_KEYS.MONITOR(pageId)), refreshConfig ? refreshConfig() : refresh(SWR_KEYS.CONFIG(pageId))]);
}
