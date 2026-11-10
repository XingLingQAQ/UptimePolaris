export const BRAND_BLUE = '#006FEE';
/** 顺时针角度以十二点方向为零。 / Angles run clockwise from twelve o'clock. */
export const RING = {
  size: 32,
  center: 16,
  radius: 9.5,
  strokeWidth: 4,
  containerRadius: 8,
  arcStartAngle: 70,
  arcEndAngle: 20,
} as const;
export const INK_INSET = RING.center - RING.radius - RING.strokeWidth / 2;
export const INK_SIZE = RING.size - INK_INSET * 2;
export const TIGHT_PADDING = 0.5;
export const TIGHT_VIEWBOX = `${INK_INSET - TIGHT_PADDING} ${INK_INSET - TIGHT_PADDING} ${INK_SIZE + TIGHT_PADDING * 2} ${INK_SIZE + TIGHT_PADDING * 2}`;

function point(angle: number): [number, number] {
  const radians = ((angle - 90) * Math.PI) / 180;
  const round = (value: number) => Math.round(value * 100) / 100;
  return [round(RING.center + RING.radius * Math.cos(radians)), round(RING.center + RING.radius * Math.sin(radians))];
}

const [startX, startY] = point(RING.arcStartAngle);
const [endX, endY] = point(RING.arcEndAngle);
// 绘制缺口的补角。 / Draw the complement of the gap.
const sweep = 360 - ((RING.arcStartAngle - RING.arcEndAngle + 360) % 360);
export const BRAND_RING_PATH = `M${startX} ${startY}A${RING.radius} ${RING.radius} 0 ${sweep > 180 ? 1 : 0} 1 ${endX} ${endY}`;
