import clsx from 'clsx';
import { CountUp } from 'countup.js';
import { useReducedMotion } from '@/lib/useReducedMotion';
import { useId, useLayoutEffect, useRef } from 'react';

/**
 * Figures both surfaces draw: a counting number and a sparkline.
 *
 * These were console-only (`admin/kit.tsx`) on the theory that the public bundle
 * never reached that file. It did - the status page's rows and hero use both -
 * and the file's other contents (a HeroUI tooltip, console chrome) came along
 * with them. They live here now, importing nothing from the console.
 *
 * 数字计数和迷你趋势线由公开页与控制台共用；它们原位于 admin/kit.tsx，但公开状态页
 * 的行和概览也会调用，连带将 HeroUI 提示框与控制台界面打进公开包。现在放在此处，
 * 不再导入控制台模块。
 */

/**
 * A figure that counts to its new value, so a change reads as movement rather
 * than a silent swap. Disabled in reduced-motion mode.
 *
 * 数字变化时滚动至新值；选择减少动效时直接显示。
 */
export function AnimatedNumber({
  value,
  decimals = 0,
  suffix = '',
  prefix = '',
}: {
  value: number;
  decimals?: number;
  suffix?: string;
  prefix?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const previous = useRef(0);
  const initialText = useRef(prefix + value.toFixed(decimals) + suffix);
  const reduced = useReducedMotion();

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const text = prefix + value.toFixed(decimals) + suffix;
    if (reduced) {
      node.textContent = text;
      previous.current = value;
      return;
    }
    const counter = new CountUp(node, value, {
      startVal: previous.current,
      decimalPlaces: decimals,
      duration: 0.7,
      prefix,
      suffix,
      useGrouping: false,
    });
    if (!counter.error) void counter.start();
    else node.textContent = text;
    return () => {
      previous.current = counter.frameVal;
      if (!counter.paused) counter.pauseResume();
    };
  }, [value, decimals, suffix, prefix, reduced]);

  return (
    <span ref={ref} className="polaris-num" aria-label={prefix + value.toFixed(decimals) + suffix}>
      {initialText.current}
    </span>
  );
}

/**
 * A small line over time, for a table row or a figure.
 *
 * Plain SVG rather than a charting library: a monitor table draws one per row.
 * Nulls break the line instead of being drawn as zero - a gap in the data is not
 * a reading of nothing.
 *
 * 表格行或指标的迷你趋势线使用普通 SVG 而非图表库，因为监控表每行都要绘制一条。
 * null 表示数据缺口，断开线条而非画为零；缺失数据不等于读数为零。
 */
export function SparkLine({
  values,
  className,
  height = 28,
  area = true,
  min,
  max,
  label,
  animate = true,
}: {
  values: Array<number | null>;
  className?: string;
  height?: number;
  area?: boolean;
  min?: number;
  max?: number;
  label?: string;
  /** Draw the line in from the left on first paint. / 首次绘制时从左侧显示线条。 */
  animate?: boolean;
}) {
  const gradient = `polaris-spark-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (finite.length < 2) {
    return <div className={clsx('w-full', className)} style={{ height }} aria-hidden="true" />;
  }

  const lo = min ?? Math.min(...finite);
  const hi = max ?? Math.max(...finite);
  const span = hi - lo || 1;
  const step = values.length > 1 ? 100 / (values.length - 1) : 0;
  const pad = 2;
  const y = (v: number) => height - pad - ((Math.min(hi, Math.max(lo, v)) - lo) / span) * (height - pad * 2);

  const runs: Array<Array<[number, number]>> = [];
  let run: Array<[number, number]> = [];
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      if (run.length) runs.push(run);
      run = [];
      return;
    }
    run.push([index * step, y(value)]);
  });
  if (run.length) runs.push(run);

  const line = (points: Array<[number, number]>) =>
    points.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(2)},${py.toFixed(2)}`).join(' ');

  return (
    <svg
      viewBox={`0 0 100 ${height}`}
      preserveAspectRatio="none"
      className={clsx('block w-full overflow-visible', animate && 'polaris-reveal-x', className)}
      style={{ height }}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity={0.16} />
          <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
        </linearGradient>
      </defs>
      {area
        ? runs
            .filter((points) => points.length > 1)
            .map((points, i) => (
              <path
                key={`a${i}`}
                d={`${line(points)} L${points[points.length - 1][0].toFixed(2)},${height} L${points[0][0].toFixed(2)},${height} Z`}
                fill={`url(#${gradient})`}
              />
            ))
        : null}
      {runs.map((points, i) => (
        <path
          key={`l${i}`}
          d={line(points)}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.25}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}
