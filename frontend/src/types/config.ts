export interface PublicConfig extends UiConfig {}

export interface SiteConfig {
  slug: string;
  title: string;
  description: string;
  icon: string;
  theme: 'light' | 'dark' | 'system';
  published: boolean;
  showTags: boolean;
  customCSS: string;
  footerText: string;
  showPoweredBy: boolean;
  googleAnalyticsId: string | null;
  showCertificateExpiry: boolean;
}

export interface GlobalConfig {
  config: SiteConfig;
}

export interface PageConfig {
  id: string;
  siteMeta: {
    title: string;
    description: string;
    icon: string;
    iconCandidates: string[];
  };
}

export interface UiConfig {
  pageId: string;
  pageIds: string[];
  defaultPageId: string;
  pages: PageConfig[];
  siteMeta: PageConfig['siteMeta'];
  isPlaceholder: boolean;
  isEditThisPage: boolean;
  isShowStarButton: boolean;
}
