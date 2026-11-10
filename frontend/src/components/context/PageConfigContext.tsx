
import type { PublicConfig } from '@/types/config';
import type { ReactNode } from 'react';
import { createContext, useContext } from 'react';

const PageConfigContext = createContext<PublicConfig | null>(null);
const PageConfigRequestContext = createContext<string | null>(null);

interface PageConfigProviderProps {
  initialConfig: PublicConfig;
  configKey: string;
  children: ReactNode;
}

export function PageConfigProvider({ initialConfig, configKey, children }: PageConfigProviderProps) {
  return (
    <PageConfigRequestContext.Provider value={configKey}>
      <PageConfigContext.Provider value={initialConfig}>{children}</PageConfigContext.Provider>
    </PageConfigRequestContext.Provider>
  );
}

export function usePageConfigKey(): string {
  const key = useContext(PageConfigRequestContext);
  if (!key) throw new Error('usePageConfigKey must be used within a PageConfigProvider');
  return key;
}

export function usePageConfig(): PublicConfig {
  const config = useContext(PageConfigContext);

  if (!config) {
    throw new Error('usePageConfig must be used within a PageConfigProvider');
  }

  return config;
}
