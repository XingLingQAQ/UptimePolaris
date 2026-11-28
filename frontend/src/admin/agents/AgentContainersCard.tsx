import { useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { AlertTriangle, Box, ChevronDown } from 'lucide-react';
import { asContainerStats, type AgentContainer } from '../../../../shared/agent-containers';
import { IconTile } from '../components/IconTile';
import { formatBytes, formatOneDecimal } from '../format';

const CONTAINER_PREVIEW_LIMIT = 8;
type Filter = 'all' | 'running' | 'issues';
const hasIssue = (row: AgentContainer) => row.health === 'unhealthy' || row.state === 'restarting' || row.state === 'dead';
const rank = (row: AgentContainer) => hasIssue(row) ? 0 : row.state === 'running' ? 1 : 2;

const STATUS_STYLES = {
  danger: { dot: 'bg-danger-500', text: 'text-danger-600 dark:text-danger-400' },
  warning: { dot: 'bg-warning-500', text: 'text-warning-700 dark:text-warning-400' },
  success: { dot: 'bg-success-500', text: 'text-success-700 dark:text-success-400' },
  default: { dot: 'bg-default-400', text: 'text-default-500' },
};

function statusTone(row: AgentContainer): keyof typeof STATUS_STYLES {
  if (row.health === 'unhealthy' || row.state === 'dead') return 'danger';
  if (row.state === 'restarting' || row.health === 'starting') return 'warning';
  return row.state === 'running' ? 'success' : 'default';
}

export function AgentContainersCard({ containersJson }: { containersJson?: string | null }) {
  const t = useTranslations('admin.agents');
  const containers = useMemo(() => {
    if (!containersJson) return null;
    try { return asContainerStats(JSON.parse(containersJson))?.sort((a, b) => rank(a) - rank(b)) ?? null; }
    catch { return null; }
  }, [containersJson]);
  const [filter, setFilter] = useState<Filter>('all');
  const [expanded, setExpanded] = useState(false);
  if (!containers?.length) return null;
  const running = containers.filter(row => row.state === 'running').length;
  const issues = containers.filter(hasIssue).length;
  const issueTone = containers.some(row => statusTone(row) === 'danger') ? 'danger' : 'warning';
  const counts = { all: containers.length, running, issues };
  const filters = (['all', 'running', 'issues'] as const).filter(value => counts[value] > 0);
  const showFilters = filters.length > 1 && new Set(containers.map(row => `${row.state}:${row.health ?? 'none'}`)).size > 1;
  const activeFilter = showFilters && counts[filter] > 0 ? filter : 'all';
  const filtered = containers.filter(row => activeFilter === 'all' || (activeFilter === 'running' ? row.state === 'running' : hasIssue(row)));
  const visible = expanded ? filtered : filtered.slice(0, CONTAINER_PREVIEW_LIMIT);
  return (
    <section className="polaris-card overflow-hidden" aria-label={t('sectionContainers')}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <h3 className="flex items-center gap-2.5 text-small font-semibold">
          <IconTile icon={<Box />} hue="default" size="sm" />{t('sectionContainers')}
          <span className="rounded-full bg-[var(--polaris-active)] px-2 py-0.5 text-[11px] font-medium tabular-nums text-default-500">{containers.length}</span>
        </h3>
        <div className="flex items-center gap-3 text-tiny tabular-nums">
          <span className="text-default-500">{t('containersRunning', { count: running })}</span>
          {issues > 0 ? <span className={`inline-flex items-center gap-1 ${STATUS_STYLES[issueTone].text}`}><AlertTriangle size={13} aria-hidden="true" />{t('containersIssues', { count: issues })}</span> : null}
        </div>
      </div>
      <div className="border-t border-[var(--polaris-line-soft)] p-3">
        {showFilters ? (
          <div role="group" aria-label={t('containerFilter')} className="mb-3 inline-flex flex-wrap items-center gap-0.5 rounded-medium bg-default-100 p-0.5">
            {filters.map(value => (
              <button key={value} type="button" aria-pressed={activeFilter === value}
                onClick={() => { setFilter(value); setExpanded(false); }}
                className={`inline-flex cursor-pointer items-center gap-1.5 rounded-small px-2.5 py-1 text-tiny font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${activeFilter === value ? 'bg-content1 text-foreground shadow-small' : 'text-default-500 hover:text-foreground'}`}>
                {t(`containerFilters.${value}`)}{' '}<span className="tabular-nums">{counts[value]}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="space-y-2">
          {visible.map(row => {
            const metrics = row.image != null || row.cpu_pct != null || row.mem_used_bytes != null || (row.restart_count ?? 0) > 0;
            const tone = statusTone(row);
            return (
              <div key={row.id} className="polaris-well px-3 py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                  <div className="flex min-w-0 flex-1 basis-40 items-center gap-1.5">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_STYLES[tone].dot}`} aria-hidden="true" />
                    <span className="truncate text-small font-medium" title={row.name}>{row.name}</span>
                    <span className="shrink-0 rounded border border-[var(--polaris-line-soft)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-default-500">{row.runtime}</span>
                  </div>
                  <span className={`inline-flex items-center gap-1 text-tiny ${STATUS_STYLES[tone].text}`}>
                    {tone === 'danger' || tone === 'warning' ? <AlertTriangle size={12} aria-hidden="true" /> : null}
                    {t(`containerState.${row.state}`)}
                    {row.health && row.health !== 'none' ? <> · {t(`containerHealth.${row.health}`)}</> : null}
                  </span>
                </div>
                {metrics ? <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-tiny text-default-500 tabular-nums">
                  {row.image ? <span className="max-w-[14rem] truncate font-mono text-default-400" title={row.image}>{row.image}</span> : null}
                  {row.cpu_pct != null ? <span className="text-default-600">{t('containerCpu', { value: formatOneDecimal(row.cpu_pct) })}</span> : null}
                  {row.mem_used_bytes != null ? <span className="text-default-600">{t('containerMemory', { value: row.mem_limit_bytes == null ? formatBytes(row.mem_used_bytes) : `${formatBytes(row.mem_used_bytes)} / ${formatBytes(row.mem_limit_bytes)}` })}</span> : null}
                  {(row.restart_count ?? 0) > 0 ? <span className="text-warning-700 dark:text-warning-400">{t('containerRestarts', { count: row.restart_count! })}</span> : null}
                </div> : null}
              </div>
            );
          })}
          {!filtered.length ? <p role="status" className="py-3 text-center text-small text-default-500">{t('containersNoMatches')}</p> : null}
        </div>
        {filtered.length > CONTAINER_PREVIEW_LIMIT ? (
          <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}
            className="mt-2.5 flex w-full cursor-pointer items-center justify-center gap-1 rounded-lg border border-[var(--polaris-line-soft)] py-1.5 text-tiny font-medium text-default-500 transition-colors hover:bg-[var(--polaris-hover)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
            {expanded ? t('hardwareShowLess') : t('hardwareShowAll', { count: filtered.length })}
            <ChevronDown size={14} className={expanded ? 'rotate-180 transition-transform' : 'transition-transform'} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </section>
  );
}
