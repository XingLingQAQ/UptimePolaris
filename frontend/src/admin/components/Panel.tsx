import clsx from 'clsx';

import type { ReactNode } from 'react';
import type { Hue } from '../../types/tone';

/** A framed block that takes the remaining height in its column. / 占据列中剩余高度的带框区块。 */
export function FillingPanel({
  children,
  className,
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section className={clsx('polaris-card flex min-h-0 flex-1 flex-col overflow-hidden', padded && 'p-5', className)}>
      {children}
    </section>
  );
}

/** Thin wrapper so every framed block shares one surface treatment. / 轻量包装器，让带框区块使用统一表面样式。 */
export function Panel({
  children,
  className,
  padded = true,
  id,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
  id?: string;
}) {
  return (
    <section id={id} className={clsx('polaris-card overflow-hidden', padded && 'p-5', className)}>
      {children}
    </section>
  );
}

/**
 * A block's title row: an optional bare glyph, the title, one line of
 * description, and actions on the right. No tinted tile - the title is the
 * marker.
 *
 * 区块标题行包含可选图标、标题、说明和右侧操作，不使用彩色图标块。
 */
export function PanelHeader({
  title,
  description,
  actions,
  icon,
  className,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  icon?: ReactNode;
  /** Accepted for older call sites; the header no longer tints its glyph. / 为现有调用方保留此参数；标题图标不再着色。 */
  hue?: Hue;
  className?: string;
}) {
  return (
    <div className={clsx('mb-4 flex flex-wrap items-start gap-x-3 gap-y-2', className)}>
      <div className="min-w-0 flex-1">
        <h2 className="flex items-center gap-2 text-[14px] leading-5 font-semibold tracking-[-0.01em] text-[var(--polaris-ink)]">
          {icon ? (
            <span aria-hidden="true" className="inline-flex text-[var(--polaris-ink-4)] [&>svg]:h-[15px] [&>svg]:w-[15px]">
              {icon}
            </span>
          ) : null}
          {title}
        </h2>
        {description ? <p className="mt-0.5 text-[12.5px] leading-5 text-[var(--polaris-ink-3)]">{description}</p> : null}
      </div>
      {actions ? <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
