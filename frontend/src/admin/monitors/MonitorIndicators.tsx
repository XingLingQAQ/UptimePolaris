import clsx from 'clsx';

import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { StatusDot } from '../../components/ui/StatusDot';
import { useLocale } from '../../i18n/IntlProvider';
import type { Tone } from '../../types/tone';
import { toneForStatus, TYPE_LABEL } from './presentation';
import type { AddonReading, DnsReading, MonitorType, RingHeartbeat } from './types';

/** Status badge: neutral ink for healthy, coloured word for other states. / 状态徽标：正常用中性色，其他状态文字着色。 */
export function StatusPill({
  tone,
  label,
  pulse = false,
  className,
}: {
  tone: Tone;
  label: string;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      className={clsx(
        'inline-flex h-[22px] items-center gap-1.5 rounded-full border px-2 text-[12px] font-medium whitespace-nowrap',
        tone === 'up' || tone === 'idle'
          ? 'border-[var(--polaris-line)] text-[var(--polaris-ink-2)]'
          : tone === 'down'
            ? 'border-danger/25 bg-danger/[0.05] text-danger-600'
            : tone === 'warn'
              ? 'border-warning/30 bg-warning/[0.06] text-warning-700'
              : 'border-orange-500/30 bg-orange-500/[0.06] text-orange-700 dark:text-orange-400',
        className,
      )}
    >
      <StatusDot tone={tone} pulse={pulse} size={6} />
      {label}
    </span>
  );
}

/** Spoken status per stored status number, for the rail's hover title. / 将存储的状态编号映射为文字，用于状态条悬停标题。 */
const STATUS_WORD: Record<number, string> = { 0: 'down', 1: 'up', 2: 'warn', 4: 'pending' };

const RAIL_FILL: Record<Tone, string> = {
  up: 'bg-[var(--polaris-rail-up)]',
  warn: 'bg-warning',
  down: 'bg-danger',
  pending: 'bg-orange-500',
  idle: 'bg-[var(--polaris-rail-empty)]',
};

/** Check rail; healthy segments are lighter so the red one stands out. / 检查条；正常段更浅，让红段突出。 */
export function CheckRail({
  ring,
  emptyLabel,
  className,
  max,
  height = 'h-5',
}: {
  ring: RingHeartbeat[];
  emptyLabel: string;
  className?: string;
  max?: number;
  height?: string;
}) {
  const { locale } = useLocale();
  // Segments grow in left to right on first paint; afterwards only new checks animate. / 首次绘制时各段从左到右生长，之后仅新检查播放动效。
  const firstPaint = useRef(true);
  useEffect(() => {
    firstPaint.current = false;
  }, []);

  if (ring.length === 0) {
    return (
      <div className={clsx('flex items-center', height, className)}>
        <span className="text-[12px] text-[var(--polaris-ink-4)]">{emptyLabel}</span>
      </div>
    );
  }

  const beats = max && ring.length > max ? ring.slice(ring.length - max) : ring;
  const pad = max && beats.length < max ? max - beats.length : 0;

  return (
    <div className={clsx('flex items-stretch gap-[2px]', height, className)}>
      {Array.from({ length: pad }, (_, i) => (
        <span key={`pad-${i}`} className="min-w-[2px] flex-1 rounded-[2px] bg-[var(--polaris-rail-empty)]" />
      ))}
      {beats.map((hb, i) => (
        <span
          key={hb.t}
          style={firstPaint.current ? { animationDelay: `${(i + pad) * 10}ms` } : undefined}
          // Native title rather than a HeroUI tooltip per segment: forty tooltips
          // per row would mount forty component trees and make the table crawl.
          // 使用原生 title；若每行每段使用 HeroUI 提示框，会挂载 40 棵组件树并拖慢表格。
          title={`${new Date(hb.t * 1000).toLocaleString(locale)} · ${STATUS_WORD[hb.up] ?? hb.up}`}
          className={clsx(
            'polaris-grow min-w-[2px] flex-1 rounded-[2px] transition-opacity hover:opacity-70',
            RAIL_FILL[toneForStatus(hb.up as 0 | 1 | 2 | 4)],
          )}
        />
      ))}
    </div>
  );
}

/** Monitor type, as a quiet key - type is not a status and must not compete with one. / 监控类型使用低调标签；类型不是状态，不应抢占状态的视觉重点。 */
export function TypeBadge({ type }: { type: MonitorType }) {
  return (
    <span className="inline-flex h-[18px] items-center rounded-[5px] bg-[var(--polaris-active)] px-1.5 font-mono text-[10px] font-medium tracking-wider text-[var(--polaris-ink-2)]">
      {TYPE_LABEL[type]}
    </span>
  );
}

/** The shape every add-on chip shares, so SSL, DOMAIN and DNS line up as one row. / 附加项共用的徽章形状，使 SSL、DOMAIN 和 DNS 排列一致。 */
function AddonShell({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span
      className={clsx(
        'inline-flex h-[18px] items-center gap-1 whitespace-nowrap rounded-[5px] border px-1.5 text-[10.5px] font-medium [&>svg]:h-3 [&>svg]:w-3',
        className,
      )}
    >
      {children}
    </span>
  );
}

const ADDON_TONE: Record<'up' | 'warn' | 'down' | 'idle', string> = {
  up: 'border-[var(--polaris-line)] text-[var(--polaris-ink-2)]',
  warn: 'border-warning/30 bg-warning/[0.06] text-warning-700',
  down: 'border-danger/25 bg-danger/[0.05] text-danger-600',
  idle: 'border-dashed border-[var(--polaris-line-strong)] text-[var(--polaris-ink-4)]',
};

/** Add-on chip; show the day count only when the reading is trustworthy. / 附加检查徽标；读数可信时才显示天数。 */
export function AddonChip({
  label,
  reading,
  emptyLabel,
  icon,
}: {
  label: string;
  reading: AddonReading | undefined;
  emptyLabel: string;
  icon?: ReactNode;
}) {
  if (!reading || reading.ts === 0) {
    return (
      <AddonShell className={ADDON_TONE.idle}>
        {icon}
        {label} · {emptyLabel}
      </AddonShell>
    );
  }

  const tone = reading.st === 1 ? 'up' : reading.st === 0 ? 'down' : 'warn';

  return (
    <AddonShell className={clsx('polaris-num', ADDON_TONE[tone])}>
      {icon}
      {label} {reading.days === null ? '—' : `${Math.round(reading.days)}d`}
    </AddonShell>
  );
}

/** DNS chip only appears when the row needs attention. / 仅当该行需要关注时显示 DNS 徽标。 */
export function DnsChip({
  label,
  reading,
  emptyLabel,
}: {
  label: string;
  reading: DnsReading | undefined;
  emptyLabel: string;
}) {
  if (!reading || reading.ts === 0) {
    return (
      <AddonShell className={ADDON_TONE.idle}>
        {label} · {emptyLabel}
      </AddonShell>
    );
  }
  if (reading.st === 1) return null;
  return (
    <AddonShell className={ADDON_TONE[reading.st === 2 ? 'warn' : 'down']}>
      {label}
      <X size={11} strokeWidth={2.5} aria-hidden="true" />
    </AddonShell>
  );
}
