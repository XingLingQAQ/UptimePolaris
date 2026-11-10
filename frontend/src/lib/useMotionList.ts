import autoAnimate, { type AutoAnimationPlugin } from '@formkit/auto-animate';
import { useCallback, type RefCallback } from 'react';
import { useReducedMotion } from './useReducedMotion';

const easing = 'cubic-bezier(0.22, 1, 0.36, 1)';

const listAnimation: AutoAnimationPlugin = (element, action, from, to) => {
  let frames: Keyframe[];
  let duration = action === 'remove' ? 160 : 320;
  if (action === 'remain' && from && to) {
    // AutoAnimate passes old coordinates first. / AutoAnimate 先传旧坐标。
    frames = [{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)` }, { transform: 'translate(0, 0)' }];
    if (from.left === to.left && from.top === to.top) duration = 0;
  } else if (action === 'remove') {
    element.setAttribute('data-polaris-exiting', '');
    element.setAttribute('aria-hidden', 'true');
    if (element instanceof HTMLElement) element.inert = true;
    frames = [{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-4px)' }];
  } else {
    frames = [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'translateY(0)' }];
  }
  return new KeyframeEffect(element, frames, { duration, easing });
};

/** Structural changes only; never shares children with Motion layout. / 仅处理结构变更，不与 Motion 共管子元素布局。 */
export function useMotionList<T extends HTMLElement = HTMLDivElement>(): RefCallback<T> {
  const reduced = useReducedMotion();
  return useCallback((element: T | null) => {
    if (!element || reduced) return;
    const controller = autoAnimate(element, listAnimation);
    return () => {
      controller.destroy?.();
      element.querySelectorAll(':scope > [data-polaris-exiting]').forEach(child => child.remove());
    };
  }, [reduced]);
}
