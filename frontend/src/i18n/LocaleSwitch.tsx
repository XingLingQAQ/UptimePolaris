
import { toastError } from '@/components/ui/ToastHost';
import { type Locale, locales } from '@/i18n/config';
import { useLocale } from '@/i18n/IntlProvider';
import {
  FlagBr,
  FlagCn,
  FlagFr,
  FlagHk,
  FlagJp,
  FlagKr,
  FlagRu,
  FlagTw,
  FlagUs,
} from '@sankyu/react-circle-flags';
import { Languages, Loader2 } from 'lucide-react';
import { useTransition } from 'react';
import { useTranslations } from 'use-intl';
import { MenuButton } from '../components/status-page/StatusMenu';

const flagComponents: Record<string, React.ComponentType<{ width?: number; height?: number }>> = {
  BR: FlagBr,
  CN: FlagCn,
  TW: FlagTw,
  HK: FlagHk,
  US: FlagUs,
  JP: FlagJp,
  KR: FlagKr,
  RU: FlagRu,
  FR: FlagFr,
};

/** Shared language menu; load the selected catalog before committing the change. / 共享语言菜单；切换前先加载所选语言包。 */
export const LocaleSwitch = () => {
  const [isPending, startTransition] = useTransition();
  const { locale: currentLocale, setLocale } = useLocale();
  const t = useTranslations();

  const handleLocaleChange = (locale: Locale) => {
    startTransition(async () => {
      try {
        await setLocale(locale);
      } catch (error) {
        console.error('Failed to change locale:', error);
        await toastError(t('locale.changeError'));
      }
    });
  };

  const trigger = (
    <span className="inline-flex h-8 w-8 items-center justify-center">
      {isPending ? (
        <Loader2 size={22} className="animate-spin [animation-duration:0.3s]" />
      ) : (
        <Languages size={22} />
      )}
    </span>
  );

  return (
    <MenuButton
      label={t('locale.switch')}
      trigger={trigger}
      items={locales.map((item) => {
        const FlagComponent = flagComponents[item.alpha2Code];
        return {
          key: item.key,
          label: item.name,
          selected: item.key === currentLocale,
          icon: FlagComponent ? <FlagComponent width={20} height={20} /> : undefined,
          onSelect: () => handleLocaleChange(item.key),
        };
      })}
    />
  );
};
