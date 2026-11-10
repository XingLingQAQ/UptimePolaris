import clsx from 'clsx';
import { useLayoutEffect, useRef } from 'react';
import { startBrandRotation } from './brand-rotation';
import { useReducedMotion } from '@/lib/useReducedMotion';
import {
  BRAND_BLUE,
  BRAND_RING_PATH,
  RING,
  TIGHT_VIEWBOX,
} from '../../../../shared/brand-mark';

const LOGO_SIZE = 36;

export function BrandLoader({
  label,
  className,
}: {
  /** Announced text for assistive tech. Omit only where the surrounding
   * surface already says what is happening. / 向辅助技术播报的文字；仅当周围界面已说明状态时省略。 */
  label?: string;
  className?: string;
}) {
  const mark = useRef<HTMLSpanElement>(null);
  const reduced = useReducedMotion();
  useLayoutEffect(() => {
    if (!mark.current) return;
    return startBrandRotation(
      mark.current,
      reduced,
    );
  }, [reduced]);
  return (
    <span
      role="status"
      className={clsx(
        'inline-flex shrink-0 items-center justify-center',
        className,
      )}
      style={{ width: LOGO_SIZE, height: LOGO_SIZE }}
    >
      <span
        ref={mark}
        className="polaris-mark-spin"
        style={{ width: LOGO_SIZE, height: LOGO_SIZE }}
      >
        <svg
          viewBox={TIGHT_VIEWBOX}
          aria-hidden="true"
          focusable="false"
          width={LOGO_SIZE}
          height={LOGO_SIZE}
          style={{ display: 'block', width: LOGO_SIZE, height: LOGO_SIZE }}
        >
          <path
            d={BRAND_RING_PATH}
            fill="none"
            stroke={BRAND_BLUE}
            strokeWidth={RING.strokeWidth}
            strokeLinecap="round"
          />
        </svg>
      </span>
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}
