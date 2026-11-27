# 主题指南

[English](#english)

主题系统支持调整公开监控页（`/`）、机器页（`/servers`）和 AI 模型页（`/ai`）的外观，或安装第三方 ZIP 主题包。管理后台与登录页始终使用内置样式。

## 安装与应用

- **存储要求**：Worker 需绑定 `THEMES` R2 存储桶；Go 需确保数据目录下 `themes/` 可写。
- **操作步骤**：在 **主题管理** 上传或拖入 ZIP 包（或填写 ZIP 下载链接）→ 预览包内子主题 → 点击“应用”（自动匹配主题声明的页面类型）→ 在页面顶部看板点击“主题配置”调整参数并保存。
- **更新与回退**：更新正在使用的主题包后，关联页面会自动切换到新版并保留仍有效的参数与自定义代码（若新版缺少正在使用的子主题则会拒绝更新）；回退需重新上传旧版 ZIP 或恢复内置主题。删除主题前会先清除页面引用。
- **安全警告**：第三方主题的脚本会在公开页面以本站同源权限运行，只安装可信来源的主题包。

示例包参考：[Polaris Simple 主题](../examples/themes/polaris-simple/README.md)。

## 配置选项、SDK 与自定义代码

- **内置选项**：可在各页面看板配置强调色、圆角、页宽、默认布局（列表/卡片）、内容密度、卡片列数与字段显示；引用的监控或机器须处于对应页面的公开范围内。
- **主题 SDK**：AI 主题目标类型为 `ai`（可用 `public.config`、`public.ai-models`、`public.ai-history`）；网站与 AI 主题可声明 `public.subscriptions`、`public.subscription-history` 并通过 `polarisTheme.read(...)` 读取（自定义状态页可传 `pageId`），展示时需保留来源标识，勿将外部快照与本地 SLA 混算。
- **`headCode` 与 `contentHtml`**：分别支持最多 `16 KiB`（插入 `<head>`）和 `32 KiB`（插入正文下方或主题插槽）的 UTF-8 代码。**内容对所有访客公开且脚本拥有同源权限，切勿写入凭据或不可信代码。** 更新同一主题包时保留；切换、重置或删除主题时清空。

## 预览与管理接口

控制台预览运行在隔离窗口中，部分跨域或同源请求可能受限，应用主题后请使用无痕窗口复核实际页面。管理接口（`/api/themes` 等）用法见 [API 参考](api.md#展示与主题)。

## English

Themes customize the monitor (`/`), machine (`/servers`), and AI (`/ai`) pages while keeping `/admin`, `/login`, and `/setup` in built-in styling.

### Install and apply

- **Storage**: requires the `THEMES` R2 binding on Worker or a writable `themes/` directory on Go.
- **Workflow**: upload or drop a ZIP archive (or provide a ZIP URL) under **Themes**, preview child themes, click **Apply** (matched automatically to declared page types), then configure options in the top page panel.
- Updating a package in use moves pages to the new version while keeping valid options and custom code (rejected if an active child theme is removed). Roll back by uploading the older ZIP or restoring the built-in theme.
- **Security**: theme JavaScript runs with your site's origin on public pages—install trusted packages only. See the sample [Polaris Simple theme](../examples/themes/polaris-simple/README.md#english).

### Options, SDK, and custom code

- Built-in options cover accent color, radius, width, default layout, density, columns, and visible fields; referenced items must be in that page's public scope.
- AI themes target `ai` (`public.config`, `public.ai-models`, `public.ai-history`); website and AI themes can also read `public.subscriptions` and `public.subscription-history` via `polarisTheme.read(...)` (preserve source labels; never mix snapshots with local SLA).
- `headCode` (≤`16 KiB` UTF-8) and `contentHtml` (≤`32 KiB` UTF-8) are public with site origin—never include credentials. Preserved across package updates; cleared on theme switch, reset, or deletion.

### Preview and API

Preview runs in an isolated frame, so verify applied themes while signed out. See [API reference](api.md#public-presentation-and-themes) for theme endpoints.
