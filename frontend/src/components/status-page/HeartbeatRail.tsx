import type { Heartbeat } from '@/types/monitor';
import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocale, useTranslations } from 'use-intl';
import { STATUS_DOT, STATUS_KEY, STATUS_RAIL, beatStatus } from './status';

/** A stable key per check, so a refresh mounts only the checks that are new. / 每次检查使用稳定的键，刷新时仅挂载新增检查。 */
function beatKey(beat: Heartbeat): string {
  return `${beat.time}|${beat.status}|${beat.ping ?? ''}`;
}

/**
 * The last checks as a row of segments, newest on the right.
 *
 * On first paint the segments grow in from left to right; after that only a
 * check that arrives with a refresh animates, so a page left open shows new
 * checks landing at the end of each row. Hovering reads one segment out in a
 * small card - drawn once per rail in a portal, not once per segment, so it is
 * never clipped by the list around it and costs nothing until it is used.
 *
 * Padded with empty segments when a monitor has fewer checks than the row
 * holds, so every row is the same width.
 *
 * 最近检查从左至右排列，最新检查在右侧；首次绘制时各段依次生长，之后只有刷新时
 * 新到的检查播放动效，长期打开页面时可看到它们出现在行尾。悬停时用小卡片展示该段；
 * 每条状态条只在 portal 中绘制一个提示卡，而非每段一个，避免被列表裁剪且不用时无开销。
 * 检查数量不足时用空段补齐，使各行等宽。
 */
export function HeartbeatRail({
  beats,
  max = 40,
  className,
  height = 'h-6',
}: {
  beats: Heartbeat[];
  max?: number;
  className?: string;
  height?: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const recent = beats.length > max ? beats.slice(beats.length - max) : beats;
  const pad = Math.max(0, max - recent.length);
  const firstPaint = useRef(true);
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);

  useEffect(() => {
    firstPaint.current = false;
  }, []);

  const onMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const slot = Math.floor(((event.clientX - rect.left) / rect.width) * max);
    const index = Math.min(max - 1, Math.max(0, slot)) - pad;
    if (index < 0 || index >= recent.length) {
      setHover(null);
      return;
    }
    const left = rect.left + ((index + pad + 0.5) / max) * rect.width;
    setHover({ index, x: left, y: rect.top });
  };

  const hovered = hover ? recent[hover.index] : undefined;
  const hoveredStatus = hovered ? beatStatus(hovered) : null;
  const when = hovered ? new Date(hovered.time) : null;

  return (
    <div
      ref={box}
      onPointerMove={onMove}
      onPointerLeave={() => setHover(null)}
      className={clsx('flex items-stretch gap-[2px]', height, className)}
      aria-hidden="true"
    >
      {Array.from({ length: pad }, (_, i) => (
        <span key={`pad-${i}`} className="min-w-[2px] flex-1 rounded-[2px] bg-[var(--polaris-rail-empty)]" />
      ))}
      {recent.map((beat, i) => (
        <span
          key={beatKey(beat)}
          style={firstPaint.current ? { animationDelay: `${(i + pad) * 12}ms` } : undefined}
          className={clsx(
            'polaris-grow min-w-[2px] flex-1 rounded-[2px] transition-[scale,opacity] duration-150',
            STATUS_RAIL[beatStatus(beat)],
            hover && hover.index !== i && 'opacity-60',
            hover?.index === i && 'scale-y-[1.18]',
          )}
        />
      ))}

      {hovered && hover && hoveredStatus && typeof document !== 'undefined'
        ? createPortal(
            <div
              role="tooltip"
              className="pointer-events-none fixed z-[80] -translate-x-1/2 -translate-y-full pb-2"
              style={{ left: hover.x, top: hover.y }}
            >
              <div className="polaris-pop min-w-[9.5rem] max-w-[16rem] rounded-[9px] bg-[#111113] px-2.5 py-2 text-[11.5px] text-zinc-200 shadow-[0_10px_24px_-8px_rgb(0_0_0/0.5)] ring-1 ring-white/10">
                <div className="flex items-center gap-1.5 font-medium text-white">
                  <span className={clsx('h-1.5 w-1.5 rounded-full', STATUS_DOT[hoveredStatus])} />
                  {t(STATUS_KEY[hoveredStatus])}
                  {hovered.ping !== null ? (
                    <span className="polaris-num ml-auto pl-3 text-zinc-300">{Math.round(hovered.ping)}ms</span>
                  ) : null}
                </div>
                <div className="polaris-num mt-1 text-zinc-400">
                  {when && Number.isFinite(when.getTime())
                    ? when.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'medium' })
                    : hovered.time}
                </div>
                {hovered.msg ? <div className="mt-1 break-words text-zinc-400">{hovered.msg}</div> : null}
              </div>
              <span className="absolute bottom-[3px] left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-[#111113]" />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
