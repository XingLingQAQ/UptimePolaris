import { SelectItem } from '@heroui/react';
import { Select } from '@/components/ui/MotionOverlays';
import { useId, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'use-intl';
import { getMotionPreference, getServerMotionPreference, setMotionPreference, subscribeMotionPreference, type MotionPreference } from '@/lib/motion-preference';

const modes: MotionPreference[] = ['full', 'system', 'reduced'];

export function MotionPreferenceControl() {
  const t = useTranslations('admin.settings');
  const mode = useSyncExternalStore(subscribeMotionPreference, getMotionPreference, getServerMotionPreference);
  const [saved, setSaved] = useState(true);
  const id = useId();
  return <div className="grid grid-cols-1 items-start gap-x-6 gap-y-2 border-t border-[var(--polaris-line-soft)] pt-4 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
    <label htmlFor={id} className="pt-2 text-small font-medium">{t('motionLabel')}</label>
    <div className="flex min-w-0 flex-col gap-2">
      <Select id={id} aria-label={t('motionLabel')} aria-describedby={`${id}-hint`} size="sm" variant="bordered" selectedKeys={[mode]} disallowEmptySelection onSelectionChange={keys => {
        const value = [...keys][0];
        if (modes.includes(value as MotionPreference)) setSaved(setMotionPreference(value as MotionPreference));
      }}>
        {modes.map(value => <SelectItem key={value}>{t(`motion${value[0].toUpperCase()}${value.slice(1)}`)}</SelectItem>)}
      </Select>
      <p id={`${id}-hint`} className="text-small leading-6 text-default-500">{t('motionHint')}</p>
      {!saved ? <p role="status" className="text-small text-warning-700">{t('motionSessionOnly')}</p> : null}
    </div>
  </div>;
}
