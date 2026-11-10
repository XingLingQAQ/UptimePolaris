import { useMaintenanceTimeline } from '@/components/alerts/hooks/useMaintenanceTimeline';
import { dateStringToTimestamp, timezoneOffsetToMs } from '@/components/charts/format';
import { useMarkdown } from '@/hooks/useMarkdown';
import { extractPlainText, getMarkdownClasses } from '@/lib/markdown';
import type { Maintenance } from '@/types/config';
import type { Incident } from '@/types/monitor';
import clsx from 'clsx';
import { motion } from 'framer-motion';
import { CalendarClock, ChevronDown, CircleAlert, Info, TriangleAlert, Wrench } from 'lucide-react';
import { useId, useMemo, useState, type ReactNode } from 'react';
import type { DateTimeFormatOptions } from 'use-intl';
import { useFormatter, useTranslations } from 'use-intl';

type NoticeTone = 'info' | 'warning' | 'danger' | 'neutral';

const TONE: Record<NoticeTone, { badge: string; icon: string; bar: string }> = {
  info: { badge: 'bg-[#3b82f6]/10 text-[#2563eb] dark:text-[#60a5fa]', icon: 'text-[#2563eb] dark:text-[#60a5fa]', bar: 'bg-[#3b82f6]' },
  warning: { badge: 'bg-warning/12 text-warning-700', icon: 'text-warning-700', bar: 'bg-warning' },
  danger: { badge: 'bg-danger/10 text-danger-600', icon: 'text-danger-600', bar: 'bg-danger' },
  neutral: { badge: 'bg-[var(--polaris-active)] text-[var(--polaris-ink-2)]', icon: 'text-[var(--polaris-ink-3)]', bar: 'bg-[var(--polaris-ink-4)]' },
};

const UTC_FORMAT: DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' };

/**
 * A notice on the status page: maintenance or an incident.
 *
 * A white block with a tinted mark and a tag that says what kind of notice it
 * is; the body is folded until asked for, so a page with three notices still
 * leads with the monitors. The body mounts on first open only - markdown
 * rendering is not free, and most visitors never open it.
 *
 * 状态页通知用于维护或事件：白色区块使用有色色标和类型标签；正文默认折叠，
 * 即使有三条通知，页面仍以监控项为主。Markdown 渲染有成本，而大多数访客不会
 * 展开正文，因此仅首次展开时挂载。
 */
function NoticeCard({
  tone,
  icon,
  tag,
  title,
  preview,
  meta,
  live = false,
  children,
}: {
  tone: NoticeTone;
  icon: ReactNode;
  tag?: string;
  title: string;
  preview?: string;
  meta?: ReactNode;
  /** A notice about something happening now: its mark breathes. / 正在发生的通知，其标记播放呼吸动效。 */
  live?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(false);
  const id = useId();
  const style = TONE[tone];

  return (
    <article className="polaris-card polaris-rise relative overflow-hidden">
      <span aria-hidden="true" className={clsx('absolute inset-y-0 left-0 w-[3px]', style.bar)} />
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setOpen((value) => !value);
          setSeen(true);
        }}
        className="flex w-full items-start gap-3.5 py-4 pr-4 pl-5 text-left transition-colors hover:bg-[var(--polaris-hover)]"
      >
        <span className={clsx('mt-0.5 inline-flex shrink-0 [&>svg]:h-[18px] [&>svg]:w-[18px]', style.icon, live && 'polaris-live')}>{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            {tag ? (
              <span className={clsx('inline-flex h-5 items-center rounded-full px-2 text-[11px] font-medium', style.badge)}>{tag}</span>
            ) : null}
            <span className="min-w-0 truncate text-[14px] font-semibold text-[var(--polaris-ink)]">{title}</span>
          </span>
          {preview && !open ? (
            <span className="mt-1 line-clamp-2 block text-[13px] leading-relaxed text-[var(--polaris-ink-3)]">{preview}</span>
          ) : null}
          {meta ? <span className="mt-1.5 block text-[12px] text-[var(--polaris-ink-3)]">{meta}</span> : null}
        </span>
        <ChevronDown
          size={16}
          className={clsx('mt-0.5 shrink-0 text-[var(--polaris-ink-4)] transition-transform duration-200', open && 'rotate-180')}
        />
      </button>
      <div
        className={clsx(
          'grid transition-[grid-template-rows,opacity] duration-200 ease-out',
          open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        )}
      >
        <div id={id} role="region" aria-hidden={!open} inert={!open} className="overflow-hidden">
          <div className="border-t border-[var(--polaris-line-soft)] py-4 pr-5 pl-[52px]">{seen ? children : null}</div>
        </div>
      </div>
    </article>
  );
}

