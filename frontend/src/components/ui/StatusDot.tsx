import type { Tone } from '@/types/tone';
import clsx from 'clsx';

/**
 * Status ink and fills, shared by the console and the public page.
 *
 * The console and public monitor views need the same tones, so the shared
 * components import them from here without pulling console UI into the public bundle.
 *
 * HeroUI reverses its numbered scales in dark mode, so the same class lands on a
 * light step there; that is why the ink is one step darker than the fill.
 *
 * 控制台与公开监控视图需要相同色调，因此共享组件从此处导入，
 * 避免将控制台界面模块引入公开包。
 * HeroUI 在深色模式下反转数字色阶，同一类名会落在较浅色阶，故文字比填充深一级。
 */

export const TONE_TEXT: Record<Tone, string> = {
  up: 'text-success-700',
  warn: 'text-warning-700',
  down: 'text-danger-600',
  pending: 'text-orange-700 dark:text-orange-400',
  idle: 'text-default-500',
};

export const TONE_BG: Record<Tone, string> = {
  up: 'bg-success',
  warn: 'bg-warning',
  down: 'bg-danger',
  pending: 'bg-orange-500',
  idle: 'bg-default-300',
};

/**
 * A status light.
 *
 * A failing light sends one soft ring outward; everything else is still. Motion
 * is the one signal that tells "needs attention now" from "fine" in a long list,
 * so it is spent on nothing else.
 *
 * 故障状态灯向外扩散一个柔和光环，其余状态保持静止，以突出需要关注的项目。
 */
export function StatusDot({ tone, pulse = false, size = 8 }: { tone: Tone; pulse?: boolean; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className={clsx('inline-block shrink-0 rounded-full', TONE_BG[tone], pulse && tone === 'down' && 'polaris-halo')}
      style={{ width: size, height: size }}
    />
  );
}
