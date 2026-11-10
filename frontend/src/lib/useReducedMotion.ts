import { useSyncExternalStore } from 'react';
import { getReducedMotion, getServerReducedMotion, subscribeMotionPreference } from './motion-preference';

export function useReducedMotion() {
  return useSyncExternalStore(subscribeMotionPreference, getReducedMotion, getServerReducedMotion);
}
