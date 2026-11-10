/** SVG gauge for one percentage; avoids loading a chart library for a single value. / 单个百分比的 SVG 仪表，避免为一个数值加载图表库。 */

interface PercentGaugeProps {
  /** 0..100. Out-of-range values are clamped at render. / 范围为 0–100；渲染时限制超出范围的值。 */
  value: number;
  /** One line under the ring. / 圆环下的一行标签。 */
  label: string;
  /**
   * Primary reading under the value (e.g. "1.2 / 4 GB"). Optional - a bare
   * percentage is on its own line when unset.
   *
   * 数值下方的主要读数（例如“1.2 / 4 GB”），可选；未设置时单独显示百分比。
   */
  sub?: string;
  /** Warning threshold below danger; defaults to 70/90. / 警告阈值低于故障阈值；默认分别为 70/90。 */
  warn?: number;
  danger?: number;
  /** Ring diameter in px. Default 96. / 圆环直径，单位 px，默认 96。 */
  size?: number;
  /** Override the three-band palette when a single tone is preferable. / 需要单一色调时覆盖三级调色板。 */
  tone?: 'success' | 'warning' | 'danger';
}

/** Color channels for each tone, so the stroke and its faint track can share. / 各色调共用的颜色通道，供描边及其淡色轨道使用。 */
const TONE_VARS: Record<'success' | 'warning' | 'danger', { stroke: string; track: string }> = {
  success: { stroke: 'hsl(var(--heroui-success))', track: 'hsl(var(--heroui-success) / 0.15)' },
  warning: { stroke: 'hsl(var(--heroui-warning))', track: 'hsl(var(--heroui-warning) / 0.15)' },
  danger: { stroke: 'hsl(var(--heroui-danger))', track: 'hsl(var(--heroui-danger) / 0.15)' },
};

const TONE_TEXT: Record<'success' | 'warning' | 'danger', string> = {
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
};

/**
 * The ring is a full circle; `stroke-dasharray` controls its filled fraction.
 *
 * 仪表是完整圆环，使用 `stroke-dasharray` 控制填充比例。
 */
export function PercentGauge({
  value,
  label,
  sub,
  warn = 70,
  danger = 90,
  size = 96,
  tone,
}: PercentGaugeProps) {
  const v = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  const resolved: 'success' | 'warning' | 'danger' =
    tone ?? (v >= danger ? 'danger' : v >= warn ? 'warning' : 'success');

  const strokeWidth = Math.max(6, Math.round(size / 12));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  /**
   * Filled portion of the ring. Rather than clipping an arc, the whole
   * circle is drawn and the dash pattern shows (v/100) of it - the browser
   * paints the remainder as `transparent`, which is why the track below is
   * drawn first as a second full circle.
   *
   * 填充部分通过完整圆的虚线模式显示 (v/100)，而非裁剪弧线；浏览器将其余部分
   * 绘制为透明，因此先绘制第二个完整圆作为底轨。
   */
  const filled = (v / 100) * circumference;
  const color = TONE_VARS[resolved];

  return (
    /**
     * `min-w-0` so the gauge can be laid out in a grid narrower than its
     * sub-label. Without it the label "10.7 GB / 15.6 GB" sets a min-content
     * width the grid cannot shrink below, and three of them side by side
     * overflowed a 420px viewport - the third ring was clipped inside the
     * card's scroll container, which is invisible until someone scrolls.
     *
     * `min-w-0` 允许仪表放在比副标签更窄的网格中；否则“10.7 GB / 15.6 GB”
     * 形成不可收缩的最小内容宽度，三个并排时会超出 420px 视口，第三个圆环
     * 被卡片滚动容器裁掉，必须滚动后才能看到。
     */
    <div className="flex min-w-0 flex-col items-center gap-1.5">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`${label}: ${v.toFixed(0)}%`}
        className="shrink-0"
      >
        {/* Track / 底轨 */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color.track}
          strokeWidth={strokeWidth}
        />
        {/* Fill / 填充 */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color.stroke}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference}`}
          // Start at 12 o'clock: rotate -90° about the centre. / 从 12 点方向开始：绕中心旋转 -90°。
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dasharray 300ms ease' }}
        />
        <text
          x="50%"
          y="50%"
          dominantBaseline="central"
          textAnchor="middle"
          className={`fill-current font-mono font-semibold tabular-nums ${TONE_TEXT[resolved]}`}
          style={{ fontSize: Math.max(14, Math.round(size / 5)) }}
        >
          {v.toFixed(0)}%
        </text>
      </svg>
      <span className="w-full truncate text-center text-tiny text-default-500">{label}</span>
      {sub ? (
        <span className="w-full truncate text-center font-mono text-tiny tabular-nums text-default-400">
          {sub}
        </span>
      ) : null}
    </div>
  );
}
