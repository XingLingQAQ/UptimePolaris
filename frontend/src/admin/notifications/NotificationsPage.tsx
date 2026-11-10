import { useTranslations } from 'use-intl';
import { AdminPage } from '../layout/AdminPage';
import { NotificationsPanel } from './NotificationsPanel';

/**
 * Notification channels, on their own page.
 *
 * Split out of Settings rather than living in a panel there. Two reasons, and the
 * second is the one that decided it:
 *
 *  1. Settings had become long enough that channels sat below the fold on a
 *     laptop, behind the operations and account panels - a poor position for a
 *     feature someone comes back to often.
 *  2. They are not settings. Operations and Account configure *this deployment*;
 *     a channel is content, with its own list, its own create/edit flow and its
 *     own per-row actions. Burying a CRUD list inside a configuration page meant
 *     the page had two different shapes on it: forms that are saved, and rows
 *     that are managed.
 *
 * The panel component is unchanged and reused verbatim, so this move did not
 * touch the notification behaviour itself.
 *
 * 通知渠道独立成页：设置页过长，在笔记本上渠道位于操作和账户面板下方，需要向下滚动；
 * 渠道有自己的列表、增删改和行操作，是内容，而操作与账户配置的是部署本身。
 * 将待保存的表单与待管理的列表混在设置页会形成两种页面结构。
 * 继续原样复用面板，不改变通知行为。
 */
export function NotificationsPage() {
  const t = useTranslations('admin');

  return (
    <AdminPage title={t('notify.title')} description={t('notify.desc')}>
      {/* No width of its own - `AdminPage` applies the console's single centred
          container to every page, so this one cannot drift out of line with the
          others the way it did when each page set its own cap.
          不单独设置宽度；`AdminPage` 为各页面提供统一的居中容器。 */}
      <div className="flex flex-col gap-6">
        {/*
          `header="toolbar"`: the page header above already states the title, so
          the panel shows only the Add button rather than repeating a title that is
          four lines up.

          An earlier attempt used `header="title"` here, which drew the title a
          second time - the page header said "Notifications" and the panel header
          said "Notifications" directly beneath it. Dropping only the *description*
          was not enough; the title was the duplicate that mattered.

          页面标题已给出名称，`header="toolbar"` 只显示添加按钮。此前使用
          `header="title"` 会让页面和面板连续两次显示“Notifications”；
          仅移除说明无法解决问题，重复的是标题。
        */}
        <NotificationsPanel header="toolbar" />
      </div>
    </AdminPage>
  );
}
