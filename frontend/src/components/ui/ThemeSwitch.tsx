
import { MOTION_EASE } from '@/lib/motion';
import { selectTheme } from '@/lib/browser-preferences';
import { AnimatePresence, motion } from 'framer-motion';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { MenuButton } from '../status-page/StatusMenu';

/**
 * The theme picker, shared by the public header and the console's.
 *
 * Hand-rolled rather than HeroUI's `Dropdown`: this switch sits in the public
 * page's header, and importing HeroUI here is what pulled the whole design
 * system into every anonymous visitor's first load. The menu primitive is in
 * `../status-page/StatusMenu.tsx`.
 *
 * 公开页与控制台页头共用主题选择器。它手写菜单而非使用 HeroUI Dropdown，
 * 因为在公开页头导入 HeroUI 会让每个匿名访客首次加载整个设计系统；
 * 菜单基础组件位于 `../status-page/StatusMenu.tsx`。
 */

const mode = {
  light: {
    icon: <Sun size={22} />,
    text: 'mode.light',
  },
  dark: {
    icon: <Moon size={22} />,
    text: 'mode.dark',
  },
  system: {
    icon: <Monitor size={22} />,
    text: 'mode.system',
  },
};

export const ThemeSwitch = ({
  radius,
}: {
  radius?: 'none' | 'full' | 'sm' | 'md' | 'lg' | undefined;
}) => {
  const t = useTranslations();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const currentTheme = (theme as keyof typeof mode) || 'system';
  const themeIcon = mode[currentTheme]?.icon || mode.system.icon;

  // The trigger keeps its 32px box while the choice is still unknown, so the
  // header does not resize between the server-styled paint and the first effect.
  // 主题尚未确定时保留 32px 触发器，避免首次 effect 执行前后页头尺寸变化。
  const trigger = (
    <span className="inline-flex h-8 w-8 items-center justify-center" data-radius={radius}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={mounted ? currentTheme : 'pending'}
          initial={{ rotate: -25, scale: 0.85, opacity: 0 }}
          animate={{ rotate: 0, scale: 1, opacity: 1, transition: { duration: 0.24, ease: MOTION_EASE } }}
          exit={{ rotate: 25, scale: 0.85, opacity: 0, transition: { duration: 0.1, ease: MOTION_EASE } }}
          className="inline-flex"
        >
          {themeIcon}
        </motion.span>
      </AnimatePresence>
    </span>
  );

  return (
    <MenuButton
      label={t('mode.switch')}
      trigger={trigger}
      items={Object.entries(mode).map(([key, value]) => ({
        key,
        label: t(value.text),
        icon: value.icon,
        selected: key === currentTheme,
        onSelect: () => selectTheme(key, setTheme),
      }))}
    />
  );
};
