import { useApiErrorMessage } from '@/api/useApiErrorMessage';
import { Button } from '@heroui/react';
import { Server, Settings2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslations } from 'use-intl';
import { AdminPage } from '../layout/AdminPage';
import { settingsApi } from '../settings/api';
import { useAgentManagement } from './useAgentManagement';

export function AgentManagementGate({ children }: { children: ReactNode }) {
  const t = useTranslations('admin.agents');
  const settings = useTranslations('admin.settings');
  const describe = useApiErrorMessage();
  const feature = useAgentManagement();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const enable = async () => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await settingsApi.updateSettings({ 'features.agentManagement': true });
      await feature.mutate();
    } catch (error) { setSaveError(error); }
    finally { setSaving(false); }
  };
  if (feature.enabled) return children;
  return <AdminPage title={t('title')} description={t('description')}>
    <section className="polaris-card mx-auto flex w-full max-w-xl flex-col items-center px-6 py-12 text-center">
      <Server size={24} className="mb-5 text-[var(--polaris-ink-3)]" aria-hidden="true" />
      <h2 className="text-[15px] font-semibold">{t('featureDisabled')}</h2>
      <p className="mt-2 max-w-md text-[13px] leading-relaxed text-[var(--polaris-ink-3)]">{settings('agentManagementHint')}</p>
      {feature.isLoading ? <p role="status" className="mt-5 text-small text-default-500">{t('loading')}</p>
        : feature.error ? <div role="alert" className="mt-5 text-small text-danger"><p>{describe(feature.error)}</p><Button size="sm" variant="light" onPress={() => void feature.mutate().catch(() => undefined)}>{t('refresh')}</Button></div>
        : <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Button color="primary" isLoading={saving} onPress={() => void enable()}>{t('enableFeature')}</Button>
          <Button as={Link} to="/admin/settings#settings-features" variant="bordered" startContent={<Settings2 size={15} />}>{t('openFeatureSettings')}</Button>
        </div>}
      {saveError ? <p role="alert" className="mt-3 text-small text-danger">{describe(saveError)}</p> : null}
    </section>
  </AdminPage>;
}