/** A maintenance window: scheduled or in progress, with its progress when it is running. / 计划中或进行中的维护时段；进行时显示进度。 */
export function MaintenanceNotice({ maintenance }: { maintenance: Maintenance }) {
  const t = useTranslations('maintenance');
  const format = useFormatter();
  const now = Date.now();
  const timeline = useMaintenanceTimeline(maintenance, now);
  const html = useMarkdown(maintenance.description || '');
  const active = maintenance.status === 'under-maintenance';
  const scheduled = maintenance.status === 'scheduled';

  const range = timeline
    ? `${format.dateTime(timeline.displayStartTime, UTC_FORMAT)} – ${format.dateTime(timeline.displayEndTime, UTC_FORMAT)}`
    : '';

  return (
    <NoticeCard
      tone={active ? 'warning' : 'info'}
      live={active}
      icon={active ? <Wrench /> : <CalendarClock />}
      tag={active ? t('InProgress') : scheduled ? t('Scheduled') : t('default')}
      title={maintenance.title}
      preview={maintenance.description ? extractPlainText(maintenance.description, 160) : undefined}
      meta={
        timeline ? (
          <span className="polaris-num">
            {range}
            {active
              ? ` · ${t('EndsIn', { time: format.relativeTime(timeline.endTime, now) })}`
              : ` · ${t('StartsIn', { time: format.relativeTime(timeline.startTime, now) })}`}
          </span>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4">
        {timeline && active ? (
          <div>
            <div className="mb-1.5 flex items-center justify-between text-[12px]">
              <span className="text-[var(--polaris-ink-3)]">{t('Progress')}</span>
              <span className="polaris-num font-medium text-warning-700">{timeline.progressPercent}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-[var(--polaris-active)]">
              <motion.span
                className="block h-full rounded-full bg-warning"
                initial={{ width: 0 }}
                animate={{ width: `${timeline.progressPercent}%` }}
                transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
              />
            </div>
          </div>
        ) : null}
        {maintenance.description && html ? (
          <div className={getMarkdownClasses()} dangerouslySetInnerHTML={{ __html: html }} />
        ) : null}
        <p className="text-[12px] text-[var(--polaris-ink-4)]">{t('timezoneInfo', { timezone: maintenance.timezoneOffset || 'UTC' })}</p>
      </div>
    </NoticeCard>
  );
}

/** An incident or announcement posted on the page, rendered from its markdown. / 页面上以 Markdown 渲染的事件或公告。 */
export function IncidentNotice({ incident }: { incident: Incident }) {
  const t = useTranslations('alert');
  const format = useFormatter();
  const now = Date.now();
  const html = useMarkdown(incident.content);

  const tone: NoticeTone =
    incident.style === 'danger' ? 'danger' : incident.style === 'warning' ? 'warning' : incident.style === 'light' || incident.style === 'dark' ? 'neutral' : 'info';
  const Icon = tone === 'danger' ? CircleAlert : tone === 'warning' ? TriangleAlert : Info;

  const created = incident.createdDate ? dateStringToTimestamp(`${incident.createdDate} +00:00`) : null;
  const updated = incident.lastUpdatedDate ? dateStringToTimestamp(`${incident.lastUpdatedDate} +00:00`) : null;

  const stamp = useMemo(() => {
    if (updated) return t('updatedAt', { time: format.relativeTime(updated, now) });
    if (created) return t('createdAt', { time: format.dateTime(created + timezoneOffsetToMs('+00:00'), UTC_FORMAT) });
    return undefined;
  }, [created, format, now, t, updated]);

  return (
    <NoticeCard
      tone={tone}
      icon={<Icon />}
      title={incident.title}
      preview={extractPlainText(incident.content, 160)}
      meta={stamp}
    >
      <div className="flex flex-col gap-3">
        <div className={getMarkdownClasses()} dangerouslySetInnerHTML={{ __html: html }} />
        {created ? (
          <p className="text-[12px] text-[var(--polaris-ink-4)]">
            {t('createdAt', { time: format.dateTime(created + timezoneOffsetToMs('+00:00'), UTC_FORMAT) })}
          </p>
        ) : null}
      </div>
    </NoticeCard>
  );
}
