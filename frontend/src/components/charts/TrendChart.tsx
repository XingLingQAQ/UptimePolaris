import { useTheme } from 'next-themes';
import { useId } from 'react';
import { useReducedMotion } from '@/lib/useReducedMotion';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from 'recharts';

/**
 * The console's one time-series chart.
 *
 * Every trend in the console is a single series over time - latency over the
 * last checks, latency per day, availability per day - so this is one area chart
 * with the conventions fixed in one place: a 2px line in the accent, a ~20%
 * wash under it, a hairline horizontal grid, no y-axis line, and one tooltip
 * that leads with the value. Failure periods are drawn as faint red bands
 * behind the line rather than as a second series, which would need a second
 * axis to mean anything.
 *
 * Colours are passed as hex rather than CSS variables: recharts writes them as
 * SVG presentation attributes, and those do not resolve `var()` everywhere.
 *
 * 控制台的近期检查延迟、每日延迟和每日可用率均使用统一单序列面积图：2px 强调色线、
 * 约 20% 底色、细水平网格、无 y 轴线，并在提示框中先显示数值。故障时段以淡红背景带
 * 表示，而非需要第二坐标轴的第二序列。Recharts 将颜色写入 SVG 表现属性，部分环境
 * 不解析 `var()`，因此使用十六进制颜色。
 */

export interface TrendPoint {
  /** Epoch seconds. / Unix 秒数。 */
  t: number;
  value: number | null;
  /** A short line under the value in the tooltip, e.g. "2 of 9 failed". / 提示框数值下方的简短说明，例如“9 次中 2 次失败”。 */
  note?: string;
}

const LIGHT = { accent: '#3b82f6', danger: '#ef4444', card: '#ffffff' };
const DARK = { accent: '#60a5fa', danger: '#f87171', card: '#161618' };

export function TrendChart({
  data,
  label,
  format,
  formatX,
  formatTip,
  bands = [],
  height = 220,
  domain,
}: {
  data: TrendPoint[];
  /** What the series is - names the chart for assistive tech and keys the tooltip. / 序列名称，用于图表的无障碍名称和提示框。 */
  label: string;
  format: (value: number) => string;
  formatX: (t: number) => string;
  /** The tooltip's time line, when it needs more than the axis label. / 提示框需要比坐标轴更详细时间时使用的文本。 */
  formatTip?: (t: number) => string;
  bands?: Array<{ x1: number; x2: number }>;
  height?: number;
  domain?: [number | 'auto' | 'dataMin', number | 'auto' | 'dataMax'];
}) {
  const { resolvedTheme } = useTheme();
  const reduced = useReducedMotion();
  const palette = resolvedTheme === 'dark' ? DARK : LIGHT;
  const gradient = `polaris-trend-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  return (
    <div
      className="polaris-chart relative"
      style={{ height }}
      onPointerDownCapture={event => { event.currentTarget.dataset.pointerFocus = 'true'; }}
      onKeyDownCapture={event => { delete event.currentTarget.dataset.pointerFocus; }}
      onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) delete event.currentTarget.dataset.pointerFocus;
      }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }} aria-label={label}>
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={palette.accent} stopOpacity={0.18} />
              <stop offset="100%" stopColor={palette.accent} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} />
          {bands.map((band) => (
            <ReferenceArea
              key={`${band.x1}-${band.x2}`}
              x1={band.x1}
              x2={band.x2}
              fill={palette.danger}
              fillOpacity={0.07}
              strokeOpacity={0}
              ifOverflow="hidden"
            />
          ))}
          <XAxis
            dataKey="t"
            type="number"
            domain={['dataMin', 'dataMax']}
            tickFormatter={formatX}
            tickLine={false}
            axisLine={false}
            minTickGap={48}
            tickMargin={8}
          />
          <YAxis
            width={52}
            tickFormatter={format}
            tickLine={false}
            axisLine={false}
            tickCount={4}
            domain={domain ?? [0, 'auto']}
            allowDataOverflow={Boolean(domain)}
          />
          <Tooltip
            isAnimationActive={false}
            cursor={{ stroke: 'currentColor', strokeOpacity: 0.16, strokeWidth: 1, strokeDasharray: '3 3' }}
            content={(props: TooltipContentProps) => (
              <TrendTooltip {...props} label={label} format={format} formatX={formatTip ?? formatX} />
            )}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke={palette.accent}
            strokeWidth={1.75}
            fill={`url(#${gradient})`}
            connectNulls={false}
            dot={false}
            activeDot={{ r: 3.5, strokeWidth: 2, stroke: palette.card, fill: palette.accent }}
            animationDuration={650}
            isAnimationActive={!reduced}
            animationEasing="ease-out"
          />
        </AreaChart>
      </ResponsiveContainer>

      {/*
        The table twin: every plotted value, readable without the pointer.

        `sr-only` goes on a wrapping div, not on the table. A table box ignores
        `overflow` and treats its height as a minimum, so a hidden 100-row table
        still stretched the document by its full height.

        为无法使用指针的用户提供数据表；`sr-only` 应放在外层 div，
        避免表格忽略 overflow 并仍按完整高度撑开页面。
      */}
      <div className="sr-only">
        <table>
          <caption>{label}</caption>
          <tbody>
            {data.map((point) => (
              <tr key={point.t}>
                <th scope="row">{(formatTip ?? formatX)(point.t)}</th>
                <td>{point.value === null ? '—' : format(point.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TrendTooltip({
  active,
  payload,
  label,
  format,
  formatX,
}: Omit<TooltipContentProps, 'label'> & {
  label: string;
  format: (value: number) => string;
  formatX: (t: number) => string;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload as TrendPoint | undefined;
  if (!point) return null;

  return (
    <div className="min-w-[9.5rem] rounded-[10px] border border-[var(--polaris-line)] bg-[var(--polaris-card)] px-3 py-2.5 shadow-[var(--polaris-shadow-float)]">
      <p className="polaris-num text-[11.5px] text-[var(--polaris-ink-4)]">{formatX(point.t)}</p>
      <p className="mt-1.5 flex items-center gap-2 text-[12px] text-[var(--polaris-ink-3)]">
        <span aria-hidden="true" className="h-2 w-2 rounded-[3px] bg-[var(--polaris-chart)]" />
        {label}
        <span className="polaris-num ml-auto pl-3 text-[13px] font-semibold text-[var(--polaris-ink)]">
          {point.value === null ? '—' : format(point.value)}
        </span>
      </p>
      {point.note ? <p className="mt-1.5 text-[11.5px] text-danger-600">{point.note}</p> : null}
    </div>
  );
}
