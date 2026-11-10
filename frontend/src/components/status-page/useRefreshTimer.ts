import { useApiErrorMessage } from '@/api/useApiErrorMessage';
import { toastError, toastInfo, toastLoading, toastSuccess } from '@/components/ui/ToastHost';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';

/** Single status-page refresh clock; freshness comes from the last successfully received monitor payload. / 状态页共用刷新计时器；数据新鲜度以最后一次成功接收的监控数据为准。 */
export function useRefreshTimer(onRefresh: () => Promise<unknown> | unknown, interval = 60_000, lastRefresh: number | null = null) {
  const t = useTranslations('timer');
  const apiErrorMessage = useApiErrorMessage();
  const [paused, setPaused] = useState(false);
  const [left, setLeft] = useState(interval);
  const [refreshing, setRefreshing] = useState(false);
  const busy = useRef(false);
  const leftRef = useRef(interval);

  const refresh = useCallback(
    async (announce: boolean) => {
      // 手动与定时刷新共用锁，避免并发刷新同一页面。 / Manual and scheduled refreshes share a lock to prevent concurrent requests.
      if (busy.current) return;
      busy.current = true;
      setRefreshing(true);
      const id = announce ? await toastLoading(t('refreshing')) : undefined;
      try {
        await onRefresh();
        if (announce) await toastSuccess(t('refreshSuccess'), id);
      } catch (error) {
        await toastError(apiErrorMessage(error), id);
      } finally {
        busy.current = false;
        setRefreshing(false);
        leftRef.current = interval;
        setLeft(interval);
      }
    },
    [interval, onRefresh, t, apiErrorMessage],
  );

  useEffect(() => {
    if (paused) return;
    const timer = window.setInterval(() => {
      leftRef.current -= 1000;
      if (leftRef.current <= 0) {
        leftRef.current = interval;
        void refresh(false);
      }
      setLeft(leftRef.current);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [interval, paused, refresh]);

  const togglePause = useCallback(() => {
    void toastInfo(paused ? t('resumedInfo') : t('pausedInfo'));
    setPaused(!paused);
  }, [paused, t]);

  return {
    paused,
    refreshing,
    lastRefresh,
    secondsLeft: Math.max(0, Math.ceil(left / 1000)),
    progress: paused ? 0 : 1 - left / interval,
    refresh: () => void refresh(true),
    togglePause,
  };
}

export type RefreshTimer = ReturnType<typeof useRefreshTimer>;
