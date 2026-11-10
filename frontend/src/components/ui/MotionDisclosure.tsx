import { AnimatePresence, motion, useIsPresent } from 'framer-motion';
import { useReducedMotion } from '@/lib/useReducedMotion';
import { type ReactNode } from 'react';
import { CONTENT_TRANSITION, FEEDBACK_TRANSITION } from '@/lib/motion';

export function MotionDisclosure({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  return <AnimatePresence initial={false}>
    {open ? <DisclosureBody className={className}>{children}</DisclosureBody> : null}
  </AnimatePresence>;
}

function DisclosureBody({ children, className }: { children: ReactNode; className?: string }) {
  const reduced = useReducedMotion();
  const present = useIsPresent();
  return <motion.div
    inert={!present}
    aria-hidden={!present || undefined}
    initial={{ height: reduced ? 'auto' : 0, opacity: 0 }}
    animate={{ height: 'auto', opacity: 1 }}
    exit={{ height: reduced ? 'auto' : 0, opacity: 0 }}
    transition={reduced ? FEEDBACK_TRANSITION : CONTENT_TRANSITION}
    className="overflow-clip"
  ><div className={className}>{children}</div></motion.div>;
}
