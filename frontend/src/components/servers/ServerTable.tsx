import { Meter } from '@/components/ui/MetricMeters';
import { TONE_TEXT } from '@/components/ui/StatusDot';
import clsx from 'clsx';
import { ArrowDown, ChevronDown, Star } from 'lucide-react';
import { Fragment } from 'react';
import { useNavigate } from 'react-router';
import { useTranslations } from 'use-intl';
import type { PublicServer } from '../../../../shared/public-servers';
import { known, loadTone, percentText, publishes, resourceKinds, resourcePercent, type ResourceKind, type ServerSort } from './model';
import type { MachineItemProps } from './ServerCard';
import { CompareToggle, Identity, LiveTrend, NetRates, PinButton, Recency, StatusBadge, TagChips, uptimeText } from './ServerParts';

export interface TableSection { key: string; label: string; pinned?: boolean; online: number; rows: PublicServer[]; collapsed: boolean; onToggle?: () => void }
type Row = Pick<MachineItemProps, 'now' | 'selectionFull' | 'onPin' | 'onSelect' | 'onTag'>;

/**
 * The fleet as one ledger: a shared header, group rows between sections, one row per machine.
 * Columns that carry numbers sort; only published columns appear. A clicked row opens the detail.
 *
 * 以单个表格展示机群：共用表头，分组之间插入分组行，每台机器一行。数值列可排序，只显示已公开的列；点击行打开详情。
 */
