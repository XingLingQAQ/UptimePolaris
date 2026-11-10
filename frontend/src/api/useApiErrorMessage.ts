import { apiErrorMessageKey } from '@/api/errors';
import { useCallback } from 'react';
import { useTranslations } from 'use-intl';

export function useApiErrorMessage() {
  const t = useTranslations();
  return useCallback((error: unknown) => {
    const key = apiErrorMessageKey(error);
    return t(t.has(key) ? key : 'error.requestFailed');
  }, [t]);
}
