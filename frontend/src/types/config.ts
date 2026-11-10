import type { Incident, MonitorGroup } from './monitor';

export interface Config extends UiConfig {
  htmlEndpoint: string;
  apiEndpoint: string;
}

export type PublicPageConfig = PageConfig;

export interface PublicConfig extends Omit<Config, 'htmlEndpoint' | 'apiEndpoint'> {}

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
  incidents?: Incident[];
  maintenanceList?: Maintenance[];
}

/**
 * 时间规划 / Time of day
 *
 */
export interface TimeObject {
  hours: number;
  minutes: number;
}

export interface TimeSlot {
  startDate: string;
  endDate: string;
}

/**
 * 维护计划 / Maintenance schedule
 *
 */
export interface Maintenance {
  id: number;
  title: string;
  description: string;
  strategy: 'manual' | 'single' | 'scheduled' | 'recurring-interval' | string;
  intervalDay: number; // Recurrence interval in days / 重复间隔天数
  active: boolean; // 是否展示 / Whether to display
  dateRange: string[]; // example: ["2025-04-22T13:00", "2025-04-22T13:59"] / 示例日期范围
  timeRange: TimeObject[]; // example: [{hours: 13, minutes: 0}, {hours: 13, minutes: 59}] / 示例时间范围
  weekdays: number[];
  daysOfMonth: number[];
  timeslotList: TimeSlot[]; // 和 dateRange 类似，但是多了 startDate & endDate / Like dateRange, with startDate and endDate
  cron: string; // example: "0 0 1 * *", unix-cron string format / 示例：Unix cron 字符串格式
  durationMinutes: number | null;
  timezone: string;
  timezoneOption: string;
  timezoneOffset: string; // example: "+08:00"，使用时区以此为准 (仅 Maintenance 中有效) / Example offset; used as the timezone for Maintenance only
  status: 'inactive' | 'under-maintenance' | 'scheduled' | 'ended' | 'unknown' | string;
}

/**
 * 预加载数据接口 / Preloaded data interface
 */
export interface PreloadData {
  config: {
    slug: string;
    title: string;
    description: string;
    icon: string;
    theme: string;
    published: boolean;
    // 是否显示节点标签 / Whether to display monitor tags
    showTags: boolean;
    // Custom CSS supplied by the public page configuration / 公开页面配置提供的自定义 CSS
    customCSS: string;
    // 页脚文本 / Footer text
    footerText: string;
    // 是否显示 Powered by 信息 / Whether to display the Powered by credit
    showPoweredBy: boolean;
    // 是否显示 Google Analytics / Whether to display Google Analytics
    googleAnalyticsId: string | null;
    // 是否显示证书过期信息 / Whether to display certificate expiry information
    showCertificateExpiry: boolean;
  };

  // 监控组 / Monitor groups
  publicGroupList: MonitorGroup[];

  // 维护计划列表 / Maintenance schedules
  maintenanceList: Maintenance[];

  // 维护信息列表 / Incident list
  incidents?: Incident[];
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