export function ServerTable({ sections, hrefOf, samplesOf, pins, selection, sort, onSort, ...row }: Row & {
  sections: TableSection[]; hrefOf: (id: string) => string; samplesOf: (id: string) => MachineItemProps['samples'];
  pins: string[]; selection: string[]; sort: string; onSort: (sort: ServerSort) => void;
}) {
  const t = useTranslations('presentation');
  const navigate = useNavigate();
  const all = sections.flatMap(section => section.rows);
  const kinds = resourceKinds.filter(kind => all.some(server => publishes(server, kind)));
  const network = all.some(server => server.upload !== undefined || server.download !== undefined);
  const uptime = all.some(server => server.uptime !== undefined);
  const live = all.some(server => server.cpu !== undefined);
  const span = 5 + kinds.length + (live ? 1 : 0) + (network ? 1 : 0) + (uptime ? 1 : 0);
  const head = (key: ServerSort, label: string, className?: string) => (
    <th className={className} aria-sort={sort === key ? (key === 'name' ? 'ascending' : 'descending') : undefined}>
      <button type="button" onClick={() => onSort(sort === key ? 'default' : key)} className={clsx('inline-flex items-center gap-1 transition-colors hover:text-[var(--polaris-ink)]', sort === key && 'text-[var(--polaris-ink)]')}>
        {label}<ArrowDown size={12} aria-hidden="true" className={clsx('transition-transform', sort === key ? 'opacity-100' : 'opacity-0', key === 'name' && 'rotate-180')} />
      </button>
    </th>
  );
  return (
    <div className="server-table-scroll polaris-card polaris-scroll-x min-w-0 max-w-full overflow-x-auto" role="region" aria-label={t('listView')} tabIndex={0}>
      <table className="polaris-table server-table min-w-[820px]">
        <thead>
          <tr>
            <th className="w-11"><span className="sr-only">{t('compare')}</span></th>
            {head('name', t('machine'))}
            <th className="w-[5.5rem]">{t('status')}</th>
            {kinds.map(kind => head(kind, t(kind), 'w-[8.5rem]'))}
            {live ? <th className="server-table-secondary hidden w-32 xl:table-cell">{t('liveCpu')}</th> : null}
            {network ? head('network', t('networkLive'), 'w-[7.5rem]') : null}
            {uptime ? head('uptime', t('uptime'), 'server-table-secondary hidden w-[6rem] lg:table-cell') : null}
            <th className="server-table-secondary hidden w-[7rem] lg:table-cell">{t('reported')}</th>
            <th className="w-11"><span className="sr-only">{t('pin')}</span></th>
          </tr>
        </thead>
        <tbody>
          {sections.map(section => section.rows.length ? (
            <Fragment key={section.key}>
              {section.label ? (
                <tr className="server-group-row">
                  <th colSpan={span} scope="colgroup">
                    {section.onToggle ? (
                      <button type="button" aria-expanded={!section.collapsed} onClick={section.onToggle} className="inline-flex items-center gap-2 rounded-md px-1 py-0.5 transition-colors hover:bg-[var(--polaris-hover)]">
                        <ChevronDown size={13} aria-hidden="true" className={clsx('text-[var(--polaris-ink-4)] transition-transform', section.collapsed && '-rotate-90')} />
                        <GroupTitle section={section} />
                      </button>
                    ) : <span className="inline-flex items-center gap-2 px-1"><Star size={13} aria-hidden="true" className="fill-amber-400 text-amber-500" /><GroupTitle section={section} /></span>}
                  </th>
                </tr>
              ) : null}
              {section.collapsed ? null : section.rows.map(server => {
                const href = hrefOf(server.id);
                const selected = selection.includes(server.id);
                return (
                  <tr key={`${section.key}:${server.id}`} data-server-id={server.id} className={clsx('cursor-pointer', selected && 'is-selected', server.online === false && 'is-offline')}
                    onClick={event => { if (!(event.target as HTMLElement).closest('a,button')) navigate(href); }}>
                    <td><CompareToggle selected={selected} disabled={row.selectionFull} name={server.name} onToggle={() => row.onSelect(server.id)} /></td>
                    <td className="server-table-identity max-w-[22rem]"><Identity server={server} size="sm" href={href} extra={<span className="ml-1 hidden shrink-0 xl:inline-flex"><TagChips server={server} onTag={row.onTag} limit={2} /></span>} /></td>
                    <td><StatusBadge server={server} /></td>
                    {kinds.map(kind => <td key={kind}><Cell server={server} kind={kind} /></td>)}
                    {live ? <td className="server-table-secondary hidden xl:table-cell"><LiveTrend samples={samplesOf(server.id)} field="cpu" max={100} height={22} className={server.online === true ? 'text-[var(--polaris-chart)]' : 'text-[var(--polaris-ink-4)]'} /></td> : null}
                    {network ? <td><NetRates server={server} className="flex-col !items-start !gap-0.5" /></td> : null}
                    {uptime ? <td className="server-table-secondary polaris-num hidden text-[12.5px] whitespace-nowrap text-[var(--polaris-ink-2)] lg:table-cell">{server.uptime === undefined ? '' : uptimeText(server)}</td> : null}
                    <td className="server-table-secondary hidden text-[12px] lg:table-cell"><Recency server={server} now={row.now} /></td>
                    <td><PinButton pinned={pins.includes(server.id)} name={server.name} onToggle={() => row.onPin(server.id)} /></td>
                  </tr>
                );
              })}
            </Fragment>
          ) : null)}
        </tbody>
      </table>
    </div>
  );
}

function GroupTitle({ section }: { section: TableSection }) {
  const t = useTranslations('presentation');
  return <><span className="text-[12.5px] font-semibold text-[var(--polaris-ink)]">{section.label}</span><span className="polaris-num text-[12px] font-normal text-[var(--polaris-ink-4)]">{section.pinned ? section.rows.length : t('groupOnline', { online: section.online, n: section.rows.length })}</span></>;
}

function Cell({ server, kind }: { server: PublicServer; kind: ResourceKind }) {
  if (!publishes(server, kind)) return <span className="text-[var(--polaris-ink-4)]">—</span>;
  const value = resourcePercent(server, kind);
  const tone = server.online === true ? loadTone(value) : 'idle';
  return (
    <span className="flex flex-col gap-1.5">
      <span className={clsx('polaris-num text-[12.5px] font-semibold', !known(value) || tone === 'up' || tone === 'idle' ? 'text-[var(--polaris-ink)]' : TONE_TEXT[tone], server.online !== true && '!text-[var(--polaris-ink-3)]')}>{percentText(value)}</span>
      <Meter value={value} tone={tone === 'up' ? 'primary' : tone} />
    </span>
  );
}
