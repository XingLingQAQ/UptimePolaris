import { Button } from '@heroui/react';
import { AlertCircle, ArrowRight, CircleCheck, CircleDashed, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { SetupRequirement, SetupRequirementKey } from '../../../shared/setup';
import { useAuth } from './AuthContext';

const REQUIREMENT_TEXT: Record<SetupRequirementKey, { label: string; hint: string }> = {
  database: { label: 'setup.checkDatabase', hint: 'setup.checkDatabaseHint' },
  adminToken: { label: 'setup.checkAdminToken', hint: 'setup.checkAdminTokenHint' },
  themes: { label: 'setup.checkThemes', hint: 'setup.checkThemesHint' },
  analytics: { label: 'setup.checkAnalytics', hint: 'setup.checkAnalyticsHint' },
};

export function DeploymentCheck({ requirements, ready, onNext }: { requirements: SetupRequirement[]; ready: boolean; onNext: () => void }) {
  const t = useTranslations('admin');
  const { refresh, sessionError } = useAuth();
  const [checking, setChecking] = useState(false);
  const inFlight = useRef(false);

  const check = useCallback(async (advance = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setChecking(true);
    try {
      const next = await refresh();
      if (advance && next?.setupRequirements?.every((item) => !item.required || item.ok)) onNext();
    } finally {
      inFlight.current = false;
      setChecking(false);
    }
  }, [refresh, onNext]);

  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState === 'visible') void check();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [check]);

  return (
    <div className="flex flex-col gap-4" aria-busy={checking}>
      <ul className="divide-y divide-[var(--polaris-line)] overflow-hidden rounded-xl border border-[var(--polaris-line)] bg-[var(--polaris-card)]">
        {requirements.map((item) => {
          const text = REQUIREMENT_TEXT[item.key];
          const Icon = item.ok ? CircleCheck : item.required ? AlertCircle : CircleDashed;
          const tone = item.ok ? 'text-success-600' : item.required ? 'text-danger-600' : 'text-[var(--polaris-ink-4)]';
          return (
            <li key={item.key} className="flex gap-3 px-3.5 py-3">
              <Icon size={16} className={`mt-0.5 shrink-0 ${tone}`} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[13px] font-medium">{t(text.label)}</span>
                  <span className={`shrink-0 text-[12px] ${tone}`}>
                    {t(item.ok ? 'setup.checkOk' : item.required ? 'setup.checkMissing' : 'setup.checkOptionalMissing')}
                  </span>
                </div>
                {item.ok ? null : <p className="mt-1 text-[12px] leading-relaxed text-[var(--polaris-ink-3)]">{t(text.hint)}</p>}
              </div>
            </li>
          );
        })}
      </ul>

      {sessionError ? (
        <p role="alert" className="text-[12px] leading-relaxed text-danger-600">{t('setup.checkFailed')}</p>
      ) : (
        <p role="status" className="text-[12px] leading-relaxed text-[var(--polaris-ink-3)]">
          {t(checking ? 'setup.checkChecking' : ready ? 'setup.checkReady' : 'setup.checkAfter')}
        </p>
      )}

      <div className="flex gap-2">
        <Button
          variant="bordered"
          className="h-10 flex-1 text-[13.5px]"
          isLoading={checking}
          startContent={checking ? null : <RefreshCw size={15} />}
          onPress={() => void check()}
        >
          {t('setup.checkRetry')}
        </Button>
        <Button
          color="primary"
          className="h-10 flex-1 text-[13.5px] font-medium"
          isDisabled={!ready || checking || sessionError}
          endContent={<ArrowRight size={16} />}
          onPress={() => void check(true)}
        >
          {t('setup.checkNext')}
        </Button>
      </div>
    </div>
  );
}
