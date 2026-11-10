
import { useLocale } from '@/i18n/IntlProvider';
import { useMemo } from 'react';
import { useReducedMotion } from '@/lib/useReducedMotion';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

/**
 * A single-series area chart over unix-second timestamps, sized for the
 * dashboard grid rather than for presentation. Wraps recharts because the
 * agents detail view draws four of these side by side, and recharts' resize
 * observer + axis tick logic is the part worth not re-implementing.
 *
 * Differences from MonitoringChart:
 *   - No range tabs. The bucketing comes pre-decided from the API (one row
 *     per minute); the only window is the one the caller passed.
 *   - No heartbeat-colour mapping. The y domain is caller-controlled (CPU is
 *     0..100, load is 0..maxSeen, network is 0..auto) and the stroke colour
 *     is a single tone for the whole series.
 *
 * 单序列面积图以 Unix 秒为时间轴，尺寸适合仪表板网格。Agent 详情并排绘制四张图，
 * 因此复用 Recharts 的尺寸观察和坐标刻度逻辑。与 MonitoringChart 不同：
 * 不显示范围标签，数据桶由 API 预定为每分钟一条，时间窗口由调用方提供；
 * 不按心跳映射颜色，y 轴范围由调用方控制（CPU 0–100、负载 0–maxSeen、
 * 网络 0–auto），整个序列使用同一描边色。
 */

interface TimeSeriesPoint {
  /** Unix seconds. / Unix 秒数。 */
  ts: number;
  value: number | null;
}

interface TimeSeriesChartProps {
  data: TimeSeriesPoint[];
  /** Series label, used in the ARIA description. / 序列标签，用于 ARIA 说明。 */
  label: string;
  /** Shape token understood by HeroUI's CSS vars. / HeroUI CSS 变量支持的样式标记。 */
  color?: 'success' | 'warning' | 'danger' | 'primary' | 'default';
  /** Plot height, px. / 绘图区高度，单位 px。 */
  height?: number;
  /** Lower end of the y domain. Defaults to 0. / y 轴下限，默认 0。 */
  yMin?: number;
  /**
   * Upper end. Pass a number to fix the ceiling (CPU at 100, for example),
   * or 'auto' to track the largest datum.
   *
   * y 轴上限：传数字固定上限（例如 CPU 为 100），或传 'auto' 跟随最大数据值。
   */
  yMax?: number | 'auto';
  /** Tick formatter for the y axis. Defaults to rounding. / y 轴刻度格式化函数，默认四舍五入。 */
  formatY?: (v: number) => string;
  /** Tooltip value formatter. / 提示框数值格式化函数。 */
  formatValue?: (v: number) => string;
}

function defaultTick(v: number): string {
  return v >= 100 ? String(Math.round(v)) : v.toFixed(v < 1 ? 1 : 0);
}

export function TimeSeriesChart({
  data,
  label,
  color = 'primary',
  height = 120,
  yMin = 0,
  yMax = 'auto',
  formatY = defaultTick,
  formatValue,
}: TimeSeriesChartProps) {
  const { locale } = useLocale();
  const reduced = useReducedMotion();
  const rows = useMemo(
    () =>
      (data ?? [])
        .filter((p) => Number.isFinite(p.ts) && (p.value === null || Number.isFinite(p.value)))
        .map((p) => ({ ts: p.ts * 1000, value: p.value })),
    [data],
  );

  const upper = useMemo(() => {
    if (yMax !== 'auto') return yMax;
    const m = rows.reduce((acc, r) => Math.max(acc, r.value ?? 0), 0);
    return m > 0 ? m * 1.1 : 1;
  }, [rows, yMax]);

  const gradientId = useMemo(
    () => `tsg-${color}-${Math.random().toString(36).slice(2, 8)}`,
    [color],
  );

  if (rows.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-tiny text-default-400"
        style={{ height }}
      >
        —
      </div>
    );
  }

  return (
    <div className="w-full" style={{ height }} aria-label={label} role="img">
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={rows} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="10%" stopColor={`hsl(var(--heroui-${color}-500))`} stopOpacity={0.4} />
              <stop offset="100%" stopColor={`hsl(var(--heroui-${color}-100))`} stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="hsl(var(--heroui-default-200))" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="ts"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(ms) =>
              new Date(ms as number).toLocaleTimeString(undefined, {
                hour: '2-digit',
                minute: '2-digit',
              })
            }
            axisLine={false}
            tickLine={false}
            minTickGap={48}
            interval="preserveStartEnd"
            style={{ fontSize: 'var(--heroui-font-size-tiny)' }}
          />
          <YAxis
            domain={[yMin, upper]}
            width={44}
            axisLine={false}
            tickLine={false}
            style={{ fontSize: 'var(--heroui-font-size-tiny)' }}
            tickFormatter={formatY}
          />
          <Tooltip
            formatter={(v) => [formatValue ? formatValue(Number(v)) : Number(v), label]}
            /* `locale`, not the default: the tooltip would otherwise use the
               browser's language while every axis label beside it used the
               console's.
               使用控制台的 `locale` 而非浏览器默认语言，避免提示框时间与坐标轴语言不同。 */
            labelFormatter={(ms) => new Date(ms as number).toLocaleTimeString(locale)}
            cursor={{ stroke: 'hsl(var(--heroui-default-300))', strokeWidth: 1 }}
            contentStyle={{
              background: 'hsl(var(--heroui-content1))',
              border: '1px solid hsl(var(--heroui-divider))',
              borderRadius: 'var(--heroui-radius-medium)',
              fontSize: 'var(--heroui-font-size-tiny)',
            }}
          />
          <Area
            type="monotone"
            dataKey="value"
              isAnimationActive={!reduced}
            stroke={`hsl(var(--heroui-${color}))`}
            strokeWidth={1.6}
            fill={`url(#${gradientId})`}
            dot={false}
            connectNulls={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
