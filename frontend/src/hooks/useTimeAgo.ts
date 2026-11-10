import { useCallback } from 'react';
import { useTranslations } from 'use-intl';

/**
 * Coarse relative time, as one function every surface shares. Buckets are
 * deliberately wide: the exact timestamp belongs in a title attribute.
 *
 * The keys are read from `common.list`, which the public catalogs also carry -
 * the public page prints the same "3 min ago" a console row does. It lives here
 * rather than in `admin/kit.tsx` because that module's other exports pull in
 * HeroUI, and this one is needed by the public list.
 *
 * 各界面共用粗粒度相对时间，刻意使用较宽时间区间；精确时间放在 title 属性中。
 * 消息来自公开目录也包含的 `common.list`，因此公开页面与控制台都能显示相同的
 * “3 分钟前”。公开列表需要此函数，放在此处可避免导入 `admin/kit.tsx` 的其他
 * HeroUI 依赖。
 */
export function useTimeAgo() {
  const t = useTranslations('common');
  return useCallback(
    (epochSec: number) => {
      const secs = Math.max(0, Math.floor(Date.now() / 1000) - epochSec);
      if (secs < 45) return t('list.justNow');
      if (secs < 3600) return t('list.agoMin', { n: Math.max(1, Math.round(secs / 60)) });
      if (secs < 86400) return t('list.agoHour', { n: Math.round(secs / 3600) });
      return t('list.agoDay', { n: Math.round(secs / 86400) });
    },
    [t],
  );
}
