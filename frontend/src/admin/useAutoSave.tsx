import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import { AlertCircle, Check, Loader2 } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { useApiErrorMessage } from '@/api/useApiErrorMessage';
import { AnimatePresence, motion } from 'framer-motion';
import { useReducedMotion } from '@/lib/useReducedMotion';
import { FEEDBACK_TRANSITION } from '@/lib/motion';
import { MotionDisclosure } from '@/components/ui/MotionDisclosure';

export function useAutoSave<T extends object>(
  write: (patch: T) => Promise<unknown>,
) {
  const writer = useRef(write);
  writer.current = write;
  const pending = useRef<T | null>(null),
    failed = useRef<T | null>(null),
    running = useRef(false);
  const invalidated = useRef(new Set<keyof T>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    mounted = useRef(true);
  const [state, setState] = useState<
    'idle' | 'pending' | 'saving' | 'saved' | 'error'
  >('idle');
  const [error, setError] = useState<unknown>(null);
  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    if (running.current) return;
    running.current = true;
    try {
      while (pending.current) {
        const patch = pending.current;
        pending.current = null;
        invalidated.current.clear();
        if (mounted.current) {
          setState('saving');
          setError(null);
        }
        try {
          await writer.current(patch);
          failed.current = null;
          if (mounted.current) setState(pending.current ? 'pending' : invalidated.current.size ? 'idle' : 'saved');
        } catch (reason) {
          const remaining = Object.assign({}, patch, pending.current);
          for (const key of invalidated.current) delete remaining[key];
          failed.current = Object.keys(remaining).length ? remaining : null;
          pending.current = null;
          if (mounted.current) {
            setError(failed.current ? reason : null);
            setState(failed.current ? 'error' : 'idle');
          }
          break;
        }
      }
    } finally {
      running.current = false;
    }
  }, []);
  const schedule = useCallback(
    (patch: T, immediate = false) => {
      for (const key of Object.keys(patch) as Array<keyof T>) invalidated.current.delete(key);
      pending.current = { ...failed.current, ...pending.current, ...patch };
      failed.current = null;
      if (mounted.current) {
        setState('pending');
        setError(null);
      }
      clearTimeout(timer.current);
      if (immediate) void flush();
      else timer.current = setTimeout(() => void flush(), 600);
    },
    [flush],
  );
  const cancel = useCallback((key: keyof T) => {
    invalidated.current.add(key);
    for (const ref of [pending, failed]) {
      if (!ref.current) continue;
      const next = { ...ref.current };
      delete next[key];
      ref.current = Object.keys(next).length ? next : null;
    }
    if (!pending.current) clearTimeout(timer.current);
    if (mounted.current && !running.current && !pending.current && !failed.current) {
      setState('idle');
      setError(null);
    }
  }, []);
  const retry = useCallback(() => {
    if (failed.current) schedule(failed.current, true);
  }, [schedule]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void flush();
    };
  }, [flush]);
  return { state, error, schedule, flush, retry, cancel };
}
export function AutoSaveStatus({
  state,
  error,
  retry,
}: {
  state: 'idle' | 'pending' | 'saving' | 'saved' | 'error';
  error: unknown;
  retry: () => void;
}) {
  const t = useTranslations('admin.settings'),
    message = useApiErrorMessage();
  const reduced = useReducedMotion();
  return (
    <MotionDisclosure open={state !== 'idle'}>
      <AnimatePresence initial={false} mode="wait">
        <motion.div
          key={state}
          initial={{ opacity: 0, y: reduced ? 0 : 3 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={FEEDBACK_TRANSITION}
          role={state === 'error' ? 'alert' : 'status'}
          className="flex flex-wrap items-center gap-2 border-t border-[var(--polaris-line-soft)] pt-3 text-small"
        >
          {state === 'error' ? (
            <>
              <AlertCircle size={14} className="text-danger" />
              <span className="text-danger">{message(error)}</span>
              <Button size="sm" variant="light" color="danger" onPress={retry}>
                {t('retrySave')}
              </Button>
            </>
          ) : state === 'saving' ? (
            <>
              <Loader2 size={14} className="animate-spin text-default-400" />
              <span className="text-default-500">{t('saving')}</span>
            </>
          ) : state === 'saved' ? (
            <>
              <Check size={14} className="text-success" />
              <span className="text-success">{t('saved')}</span>
            </>
          ) : (
            <span className="text-default-500">{t('unsavedHint')}</span>
          )}
        </motion.div>
      </AnimatePresence>
    </MotionDisclosure>
  );
}
