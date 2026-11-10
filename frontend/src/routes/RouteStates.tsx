import { useApiErrorMessage } from '@/api/useApiErrorMessage';
import { BrandLoader } from '@/components/ui/BrandLoader';
import clsx from 'clsx';
import { AlertTriangle } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { errorMessageKey, type RouteErrorCode } from './route-errors';

/**
 * Loading state for the initial config fetch.
 *
 * The wait is the brand mark turning rather than a generic spinner glyph: this
 * screen is the first thing a visitor sees, and it is also what the console
 * shows between chunks, so it should already look like the product rather than
 * like a placeholder that happened to be mounted. See `BrandLoader` for why the
 * mark's 50° gap is what makes the rotation read.
 *
 * The label comes from the catalog because this renders on the public page too,
 * where the reader's language is whatever the header is set to.
 *
 * 初始配置加载使用旋转的品牌标记而非通用图标：这是访客首先看到的界面，也用于
 * 控制台切换分块，因此应像产品的一部分而非临时占位符。标记的 50° 缺口使旋转
 * 可辨识，详见 `BrandLoader`。此状态也用于公开页面，因此标签取自当前所选语言包。
 */
export function RouteLoading({ embedded = false }: { embedded?: boolean }) {
  const t = useTranslations();
  return (
    <div className={clsx('polaris-route-loading flex items-center justify-center bg-[var(--polaris-canvas)]', embedded ? 'min-h-80 flex-1' : 'min-h-screen')}>
      <BrandLoader label={t('status.loading')} />
    </div>
  );
}

/**
 * Route-level error surface.
 *
 * The route-level message stays generic; fetch and render errors can contain
 * private target or request details.
 *
 * 路由级错误标题保持通用，避免暴露获取或渲染错误中的私有目标和请求详情。
 */
export function RouteError({ code, error, onRetry, embedded = false }: { code: RouteErrorCode; error?: unknown; onRetry?: () => void; embedded?: boolean }) {
  const t = useTranslations();
  const apiErrorMessage = useApiErrorMessage();
  const key = errorMessageKey(code);
  const heading = key ? t(key) : t('errorPage.title');
  return (
    <div className={clsx('flex items-center justify-center bg-[var(--polaris-canvas)] px-6', embedded ? 'min-h-80 flex-1' : 'min-h-screen')}>
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-danger/10 text-danger-600">
          <AlertTriangle size={22} />
        </span>
        <p className="text-[17px] font-semibold tracking-[-0.01em] text-[var(--polaris-ink)]">{heading}</p>
        <p className="text-small text-[var(--polaris-ink-2)]">{error ? apiErrorMessage(error) : t('errorPage.recoveryHint')}</p>
        <div className="flex gap-3">
          {code === 'render' ? <button type="button" className="rounded-lg border border-[var(--polaris-line-strong)] px-4 py-2 text-small" onClick={onRetry ?? (() => window.location.reload())}>{t('errorPage.reload')}</button> : null}
          <a href="/" className="rounded-lg border border-[var(--polaris-line-strong)] px-4 py-2 text-small">{t('page.main')}</a>
        </div>
      </div>
    </div>
  );
}
