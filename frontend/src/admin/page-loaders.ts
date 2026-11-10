import { navFor } from './layout/nav';

export const ADMIN_PAGE_LOADERS = {
  monitors: () => import('./monitors/MonitorsPage').then((module) => ({ default: module.MonitorsPage })),
  agents: () => import('./agents/AgentsPage').then((module) => ({ default: module.AgentsPage })),
  groups: () => import('./groups/GroupsPage').then((module) => ({ default: module.GroupsPage })),
  notifications: () => import('./notifications/NotificationsPage').then((module) => ({ default: module.NotificationsPage })),
  themes: () => import('./themes/ThemesPage').then((module) => ({ default: module.ThemesPage })),
  settings: () => import('./settings/SettingsPage').then((module) => ({ default: module.SettingsPage })),
};

const PAGE_BY_HREF: Record<string, keyof typeof ADMIN_PAGE_LOADERS> = {
  '/admin': 'monitors',
  '/admin/agents': 'agents',
  '/admin/groups': 'groups',
  '/admin/notifications': 'notifications',
  '/admin/themes': 'themes',
  '/admin/settings': 'settings',
};

/** 按导航目标预加载页面代码；预加载失败不影响后续正常导航。 / Preload page code for the navigation target; failure does not block later navigation. */
export function prefetchAdminPage(pathname: string) {
  const href = navFor(pathname)?.href;
  const page = href ? PAGE_BY_HREF[href] : undefined;
  if (page) void ADMIN_PAGE_LOADERS[page]().catch(() => {});
}
