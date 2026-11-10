import { Activity, BellRing, Folder, Palette, Server, Settings, type LucideIcon } from 'lucide-react';
import type { Hue } from '../../types/tone';

export interface NavEntry {
  href: string;
  icon: LucideIcon;
  labelKey: string;
  section: 'monitor' | 'configure';
  /** The tile tint this page wears in its header and in the palette. / 页面标题和命令面板中使用的图标色调。 */
  hue: Hue;
}

/**
 * The rail, in the order a console is read.
 *
 * Monitors first because it is where the readings are; agents next, being the
 * machines some of those readings come from; groups after them because they are
 * the vocabulary the monitors are filed under. Then the configuration half:
 * notifications (being told), themes (what visitors see), and Settings last as
 * the only entry that configures the deployment rather than its content.
 *
 * The two halves are labelled sections in the rail. Six flat links read as one
 * undifferentiated list; split by what they are for, the operator's daily
 * places sit together and the set-and-forget ones sit apart.
 *
 * No tags entry. A tag is a label carried by a monitor, and both halves of its
 * vocabulary - creating one, and renaming or removing it - live in the monitor
 * form, next to the monitor that wears it.
 *
 * 导航按阅读顺序分为监控和配置两组：先看监控读数，再看部分读数的来源 Agent，
 * 然后看归类监控项的分组；配置部分依次是通知、访客看到的主题和设置。
 * 设置是唯一配置部署本身而非内容的入口。两组分开可区分日常操作与不常改动的配置，
 * 避免六个入口混成平铺列表。标签随监控项管理，创建、重命名和删除均位于
 * 监控表单中，不单设入口。
 */
export const NAV: NavEntry[] = [
  { href: '/admin', icon: Activity, labelKey: 'nav.monitors', section: 'monitor', hue: 'primary' },
  {
    href: '/admin/agents',
    icon: Server,
    labelKey: 'nav.agents',
    section: 'monitor',
    hue: 'cyan',
  },
  { href: '/admin/groups', icon: Folder, labelKey: 'nav.groups', section: 'monitor', hue: 'indigo' },
  { href: '/admin/notifications', icon: BellRing, labelKey: 'nav.notifications', section: 'configure', hue: 'violet' },
  { href: '/admin/themes', icon: Palette, labelKey: 'nav.themes', section: 'configure', hue: 'pink' },
  { href: '/admin/settings', icon: Settings, labelKey: 'nav.settings', section: 'configure', hue: 'default' },
];

/**
 * The entry a path belongs to.
 *
 * `/admin` itself matches exactly - every console path starts with it - while
 * the rest match their subtree, so a theme's settings page at
 * `/admin/themes/:short` still marks Themes as the current place.
 *
 * `/admin` 仅精确匹配，其余入口匹配子路径，让主题设置页仍选中主题导航。
 */
export function navFor(pathname: string): NavEntry | undefined {
  return NAV.find((entry) => {
    return entry.href === '/admin'
      ? pathname === '/admin' || pathname === '/admin/'
      : pathname === entry.href || pathname.startsWith(`${entry.href}/`);
  });
}
