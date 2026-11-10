import { MotionDisclosure } from '@/components/ui/MotionDisclosure';
import { useEffect, useState } from 'react';
import { Button, Input, Skeleton, Switch } from '@heroui/react';
import {
  CloudDownload,
  Globe,
  Monitor,
  Plus,
  Server,
  Trash2,
} from 'lucide-react';
import { useTranslations } from 'use-intl';
import { useApiErrorMessage } from '@/api/useApiErrorMessage';
import { requestJson } from '@/api/client';
import {
  normalizeDomain,
  type DomainPage,
  type PageKind,
} from '../../../../shared/presentation';
import { AutoSaveStatus, useAutoSave } from '../useAutoSave';
import { usePresentation, updatePresentation } from './presentation-api';

type DomainDraft = DomainPage & { emptyDraft?: boolean };

export function PresentationPanel() {
  const t = useTranslations('admin.presentation'),
    message = useApiErrorMessage();
  const data = usePresentation();
  const [enabled, setEnabled] = useState<boolean | null>(null),
    [domains, setDomains] = useState<DomainDraft[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]),
    [domainStatus, setDomainStatus] = useState(''),
    [reading, setReading] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const save = useAutoSave<
    Partial<{ agentEnabled: boolean; domains: DomainPage[] }>
  >((patch) => updatePresentation((config) => ({ ...config, ...patch })));
  useEffect(() => {
    if (enabled === null && data.data) {
      setEnabled(data.data.config.agentEnabled);
      setDomains(data.data.config.domains);
    }
  }, [data.data, enabled]);
  if (data.error)
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-2 text-small text-danger"
      >
        <span>{message(data.error)}</span>
        <Button size="sm" variant="light" onPress={() => void data.mutate()}>
          {t('retry')}
        </Button>
      </div>
    );
  if (enabled === null) return <Skeleton className="h-24 rounded-lg" />;
  function changeDomains(next: DomainDraft[], showError = false) {
    setDomains(next);
    const seen = new Set<string>();
    const normalized: DomainPage[] = [];
    for (const row of next) {
      if (row.emptyDraft && !row.hostname) continue;
      const hostname = normalizeDomain(row.hostname);
      if (!hostname || seen.has(hostname)) {
        save.cancel('domains');
        if (showError) setInvalid(true);
        return;
      }
      seen.add(hostname);
      normalized.push({ hostname, page: row.page });
    }
    setInvalid(false);
    save.schedule({ domains: normalized });
  }
  async function readDomains() {
    setReading(true);
    try {
      const result = await requestJson<{
        available: boolean;
        domains: string[];
      }>('/api/admin/presentation/domains');
      setSuggestions(result.domains);
      setDomainStatus(
        t(result.available ? 'domainsLoaded' : 'domainsUnavailable'),
      );
    } catch {
      setDomainStatus(t('domainsUnavailable'));
    } finally {
      setReading(false);
    }
  }
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 items-start gap-x-6 gap-y-3 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
        <div>
          <p id="enable-agent-page-label" className="text-small font-medium">
            {t('enableAgents')}
          </p>
        </div>
        <div className="flex items-start gap-3">
          <Switch
            size="sm"
            aria-labelledby="enable-agent-page-label"
            aria-describedby="enable-agent-page-hint"
            isSelected={enabled}
            onValueChange={(value) => {
              setEnabled(value);
              save.schedule({ agentEnabled: value }, true);
            }}
          />
          <p
            id="enable-agent-page-hint"
            className="max-w-prose text-small leading-6 text-default-500"
          >
            {t('enableAgentsHint')}
          </p>
        </div>
      </div>
      <MotionDisclosure open={enabled} className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--polaris-line-soft)] pt-5">
          <p className="max-w-prose text-small leading-6 text-default-500">
            {t('domainsHint')}
          </p>
          <Button
            size="sm"
            variant="flat"
            startContent={<CloudDownload size={15} />}
            isLoading={reading}
            onPress={() => void readDomains()}
          >
            {t('loadDomains')}
          </Button>
        </div>
        {domainStatus && (
          <p role="status" className="text-small text-default-500">
            {domainStatus}
          </p>
        )}
        <datalist id="presentation-domains">
          {suggestions.map((domain) => (
            <option key={domain} value={domain} />
          ))}
        </datalist>
        {(['monitor', 'agent'] as PageKind[]).map((kind) => {
          const Icon = kind === 'monitor' ? Monitor : Server;
          return (
            <section
              key={kind}
              aria-label={t(kind)}
              className="flex flex-col gap-3"
            >
              <h3 className="flex items-center gap-2 text-small font-semibold">
                <Icon size={16} className="text-default-400" />
                {t(kind === 'monitor' ? 'monitorDomains' : 'agentDomains')}
              </h3>
              {domains.flatMap((row, index) =>
                row.page === kind
                  ? [
                      <div key={index} className="flex items-start gap-2">
                        <Input
                          size="sm"
                          variant="bordered"
                          aria-label={t('hostname')}
                          placeholder="status.example.com"
                          list="presentation-domains"
                          startContent={
                            <Globe size={15} className="text-default-400" />
                          }
                          value={row.hostname}
                          onValueChange={(hostname) =>
                            changeDomains(
                              domains.map((item, i) =>
                                i === index
                                  ? {
                                      ...item,
                                      hostname,
                                      emptyDraft: item.emptyDraft && !hostname,
                                    }
                                  : item,
                              ),
                            )
                          }
                          onBlur={() => {
                            changeDomains(domains, true);
                            void save.flush();
                          }}
                        />
                        <Button
                          isIconOnly
                          size="sm"
                          variant="light"
                          color="danger"
                          aria-label={t('remove')}
                          onPress={() =>
                            changeDomains(
                              domains.filter((_, i) => i !== index),
                              true,
                            )
                          }
                        >
                          <Trash2 size={15} />
                        </Button>
                      </div>,
                    ]
                  : [],
              )}
              <div>
                <Button
                  size="sm"
                  variant="light"
                  startContent={<Plus size={15} />}
                  onPress={() =>
                    setDomains([
                      ...domains,
                      { hostname: '', page: kind, emptyDraft: true },
                    ])
                  }
                >
                  {t('addDomain')}
                </Button>
              </div>
            </section>
          );
        })}
        {invalid && (
          <p role="alert" className="text-small text-danger">
            {t('invalidDomains')}
          </p>
        )}
      </MotionDisclosure>
      <AutoSaveStatus {...save} />
    </div>
  );
}
