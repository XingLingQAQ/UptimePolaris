import type { Tone } from '@/types/tone';
import clsx from 'clsx';
import type { DayStat } from '../../../../shared/contracts';
import { TONE_BG } from '../ui/StatusDot';

export function AvailabilityRail({
  days,
  emptyLabel,
  className,
}: {
  days: DayStat[];
  emptyLabel: string;
  className?: string;
}) {
  if (days.length === 0) {
    return (
      <div className={clsx('flex h-7 items-center', className)}>
        <span className="text-tiny text-default-400">{emptyLabel}</span>
      </div>
    );
  }

  return (
    <div className={clsx('flex h-7 items-end gap-px', className)}>
      {days.map((day) => {
        const total = day.t || 0;
        const bad = total - day.u - day.w;
        const tone: Tone = total === 0 ? 'idle' : bad === 0 ? 'up' : bad / total > 0.05 ? 'down' : 'warn';
        const pct = total === 0 ? null : ((day.u + day.w) / total) * 100;

        return (
          <span
            key={day.d}
            title={pct === null ? day.d : `${day.d} · ${pct.toFixed(2)}%${day.avg === null ? '' : ` · ${Math.round(day.avg)}ms`}`}
            className={clsx(
              'inline-block h-full flex-1 rounded-[1px] min-w-[2px] transition-opacity hover:opacity-70',
              TONE_BG[tone],
              total === 0 && 'opacity-40',
            )}
          />
        );
      })}
    </div>
  );
}

