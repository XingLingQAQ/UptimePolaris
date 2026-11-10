import { useCallback, useEffect, useState } from 'react';

const SEEN_KEY = 'uptime-polaris.console.seenEvent';
const MUTED_KEY = 'uptime-polaris.console.notificationsMutedUntil';
const CHANGE_EVENT = 'uptime-polaris:console-notifications';
const memory = new Map<string, number>();

function read(key: string): number {
  let value = memory.get(key) ?? 0;
  if (!memory.has(key)) {
    try { value = Number(window.localStorage.getItem(key) ?? 0); } catch {}
  }
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function write(key: string, value: number) {
  try { window.localStorage.setItem(key, String(value)); memory.delete(key); }
  catch { memory.set(key, value); }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function useConsoleNotifications() {
  const [state, setState] = useState(() => ({ seen: read(SEEN_KEY), mutedUntil: read(MUTED_KEY) }));
  useEffect(() => {
    const update = (event: Event) => {
      if (event.type === 'storage') {
        const key = (event as StorageEvent).key;
        if (key) memory.delete(key); else memory.clear();
      }
      setState({ seen: read(SEEN_KEY), mutedUntil: read(MUTED_KEY) });
    };
    window.addEventListener('storage', update);
    window.addEventListener(CHANGE_EVENT, update);
    return () => { window.removeEventListener('storage', update); window.removeEventListener(CHANGE_EVENT, update); };
  }, []);
  useEffect(() => {
    if (!state.mutedUntil) return;
    const remaining = state.mutedUntil - Date.now();
    if (remaining <= 0) { write(MUTED_KEY, 0); return; }
    const timer = window.setTimeout(() => write(MUTED_KEY, 0), Math.min(remaining + 20, 2147483647));
    return () => window.clearTimeout(timer);
  }, [state.mutedUntil]);

  const markSeen = useCallback((newest: number) => {
    if (Number.isSafeInteger(newest) && newest > read(SEEN_KEY)) write(SEEN_KEY, newest);
  }, []);
  const snooze = useCallback(() => write(MUTED_KEY, Date.now() + 15 * 60 * 1000), []);
  const resume = useCallback(() => write(MUTED_KEY, 0), []);
  return { ...state, muted: state.mutedUntil > Date.now(), markSeen, snooze, resume };
}
