import useSWR from 'swr';
import { requestJson } from './client';
import type { BackendCapabilities } from '../../../shared/backend-capabilities';

export function useBackendCapabilities() {
  return useSWR('/api/capabilities', () => requestJson<BackendCapabilities>('/api/capabilities'), {
    revalidateOnFocus: false,
  });
}
