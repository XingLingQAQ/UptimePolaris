import type { Transition } from 'framer-motion';

export const MOTION_EASE = [0.22, 1, 0.36, 1] as const;

export const NAV_TRANSITION = {
  type: 'spring',
  stiffness: 380,
  damping: 32,
  mass: 0.85,
} satisfies Transition;

export const PANEL_TRANSITION = {
  type: 'spring',
  stiffness: 300,
  damping: 32,
  mass: 1,
} satisfies Transition;

export const FEEDBACK_TRANSITION = { duration: 0.16, ease: MOTION_EASE } satisfies Transition;
export const EXIT_TRANSITION = { duration: 0.18, ease: [0.4, 0, 1, 1] } satisfies Transition;

export const CONTENT_TRANSITION = {
  duration: 0.36,
  ease: MOTION_EASE,
} satisfies Transition;
