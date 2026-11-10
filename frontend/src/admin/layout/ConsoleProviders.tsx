import { HeroUIProvider } from '@heroui/react';
import type { ReactNode } from 'react';
import { AuthProvider } from '../../auth/AuthContext';

/** Lazy providers for account and console routes; anonymous status pages do not probe the session. / 账户和控制台路由的延迟加载 Provider；匿名状态页面不检查会话。 */
export function ConsoleProviders({ children }: { children: ReactNode }) {
  return (
    <HeroUIProvider reducedMotion="never" disableRipple>
      <AuthProvider>{children}</AuthProvider>
    </HeroUIProvider>
  );
}
