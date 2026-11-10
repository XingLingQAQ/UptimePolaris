import type { Tone } from '@/types/tone';

export function percentOf(used: number | null | undefined, total: number | null | undefined): number | null {
  if (used == null || total == null || !Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  return used / total * 100;
}

export function loadTone(value: number | null | undefined): Tone {
  if (value == null || !Number.isFinite(value)) return 'idle';
  return value >= 90 ? 'down' : value >= 75 ? 'warn' : 'up';
}
