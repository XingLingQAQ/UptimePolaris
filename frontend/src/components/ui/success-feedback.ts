import type { ToastT, ExternalToast } from 'sonner';
import { toast as sonnerToast } from 'sonner';

type SuccessTitle = Parameters<typeof sonnerToast.success>[0];
type PauseReason = 'pointer' | 'focus';

export interface SuccessFeedback {
  id: string | number;
  title: SuccessTitle;
  options: ExternalToast;
}

const EMPTY: readonly SuccessFeedback[] = [];
let pending: readonly SuccessFeedback[] = EMPTY;
const subscribers = new Set<() => void>();
const paused = new Set<PauseReason>();
let timer: ReturnType<typeof setTimeout> | undefined;
let remaining = 5000;
let startedAt: number | null = null;
let sequence = 0;
let listening = false;
let stopListening: (() => void) | undefined;

function emit() {
  for (const subscriber of subscribers) subscriber();
}

function stopTimer() {
  if (startedAt !== null) remaining = Math.max(0, remaining - (performance.now() - startedAt));
  startedAt = null;
  clearTimeout(timer);
  timer = undefined;
}

function duration(feedback: SuccessFeedback): number {
  const value = feedback.options.duration ?? 5000;
  return value === Infinity ? Infinity : Number.isFinite(value) ? Math.max(1000, value) : 5000;
}

function startTimer(reset = false) {
  stopTimer();
  if (!pending.length) return;
  if (reset) remaining = duration(pending[0]);
  if (!subscribers.size || paused.size || document.hidden || remaining === Infinity) return;
  startedAt = performance.now();
  timer = setTimeout(() => dismissSuccessFeedback(pending[0]?.id, 'auto'), remaining);
}

function asToast(feedback: SuccessFeedback): ToastT {
  return { ...feedback.options, id: feedback.id, title: feedback.title, type: 'success' };
}

function flushToToasts() {
  const toasts = pending;
  stopTimer();
  paused.clear();
  pending = EMPTY;
  emit();
  for (const feedback of toasts) sonnerToast.success(feedback.title, feedback.options);
}

function listen() {
  if (listening) return;
  listening = true;
  const media = window.matchMedia('(min-width: 1024px)');
  const onMediaChange = (event: MediaQueryListEvent) => {
    if (!event.matches && pending.length) flushToToasts();
  };
  const onVisibilityChange = () => startTimer();
  media.addEventListener('change', onMediaChange);
  document.addEventListener('visibilitychange', onVisibilityChange);
  stopListening = () => {
    media.removeEventListener('change', onMediaChange);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    listening = false;
  };
}

export function usesSuccessIsland(): boolean {
  return typeof window !== 'undefined' &&
    (window.location.pathname === '/admin' || window.location.pathname.startsWith('/admin/')) &&
    window.matchMedia('(min-width: 1024px)').matches;
}

export function publishSuccessFeedback(title: SuccessTitle, options: ExternalToast = {}): string | number {
  listen();
  const id = options.id ?? `uptime-polaris-success-${++sequence}`;
  const feedback = { id, title, options: { ...options, id } };
  const existing = pending.findIndex(row => row.id === id);
  const wasEmpty = pending.length === 0;
  if (existing >= 0) pending = pending.map(row => row.id === id ? feedback : row);
  else pending = pending.length >= 20 ? [pending[0], ...pending.slice(-18), feedback] : [...pending, feedback];
  if (wasEmpty || existing === 0) startTimer(true);
  emit();
  return id;
}

export function dismissSuccessFeedback(id?: string | number, reason: 'manual' | 'auto' | 'programmatic' = 'programmatic') {
  const removed = pending.filter(row => id === undefined || row.id === id);
  if (!removed.length) return;
  const firstChanged = id === undefined || pending[0]?.id === id;
  if (firstChanged) { stopTimer(); paused.clear(); }
  pending = pending.filter(row => id !== undefined && row.id !== id);
  if (firstChanged) startTimer(true);
  emit();
  for (const feedback of removed) {
    if (reason === 'manual') feedback.options.onDismiss?.(asToast(feedback));
    if (reason === 'auto') feedback.options.onAutoClose?.(asToast(feedback));
  }
}

export function pauseSuccessFeedback(id: string | number, reason: PauseReason, value: boolean) {
  if (pending[0]?.id !== id) return;
  if (value) paused.add(reason); else paused.delete(reason);
  startTimer();
}

export function subscribeSuccessFeedback(listener: () => void) {
  subscribers.add(listener);
  startTimer();
  return () => {
    subscribers.delete(listener);
    if (!subscribers.size) {
      stopTimer();
      if (pending.length && !usesSuccessIsland()) flushToToasts();
    }
  };
}

export const getSuccessFeedback = () => pending;
export const getServerSuccessFeedback = () => EMPTY;

export function subscribeDesktopViewport(listener: () => void) {
  const media = window.matchMedia('(min-width: 1024px)');
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}

export const getDesktopViewport = () => window.matchMedia('(min-width: 1024px)').matches;
export const getServerDesktopViewport = () => false;

if (import.meta.hot) import.meta.hot.dispose(() => {
  stopTimer();
  stopListening?.();
  pending = EMPTY;
  subscribers.clear();
});
