import { isRetryableApiError } from '@/api/errors';
import useSWR from 'swr';
import { accountAvatarApi } from './api';
import { useAuth } from './AuthContext';

export function useAccountAvatar() {
  const { session } = useAuth();
  const userId = session?.user?.id;
  return useSWR(userId ? ['account-avatar', userId] : null, () => accountAvatarApi.read(), {
    revalidateOnFocus: true,
    dedupingInterval: 5_000,
    keepPreviousData: false,
    errorRetryCount: 1,
    shouldRetryOnError: isRetryableApiError,
  });
}
