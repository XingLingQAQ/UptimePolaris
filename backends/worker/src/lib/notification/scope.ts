/** Match scopes without loading storage or delivery modules. / 匹配范围时无需加载存储或投递模块。 */

import type { NotificationScope } from '../../types';


/** 空分组列表表示全部监控；限定分组时未分组事件不匹配。 / An empty group list matches all monitors; scoped groups do not match ungrouped events. */
export function scopeMatches(
  groupIds: NotificationScope,
  eventGroupId: string | null | undefined,
): boolean {
  if (groupIds.length === 0) return true;
  if (eventGroupId === null || eventGroupId === undefined) return false;
  return groupIds.includes(eventGroupId);
}
