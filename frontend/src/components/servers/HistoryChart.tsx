import { useReducedMotion } from '@/lib/useReducedMotion';
import { memo, useId, useMemo } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from 'recharts';

export interface ChartSeries { key: string; label: string; color: string }
export type ChartRow = { t: number } & Record<string, number | null>;

/**
 * Inserts an empty row where samples stop, so a line breaks across missing data instead of bridging it.
 * The expected spacing is the median gap; anything past 2.5× of it is a hole.
 *
 * 在采样中断处插入空行，让线条在缺失数据处断开而非连接。以中位间隔为基准，超过 2.5 倍视为缺口。
 */
export function withGaps(rows: ChartRow[], keys: string[]): ChartRow[] {
  const gaps = rows.slice(1).map((row, index) => row.t - rows[index].t).filter(value => value > 0).sort((a, b) => a - b);
  const interval = gaps[Math.floor(gaps.length / 2)] ?? 60;
  return rows.flatMap((row, index) => index && row.t - rows[index - 1].t > interval * 2.5
    ? [{ t: rows[index - 1].t + interval, ...Object.fromEntries(keys.map(key => [key, null])) } as ChartRow, row]
    : [row]);
}

/**
 * The console's time-series chart with more than one line: same hairline grid, axis type and tooltip as
 * `TrendChart`, a faint wash under each line, and an accessible table twin.
 *
 * 多序列时间图：与 TrendChart 相同的细网格、坐标轴文字和提示框，每条线下方带淡色填充，并附无障碍数据表。
 */
export const HistoryChart = memo(function HistoryChart({ rows, series, format, formatTime, formatTip, domain, height = 200, label }: {
  rows: ChartRow[]; series: ChartSeries[]; format: (value: number) => string; formatTime: (t: number) => string; formatTip: (t: number) => string;
  domain?: [number, number | 'auto']; height?: number; label: string;
}) {
  const reduced = useReducedMotion();
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const data = useMemo(() => withGaps(rows, series.map(item => item.key)), [rows, series]);
  const span: [number, number] | undefined = rows.length ? [rows[0].t, rows[rows.length - 1].t] : undefined;
  return (
    <div className="polaris-chart relative" style={{ height }} role="group" aria-label={label}
      onPointerDownCapture={event => { event.currentTarget.dataset.pointerFocus = 'true'; }}
      onKeyDownCapture={event => { delete event.currentTarget.dataset.pointerFocus; }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }} aria-label={label}>
          <defs>
            {series.map(item => (
              <linearGradient key={item.key} id={`${id}-${item.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={item.color} stopOpacity={series.length > 2 ? 0.06 : 0.16} />
                <stop offset="100%" stopColor={item.color} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="t" type="number" domain={span ?? ['dataMin', 'dataMax']} tickFormatter={formatTime} tickLine={false} axisLine={false} minTickGap={48} tickMargin={8} />
          <YAxis width={64} tickFormatter={format} tickLine={false} axisLine={false} tickCount={4} domain={domain ?? [0, 'auto']} allowDataOverflow={Boolean(domain && domain[1] !== 'auto')} />
          <Tooltip isAnimationActive={false} cursor={{ stroke: 'currentColor', strokeOpacity: 0.16, strokeWidth: 1, strokeDasharray: '3 3' }}
            content={(props: TooltipContentProps) => <HistoryTooltip {...props} series={series} format={format} formatTip={formatTip} />} />
          {series.map(item => (
            <Area key={item.key} type="monotone" dataKey={item.key} name={item.label} stroke={item.color} strokeWidth={1.75} fill={`url(#${id}-${item.key})`}
              connectNulls={false} dot={false} activeDot={{ r: 3.5, strokeWidth: 2, stroke: 'var(--polaris-card)', fill: item.color }}
              isAnimationActive={!reduced} animationDuration={650} animationEasing="ease-out" />
          ))}
        </AreaChart>
      </ResponsiveContainer>
      <div className="sr-only">
        <table>
          <caption>{label}</caption>
          <thead><tr><td />{series.map(item => <th key={item.key} scope="col">{item.label}</th>)}</tr></thead>
          <tbody>{rows.map(row => <tr key={row.t}><th scope="row">{formatTip(row.t)}</th>{series.map(item => <td key={item.key}>{row[item.key] === null || row[item.key] === undefined ? '—' : format(row[item.key] as number)}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </div>
  );
});

function HistoryTooltip({ active, payload, series, format, formatTip }: Omit<TooltipContentProps, 'label'> & { series: ChartSeries[]; format: (value: number) => string; formatTip: (t: number) => string }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload as ChartRow | undefined;
  if (!row) return null;
  return (
    <div className="min-w-[10.5rem] rounded-[10px] border border-[var(--polaris-line)] bg-[var(--polaris-card)] px-3 py-2.5 shadow-[var(--polaris-shadow-float)]">
      <p className="polaris-num text-[11.5px] text-[var(--polaris-ink-4)]">{formatTip(row.t)}</p>
      {series.map(item => (
        <p key={item.key} className="mt-1.5 flex items-center gap-2 text-[12px] text-[var(--polaris-ink-3)]">
          <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-[3px]" style={{ backgroundColor: item.color }} />
          <span className="max-w-[9rem] truncate">{item.label}</span>
          <span className="polaris-num ml-auto pl-3 text-[13px] font-semibold text-[var(--polaris-ink)]">{row[item.key] === null || row[item.key] === undefined ? '—' : format(row[item.key] as number)}</span>
        </p>
      ))}
    </div>
  );
}
