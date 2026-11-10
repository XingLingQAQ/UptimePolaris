import { CountryFlag } from '@/admin/components/CountryFlag';
import { useLocale } from '@/i18n/IntlProvider';
import { OsBadge } from '@/admin/components/OsBadge';
import { formatBytes, formatDuration, formatRate } from '@/admin/format';
import { Meter } from '@/components/ui/MetricMeters';
import { SparkLine } from '@/components/ui/MetricFigures';
import { TONE_TEXT } from '@/components/ui/StatusDot';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, Check, Star } from 'lucide-react';
import { Link } from 'react-router';
import { useTranslations } from 'use-intl';
import type { PublicServer } from '../../../../shared/public-servers';
import { known, loadTone, percentText, publishes, relativeAge, resourcePercent, stateOf, type ResourceKind } from './model';
import { countryCode, regionLabel } from './geo';
import type { LiveSample } from './useVisitorState';

const STATE_PILL = {
  online: 'bg-success/10 text-success-700',
  offline: 'bg-danger/10 text-danger-600',
  unknown: 'bg-[var(--polaris-active)] text-[var(--polaris-ink-3)]',
} as const;
const STATE_DOT = { online: 'polaris-live bg-success', offline: 'polaris-halo bg-danger', unknown: 'bg-default-300' } as const;

export function StatusBadge({ server, className }: { server: PublicServer; className?: string }) {
  const t = useTranslations('presentation');
  const state = stateOf(server);
  return (
    <span className={clsx('inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-full px-2 text-[11.5px] font-medium whitespace-nowrap', STATE_PILL[state], className)}>
      <span aria-hidden="true" className={clsx('h-1.5 w-1.5 rounded-full', STATE_DOT[state])} />
      {t(state)}
    </span>
  );
}

export function StateDot({ server, className }: { server: PublicServer; className?: string }) {
  const state = stateOf(server);
  return <span aria-hidden="true" className={clsx('inline-block h-2 w-2 shrink-0 rounded-full', STATE_DOT[state], className)} />;
}

/** How long ago the machine last reported, on the server's clock. / 按服务器时钟显示距上次上报的时间。 */
export function Recency({ server, now, className }: { server: PublicServer; now: number; className?: string }) {
  const t = useTranslations('presentation');
  if (!known(server.reportedAt) || server.reportedAt === 0) return <span className={clsx('text-[var(--polaris-ink-4)]', className)}>{t('noReport')}</span>;
  const age = relativeAge(Math.max(0, now - server.reportedAt), t);
  const stamp = new Date(server.reportedAt * 1000);
  return (
    <time dateTime={stamp.toISOString()} title={stamp.toLocaleString()} className={clsx('polaris-num whitespace-nowrap', server.online === false ? 'text-danger-600' : 'text-[var(--polaris-ink-3)]', className)}>
      {server.online === false ? t('lastReport', { age }) : age}
    </time>
  );
}

export function Identity({ server, size = 'md', href, className, as: Name = 'p', extra }: { server: PublicServer; size?: 'sm' | 'md' | 'lg'; href?: string; className?: string; as?: 'p' | 'h1' | 'h3'; extra?: React.ReactNode }) {
  const t = useTranslations('presentation');
  const { locale } = useLocale();
  const country = countryCode(server.region);
  const meta = [server.os, server.arch, regionLabel(server.region, locale)].filter(Boolean).join(' · ');
  return (
    <div className={clsx('flex min-w-0 items-center gap-3', className)}>
      {server.os !== undefined ? <OsBadge os={server.os ?? null} size={size} /> : null}
      <div className="min-w-0">
        <Name className={clsx('flex min-w-0 items-center gap-1.5 font-semibold tracking-[-0.01em] text-[var(--polaris-ink)]', size === 'lg' ? 'text-[22px] leading-7' : 'text-[14px] leading-5')}>
          {server.region !== undefined && country ? <CountryFlag code={country} size={size === 'lg' ? 18 : 14} /> : null}
          {href ? <Link to={href} className="server-link truncate">{server.name}</Link> : <span className="truncate">{server.name}</span>}
          {extra}
        </Name>
        <p className="mt-0.5 truncate text-[12px] text-[var(--polaris-ink-3)]">{meta || (server.group?.name ?? t('ungrouped'))}</p>
      </div>
    </div>
  );
}

export function TagChips({ server, onTag, limit }: { server: PublicServer; onTag?: (id: string) => void; limit?: number }) {
  const t = useTranslations('presentation');
  const tags = limit ? server.tags.slice(0, limit) : server.tags;
  if (!tags.length) return null;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {tags.map(tag => {
        const body = <><span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} /><span className="truncate">{tag.name}</span></>;
        const style = 'inline-flex h-5 max-w-[10rem] items-center gap-1 rounded-md border border-[var(--polaris-line)] bg-[var(--polaris-card)] px-1.5 text-[11px] text-[var(--polaris-ink-2)]';
        return onTag
          ? <button key={tag.id} type="button" className={clsx(style, 'transition-colors hover:border-[var(--polaris-line-strong)] hover:text-[var(--polaris-ink)]')} title={t('filterByTag', { tag: tag.name })} onClick={() => onTag(tag.id)}>{body}</button>
          : <span key={tag.id} className={style}>{body}</span>;
      })}
      {limit && server.tags.length > limit ? <span className="polaris-num text-[11px] text-[var(--polaris-ink-4)]">+{server.tags.length - limit}</span> : null}
    </span>
  );
}

