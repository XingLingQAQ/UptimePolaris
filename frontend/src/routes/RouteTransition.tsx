import { CONTENT_TRANSITION, FEEDBACK_TRANSITION } from '@/lib/motion';
import { AnimatePresence, motion, useIsPresent } from 'framer-motion';
import { useReducedMotion } from '@/lib/useReducedMotion';
import { useLayoutEffect, useRef, type ReactNode } from 'react';

export function RouteTransition({ routeKey, children }: { routeKey: string; children: ReactNode }) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <RouteSurface key={routeKey}>{children}</RouteSurface>
    </AnimatePresence>
  );
}

function RouteSurface({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const present = useIsPresent();
  const reduced = useReducedMotion();

  useLayoutEffect(() => {
    ref.current?.closest('[data-console-scroll]')?.scrollTo({ top: 0, behavior: 'instant' });
    if (window.matchMedia('(max-width: 1023px)').matches) {
      window.scrollTo({ top: 0, behavior: 'instant' });
    }
  }, []);

  return (
    <motion.div
      ref={ref}
      inert={!present}
      aria-hidden={present ? undefined : true}
      className="polaris-route-surface relative flex min-h-0 flex-1 flex-col"
      initial={{ opacity: 0, transform: reduced ? 'none' : 'translateY(8px)' }}
      animate={{ opacity: 1, transform: 'none', transition: CONTENT_TRANSITION }}
      exit={{ opacity: 0, transition: FEEDBACK_TRANSITION }}
    >
      {children}
    </motion.div>
  );
}
