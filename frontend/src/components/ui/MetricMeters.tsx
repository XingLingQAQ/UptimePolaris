import type { Tone } from '@/types/tone';
import clsx from 'clsx';
import { motion } from 'framer-motion';
import { useReducedMotion } from '@/lib/useReducedMotion';
import type { ReactNode } from 'react';

/**
 * A ratio against a limit, as a bar or ring.
 *
 * Shared because the public monitor page uses both (uptime ring, expiry
 * meters). It used to live in `admin/kit.tsx`, whose HeroUI import pulled the
 * whole design system into the public bundle; only framer-motion is needed.
 * 公开页也要用；拆出避免把 HeroUI 打进公开包。
 */

export type MeterTone = Tone | 'primary';

/*
 * `primary` is the neutral bar: ink on a light track, the way a usage bar reads
 * when nothing about it is wrong. Status tones colour the fill only - the track
 * stays the same grey, so a row of meters lines up as one ruler.
 *
 * `primary` 是中性条：浅色轨道上使用文字色，像正常的资源使用量。状态色仅用于填充；
 * 轨道始终保持相同灰色，使一排仪表像同一把标尺。
 */
const FILL: Record<MeterTone, string> = {
  up: 'bg-success',
  warn: 'bg-warning',
  down: 'bg-danger',
  pending: 'bg-orange-500',
  idle: 'bg-default-300',
  primary: 'bg-[var(--polaris-ink)] opacity-80',
};

/** A ratio against a limit, as one thin bar. `value` is 0-100. / 用细条显示相对上限的比例，`value` 范围为 0–100。 */
export function Meter({
  value,
  tone = 'primary',
  className,
  label,
}: {
  value: number | null;
  tone?: MeterTone;
  className?: string;
  label?: string;
}) {
  const reduced = useReducedMotion();
  const pct = value === null || !Number.isFinite(value) ? 0 : Math.max(0, Math.min(100, value));
  return (
    <span
      role={label ? 'meter' : undefined}
      aria-label={label}
      aria-valuenow={label && value !== null ? Math.round(pct) : undefined}
      aria-valuemin={label ? 0 : undefined}
      aria-valuemax={label ? 100 : undefined}
      className={clsx('block h-1 w-full overflow-hidden rounded-full bg-[var(--polaris-active)]', className)}
    >
      <motion.span
        className={clsx('block h-full w-full origin-left rounded-full', FILL[tone])}
        initial={reduced ? false : { scaleX: 0 }}
        animate={{ scaleX: pct / 100 }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      />
    </span>
  );
}

const RING_STROKE: Record<MeterTone, string> = {
  up: 'stroke-success',
  warn: 'stroke-warning',
  down: 'stroke-danger',
  pending: 'stroke-orange-500',
  idle: 'stroke-default-300',
  primary: 'stroke-[var(--polaris-ink)]',
};

/** One proportion as a ring, with whatever the caller puts in its centre. / 用圆环显示比例，中心内容由调用方提供。 */
export function Ring({
  value,
  size = 72,
  stroke = 7,
  tone = 'primary',
  label,
  children,
}: {
  /** 0-1. */
  value: number;
  size?: number;
  stroke?: number;
  tone?: MeterTone;
  label?: string;
  children?: ReactNode;
}) {
  const reduced = useReducedMotion();
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const clamped = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          className="stroke-[var(--polaris-active)]"
        />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          className={RING_STROKE[tone]}
          strokeDasharray={circumference}
          initial={reduced ? false : { strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: circumference * (1 - clamped) }}
          transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
        />
      </svg>
      {children ? <div className="absolute inset-0 flex items-center justify-center">{children}</div> : null}
    </div>
  );
}