/** A resource reading: label, value and a bar against 100%, in the console's own meter. / 资源读数：标签、数值和相对 100% 的进度条，使用控制台同款仪表。 */
export function ResourceLine({ kind, server, detail = true }: { kind: ResourceKind; server: PublicServer; detail?: boolean }) {
  const t = useTranslations('presentation');
  if (!publishes(server, kind)) return null;
  const value = resourcePercent(server, kind);
  const tone = server.online === true ? loadTone(value) : 'idle';
  const amount = kind === 'memory' ? [server.memoryUsed, server.memoryTotal] : kind === 'disk' ? [server.diskUsed, server.diskTotal] : null;
  return (
    <div className="min-w-0">
      <div className="flex items-baseline gap-2 text-[12px] leading-4">
        <span className="text-[var(--polaris-ink-3)]">{t(kind)}</span>
        {detail && amount && known(amount[0]) ? <span className="polaris-num min-w-0 truncate text-[11px] text-[var(--polaris-ink-4)]">{formatBytes(amount[0])} / {formatBytes(amount[1])}</span> : null}
        <span className={clsx('polaris-num ml-auto font-semibold', tone === 'up' || tone === 'idle' ? 'text-[var(--polaris-ink)]' : TONE_TEXT[tone], server.online !== true && 'text-[var(--polaris-ink-3)]')}>{percentText(value)}</span>
      </div>
      <Meter className="mt-1.5" value={value} tone={tone === 'up' ? 'primary' : tone} label={`${t(kind)} ${percentText(value)}`} />
    </div>
  );
}

export function NetRates({ server, className }: { server: PublicServer; className?: string }) {
  const t = useTranslations('presentation');
  if (server.upload === undefined && server.download === undefined) return null;
  const stale = server.online === false;
  return (
    <span className={clsx('inline-flex min-w-0 items-center gap-3 text-[12px]', stale ? 'text-[var(--polaris-ink-4)]' : 'text-[var(--polaris-ink-2)]', className)} title={stale ? t('lastNetworkReading') : t('networkLive')}>
      {server.upload !== undefined ? <span className="polaris-num inline-flex items-center gap-1 whitespace-nowrap"><ArrowUp size={12} className="text-[var(--polaris-ink-4)]" aria-hidden="true" /><span className="sr-only">{t('upload')}</span>{formatRate(server.upload)}</span> : null}
      {server.download !== undefined ? <span className="polaris-num inline-flex items-center gap-1 whitespace-nowrap"><ArrowDown size={12} className="text-[var(--polaris-ink-4)]" aria-hidden="true" /><span className="sr-only">{t('download')}</span>{formatRate(server.download)}</span> : null}
      {stale ? <span className="sr-only">{t('lastNetworkReading')}</span> : null}
    </span>
  );
}

export function uptimeText(server: PublicServer) {
  return server.uptime === 0 ? '0m' : formatDuration(server.uptime);
}

/**
 * The live line drawn from samples collected while this page is open; it says so until there are two points.
 * 页面打开期间采集的实时走势；不足两个采样点时显示采集中。
 */
export function LiveTrend({ samples, field, max, height = 26, className }: { samples: LiveSample[] | undefined; field: keyof Omit<LiveSample, 't'>; max?: number; height?: number; className?: string }) {
  const t = useTranslations('presentation');
  const values = (samples ?? []).map(sample => sample[field]);
  const finite = values.filter(known);
  if (finite.length < 2) {
    return <span className={clsx('flex items-end', className)} style={{ height }}><span className="server-collecting w-full text-[11px] text-[var(--polaris-ink-4)]">{t('collecting')}</span></span>;
  }
  return <SparkLine values={values} min={0} max={max ?? Math.max(...finite) * 1.15} height={height} className={className} label={t('liveTrend')} animate={false} />;
}

export function PinButton({ pinned, onToggle, name, className }: { pinned: boolean; onToggle: () => void; name: string; className?: string }) {
  const t = useTranslations('presentation');
  return (
    <button type="button" aria-pressed={pinned} aria-label={t(pinned ? 'unpinMachine' : 'pinMachine', { name })} title={t(pinned ? 'unpin' : 'pin')} onClick={onToggle}
      className={clsx('inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--polaris-hover)]', pinned ? 'text-amber-500' : 'text-[var(--polaris-ink-4)] hover:text-[var(--polaris-ink)]', className)}>
      <Star size={15} fill={pinned ? 'currentColor' : 'none'} aria-hidden="true" />
    </button>
  );
}

export function CompareToggle({ selected, disabled, onToggle, name, className }: { selected: boolean; disabled: boolean; onToggle: () => void; name: string; className?: string }) {
  const t = useTranslations('presentation');
  return (
    <button type="button" role="checkbox" aria-checked={selected} aria-label={t('compareMachine', { name })} title={t(disabled && !selected ? 'compareLimit' : selected ? 'removeFromCompare' : 'addToCompare')} disabled={disabled && !selected} onClick={onToggle}
      className={clsx('inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--polaris-hover)] disabled:cursor-not-allowed disabled:opacity-40', className)}>
      <span aria-hidden="true" className={clsx('inline-flex h-4 w-4 items-center justify-center rounded-[5px] border transition-colors', selected ? 'border-[var(--polaris-ink)] bg-[var(--polaris-ink)] text-[var(--polaris-canvas)]' : 'border-[var(--polaris-line-strong)] bg-[var(--polaris-card)]')}>
        {selected ? <Check size={11} strokeWidth={3} /> : null}
      </span>
    </button>
  );
}
