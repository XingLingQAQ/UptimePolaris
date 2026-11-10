import { useTranslations } from 'use-intl';
import { AdminPage } from '../layout/AdminPage';
import { GroupsPanel } from './GroupsPanel';

/**
 * Monitor groups, on their own page.
 *
 * Split out of the monitor list rather than living in a drawer there, for the
 * reason the notifications page records: a group is *content* - it has a name, a
 * sort position and its own create/edit/delete flow - while the monitor list is
 * a working surface of live readings. Hanging a vocabulary editor off it would
 * put two different shapes on one page, and the group list is short enough that
 * it does not earn a corner of the fleet table.
 *
 * The page owns the title and description, the panel owns the list and the Add
 * button. That division is deliberate and was arrived at by fixing a bug: see
 * `NotificationsPanel`'s note on `header="toolbar"` - with the Add button in the
 * page header it sat among the application's own controls (the theme switch, the
 * language switch, the account menu) rather than beside the list it acts on.
 *
 * 监控分组有名称、排序和独立的增删改流程，是内容；实时监控列表则是查看读数的工作界面。
 * 将分组编辑器挂在列表旁会混合两种不同的页面结构，而分组列表也不够长，不值得占用
 * 监控表格的一角，因此单独成页。页面负责标题与说明，面板负责列表与添加按钮；
 * 否则添加按钮会混入主题、语言和账户等应用级控件，而不是位于操作对象旁。
 * 详见 `NotificationsPanel` 中对 `header="toolbar"` 的说明。
 */
export function GroupsPage() {
  const t = useTranslations('admin');

  return (
    <AdminPage title={t('groups.title')} description={t('groups.desc')}>
      {/* No width of its own - `AdminPage` applies the console's single centred
          container to every page, so this one cannot drift out of line.
          不单独设置宽度；`AdminPage` 为各页面提供统一的居中容器。 */}
      <div className="flex flex-col gap-6">
        <GroupsPanel header="toolbar" />
      </div>
    </AdminPage>
  );
}
