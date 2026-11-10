export type PageKind = 'monitor' | 'agent';
export const PAGE_KINDS: PageKind[] = ['monitor', 'agent'];
export interface DomainPage {
  hostname: string;
  page: PageKind;
}
export interface PageTheme {
  short: string;
  version: string;
  theme: string;
}
export interface PageSettings {
  theme: PageTheme | null;
  themeOptions: Record<string, unknown>;
  headCode?: string;
  contentHtml?: string;
}

export const HEAD_CODE_MAX_BYTES = 16 * 1024;
export const CONTENT_HTML_MAX_BYTES = 32 * 1024;
export const utf8Length = (value: string) => new TextEncoder().encode(value).length;
export interface PresentationConfig {
  agentEnabled: boolean;
  workerService: string;
  domains: DomainPage[];
  pages: Record<PageKind, PageSettings>;
}
export interface PresentationState {
  config: PresentationConfig;
  revision: string;
}

// 内置页面的显示默认值，不属于可编辑设置。 / Built-in display defaults, not editable settings.
export const DEFAULT_PAGE_VIEW = {
  title: '',
  description: '',
  logo: '',
  locale: 'auto',
  colorMode: 'system' as const,
  layout: 'list' as 'cards' | 'list',
  density: 'normal',
  columns: 3,
  width: 1440,
  accent: '#6366F1',
  footer: '',
  showHistory: true,
  showLatency: true,
  showAvailability: true,
  showExpiry: true,
  showCountry: true,
  showOs: true,
  metrics: ['cpu', 'memory', 'disk', 'load', 'network', 'traffic', 'uptime'],
  historyHours: 24,
};
export type PageView = typeof DEFAULT_PAGE_VIEW;
export function defaultPresentation(): PresentationConfig {
  return {
    agentEnabled: false,
    workerService: 'uptime-polaris',
    domains: [],
    pages: {
      monitor: { theme: null, themeOptions: {} },
      agent: { theme: null, themeOptions: {} },
    },
  };
}
/** 接受不带端口或路径的主机名，并统一大小写、尾点和国际化域名。 / Accept hostnames without ports or paths; normalize case, trailing dots, and IDNs. */
export function normalizeDomain(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 253 ||
    /[\s/:@?#\\]/.test(value.trim())
  )
    return null;
  try {
    const host = new URL(
      'https://' + value.trim().replace(/\.$/, ''),
    ).hostname.toLowerCase();
    return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) &&
      !host.includes('..')
      ? host
      : null;
  } catch {
    return null;
  }
}
export function parsePresentation(value: unknown): PresentationConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const config = value as PresentationConfig;
  if (
    Object.keys(config).some(
      (key) =>
        !['agentEnabled', 'workerService', 'domains', 'pages'].includes(key),
    )
  )
    return null;
  if (
    typeof config.agentEnabled !== 'boolean' ||
    typeof config.workerService !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(config.workerService) ||
    !Array.isArray(config.domains) ||
    config.domains.length > 100
  )
    return null;
  const domains: DomainPage[] = [],
    seen = new Set<string>();
  for (const entry of config.domains) {
    const hostname = normalizeDomain(entry?.hostname);
    if (
      !hostname ||
      seen.has(hostname) ||
      !PAGE_KINDS.includes(entry.page) ||
      Object.keys(entry).some((key) => !['hostname', 'page'].includes(key))
    )
      return null;
    seen.add(hostname);
    domains.push({ hostname, page: entry.page });
  }
  if (
    !config.pages ||
    typeof config.pages !== 'object' ||
    Object.keys(config.pages).some(
      (key) => !PAGE_KINDS.includes(key as PageKind),
    )
  )
    return null;
  const pages = {} as Record<PageKind, PageSettings>;
  for (const kind of PAGE_KINDS) {
    const page = config.pages[kind];
    if (
      !page ||
      typeof page !== 'object' ||
      Array.isArray(page) ||
      Object.keys(page).some((key) => !['theme', 'themeOptions', 'headCode', 'contentHtml'].includes(key))
    )
      return null;
    if (
      page.theme !== null &&
      (!page.theme ||
        typeof page.theme !== 'object' ||
        Object.keys(page.theme).some(
          (key) => !['short', 'version', 'theme'].includes(key),
        ) ||
        !['short', 'version', 'theme'].every(
          (key) =>
            typeof (page.theme as unknown as Record<string, unknown>)[key] ===
            'string',
        ) ||
        !/^[a-z0-9][a-z0-9-]{0,62}$/.test(page.theme.short) ||
        !/^[a-z0-9][a-z0-9-]{0,62}$/.test(page.theme.theme) ||
        !page.theme.version ||
        page.theme.version.length > 160)
    )
      return null;
    // 注入内容按 UTF-8 字节计限，且只允许用于已选主题的页面。
    // Limit injected content by UTF-8 bytes and allow it only on pages with a selected theme.
    for (const [value, limit] of [[page.headCode, HEAD_CODE_MAX_BYTES], [page.contentHtml, CONTENT_HTML_MAX_BYTES]] as const) {
      if (value !== undefined && (typeof value !== 'string' || utf8Length(value) > limit || (!page.theme && value !== ''))) return null;
    }
    if (
      !page.themeOptions ||
      typeof page.themeOptions !== 'object' ||
      Array.isArray(page.themeOptions) ||
      JSON.stringify(page.themeOptions).length > 32000
    )
      return null;
    pages[kind] = structuredClone(page);
  }
  return {
    agentEnabled: config.agentEnabled,
    workerService: config.workerService,
    domains,
    pages,
  };
}
