import clsx from 'clsx';
import { Clock3, Gauge } from 'lucide-react';
import { memo } from 'react';
import { useTranslations } from 'use-intl';
import type { PublicServer } from '../../../../shared/public-servers';
import { known, resourceKinds } from './model';
import { CompareToggle, Identity, LiveTrend, NetRates, PinButton, Recency, ResourceLine, StatusBadge, TagChips, uptimeText } from './ServerParts';
import type { LiveSample } from './useVisitorState';

export interface MachineItemProps {
  server: PublicServer; href: string; now: number; samples: LiveSample[] | undefined;
  pinned: boolean; selected: boolean; selectionFull: boolean;
  onPin: (id: string) => void; onSelect: (id: string) => void; onTag: (id: string) => void;
}

const PADDING = { compact: 'p-3.5 gap-3', normal: 'p-4 gap-3.5', comfortable: 'p-5 gap-4' } as const;

/**
 * A machine as a card: identity and state, the three resource meters, the live CPU line, then network, uptime and recency.
 * The name link covers the card, so the whole card opens the detail; pin and compare sit above it.
 *
 * 机器卡片：身份与状态、三项资源条、实时 CPU 走势，以及网络、运行时间和上报时间。
 * 名称链接覆盖整张卡片，点击任意位置打开详情；收藏和对比按钮位于其上层。
 */
export const ServerCard = memo(function ServerCard({ server, href, now, samples, pinned, selected, selectionFull, onPin, onSelect, onTag, density }: MachineItemProps & { density: keyof typeof PADDING }) {
  const t = useTranslations('presentation');
  const online = server.online === true;
  const resources = resourceKinds.filter(kind => (kind === 'cpu' ? server.cpu : kind === 'memory' ? server.memoryUsed : server.diskUsed) !== undefined);
  return (
    <article data-server-id={server.id} aria-label={server.name}
      className={clsx('server-card polaris-card polaris-card-press group relative flex min-w-0 flex-col', PADDING[density], selected && 'is-selected', server.online === false && 'is-offline')}>
      <header className="server-card-header flex min-w-0 items-start gap-2">
        <Identity server={server} href={href} as="h3" className="server-card-identity min-w-0 flex-1" />
        <StatusBadge server={server} className="mt-0.5" />
      </header>
      <div className="server-card-tags-row relative z-10 -mt-1 flex min-h-5 items-center gap-1 empty:hidden">
        <TagChips server={server} onTag={onTag} limit={3} />
        <span className="server-card-actions ml-auto flex items-center">
          <PinButton pinned={pinned} name={server.name} onToggle={() => onPin(server.id)} className={pinned ? '' : 'server-reveal'} />
          <CompareToggle selected={selected} disabled={selectionFull} name={server.name} onToggle={() => onSelect(server.id)} className={selected ? '' : 'server-reveal'} />
        </span>
      </div>
      {resources.length ? <div className={clsx('server-card-resources flex flex-col gap-3', !online && 'opacity-70')}>{resources.map(kind => <ResourceLine key={kind} kind={kind} server={server} />)}</div> : null}
      {server.cpu !== undefined ? (
        <div className="server-card-trend flex items-end gap-3">
          <span className="shrink-0 pb-0.5 text-[11.5px] text-[var(--polaris-ink-4)]">{t('liveCpu')}</span>
          <LiveTrend samples={samples} field="cpu" max={100} className={clsx('min-w-0 flex-1', online ? 'text-[var(--polaris-chart)]' : 'text-[var(--polaris-ink-4)]')} />
        </div>
      ) : null}
      <footer className="mt-auto flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-[var(--polaris-line-soft)] pt-3 text-[12px] text-[var(--polaris-ink-3)]">
        <NetRates server={server} />
        {server.load !== undefined ? <span className="polaris-num inline-flex items-center gap-1" title={t('load')}><Gauge size={12} className="text-[var(--polaris-ink-4)]" aria-hidden="true" /><span className="sr-only">{t('load')}</span>{known(server.load) ? server.load.toFixed(2) : '—'}</span> : null}
        {server.uptime !== undefined ? <span className="polaris-num inline-flex items-center gap-1" title={t('uptime')}><Clock3 size={12} className="text-[var(--polaris-ink-4)]" aria-hidden="true" /><span className="sr-only">{t('uptime')}</span>{uptimeText(server)}</span> : null}
        <Recency server={server} now={now} className="ml-auto text-[11.5px]" />
      </footer>
    </article>
  );
});
