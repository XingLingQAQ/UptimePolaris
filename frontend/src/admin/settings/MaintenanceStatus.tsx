import useSWR from 'swr';
import { useTranslations } from 'use-intl';
import { requestJson } from '@/api/client';
import type { PublicMaintenanceState } from '../../../../shared/maintenance';

export function MaintenanceStatus() {
  const t = useTranslations('admin.settings');
  const { data, error } = useSWR<PublicMaintenanceState>(
    '/api/public/maintenance',
    requestJson,
    { refreshInterval: 5000 },
  );
  return (
    <p
      role="status"
      className={
        data?.active
          ? 'text-small text-warning-700 dark:text-warning-400'
          : 'text-small text-default-500'
      }
    >
      {error
        ? t('maintenanceStatusFailed')
        : data
          ? t(
              data.source === 'manual'
                ? 'maintenanceManualActive'
                : data.source === 'scheduled'
                  ? 'maintenanceScheduledActive'
                  : 'maintenanceInactive',
            )
          : t('maintenanceStatusLoading')}
    </p>
  );
}
