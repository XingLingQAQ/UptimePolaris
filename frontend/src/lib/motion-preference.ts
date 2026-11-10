import { MotionGlobalConfig } from 'framer-motion';

export type MotionPreference = 'full' | 'system' | 'reduced';
export const MOTION_PREFERENCE_KEY = 'uptime-polaris.motion';
const subscribers = new Set<() => void>();
let preference: MotionPreference | undefined;
let system: MediaQueryList | undefined;

function readPreference(): MotionPreference {
  try {
    const value = window.localStorage.getItem(MOTION_PREFERENCE_KEY);
    if (value === 'system' || value === 'reduced') return value;
  } catch {}
  return 'full';
}

const systemPreference = () => system ??= window.matchMedia('(prefers-reduced-motion: reduce)');
export const getMotionPreference = () => preference ??= readPreference();
export const getServerMotionPreference = (): MotionPreference => 'full';
export const getReducedMotion = () => getMotionPreference() === 'reduced' || getMotionPreference() === 'system' && systemPreference().matches;
export const getServerReducedMotion = () => false;

export function initializeMotionPreference() {
  const reduced = getReducedMotion();
  document.documentElement.dataset.motion = reduced ? 'reduced' : 'full';
  // Mounted Motion elements cache their initial preference. / 已挂载的 Motion 元素缓存初始偏好。
  MotionGlobalConfig.skipAnimations = reduced;
}

function notify() {
  initializeMotionPreference();
  for (const subscriber of subscribers) subscriber();
}

function onSystemChange() {
  if (getMotionPreference() === 'system') notify();
}

function onStorage(event: StorageEvent) {
  if (event.key !== null && event.key !== MOTION_PREFERENCE_KEY) return;
  preference = readPreference();
  notify();
}

export function setMotionPreference(value: MotionPreference): boolean {
  preference = value;
  let saved = true;
  try { window.localStorage.setItem(MOTION_PREFERENCE_KEY, value); }
  catch { saved = false; }
  notify();
  return saved;
}

export function subscribeMotionPreference(subscriber: () => void) {
  if (subscribers.size === 0) {
    window.addEventListener('storage', onStorage);
    systemPreference().addEventListener('change', onSystemChange);
    initializeMotionPreference();
  }
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0) {
      window.removeEventListener('storage', onStorage);
      system?.removeEventListener('change', onSystemChange);
    }
  };
}

if (import.meta.hot) import.meta.hot.dispose(() => {
  window.removeEventListener('storage', onStorage);
  system?.removeEventListener('change', onSystemChange);
  subscribers.clear();
});
