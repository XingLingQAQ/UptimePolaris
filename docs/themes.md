# 主题指南

[English](#english)

一个主题包可以同时提供监控状态页和机器状态页的主题。“主题管理”顶部两个看板分别显示两个页面的当前主题；下方已安装主题可以直接应用，会按主题声明的页面类型自动匹配。安装或更新主题包不会切换当前主题。管理控制台、登录、初始化和 API 始终使用内置实现。

## 安装与选择

1. Worker 配好 `THEMES` R2 绑定；Go 使用数据目录里的 `themes/`，确保可写且持久化。
2. 在主题管理里上传 ZIP，或填写可下载的 ZIP 地址。
3. 在主题管理里预览包内的各个主题。
4. 在已安装主题的某个版本旁点“应用”，主题就用到它声明的页面类型，不用另选监控页或机器页。
5. 顶部看板显示应用结果；点“主题配置”编辑选项并保存。机器页看板和应用入口只在机器独立展示功能开启时显示。

更新会安装新的修订版本，不会切换页面。要恢复旧版本，在已安装列表里直接应用那个版本；也可以在对应看板恢复内置主题。删除主题包会先清掉两个页面对这个包的引用，再删除资源。资源删除失败时，管理记录还在，已经清掉的页面引用不会恢复。

主题 JavaScript 会在公开页面运行，只安装可信来源的包。

可以使用 [Polaris Simple](../examples/themes/polaris-simple/README.md) 主题包，分别给监控页和机器页选主题。

## 配置选项

在主题配置里修改主题提供的选项并保存。有哪些选项取决于所选主题。

主题配置里可以填头部代码（最多 16 KiB UTF-8）和自定义 HTML（最多 32 KiB UTF-8，需要主题提供内容插槽）。这些内容访客都能看到，脚本还有本站同源权限；只用可信代码，不要填凭据。切换主题版本、恢复内置主题或删除主题后，这些内容会清空。

主题选项引用的监控或机器，必须位于对应页面的公开范围内。

## 预览

预览在隔离窗口里运行。外部脚本、网络请求和需要本站权限的行为，可能和公开页面不一样。应用后要用未登录状态检查实际页面。

## 管理 API

以下接口需要管理员会话或 Bearer Token：

| 方法和路径 | 用途 |
| --- | --- |
| `GET /api/themes` | 列出主题包、已安装版本和各版本的子主题 |
| `POST /api/themes/install` | 提交 `{ "url": "https://example.com/theme.zip" }` 或 ZIP 二进制请求体 |
| `GET /api/themes/:short/preview?version=<versionKey>&theme=<id>` | 获取子主题预览元数据 |
| `GET /api/themes/:short/update-check` | 检查来源 URL 更新 |
| `DELETE /api/themes/:short` | 删除主题包及其资源 |

ZIP 上传使用 `Content-Type: application/zip`。页面配置使用 `page.theme = { short, version, theme }`、`page.themeOptions` 和可选的 `page.headCode`、`page.contentHtml`；其中 `version` 用安装返回的 `versionKey`。通过展示配置接口保存后立即生效。

## English

Theme packages can provide monitor and machine pages. Installation or update adds a version but does not activate it. The administration console, login, setup and API remain built in. See the [documentation index](README.md#english) and [deployment guide](deployment.md#english) for the surrounding site setup.

### Install and apply

Worker needs the `THEMES` R2 binding; Go stores theme files in its persistent data directory. In theme management, upload a ZIP or provide its download URL, preview its themes, then apply the selected version. Application is matched to the theme's declared page type. The machine-page controls appear when the separate machine page is enabled. Change options in the corresponding page panel; save changes in the panel.

To roll back, apply an installed older version or restore the built-in theme. Deleting a package first removes references from both pages, then deletes its resources. If resource deletion fails, the management record remains but removed page references are not restored. Theme JavaScript runs on public pages, so install only packages you trust.

The [Polaris Simple theme](../examples/themes/polaris-simple/README.md#english) provides monitor and machine pages.

### Configure and preview

Edit the options offered by the selected theme and save them. Monitor and machine references must belong to the corresponding public page.

`headCode` allows up to 16 KiB of UTF-8 HTML, CSS and JavaScript in the page head. `contentHtml` allows up to 32 KiB of UTF-8 custom HTML when the theme supports a content slot. Both are public. Scripts on a public theme page run with the site's origin; use trusted code and never include credentials. These values are cleared when switching the theme version, restoring the built-in theme or deleting the theme.

Preview runs in an isolated window. External scripts, network requests and behavior requiring the site's origin can differ from the public page. Check the applied page while signed out.

### Administration API

The API table above lists package listing, ZIP or URL installation, preview, update checks and deletion. These operations require an administrator session or Bearer token. ZIP uploads use `Content-Type: application/zip`. Page configuration uses `page.theme = { short, version, theme }`, `page.themeOptions`, and optional `page.headCode` and `page.contentHtml`; `version` is the installed `versionKey`. Saving the presentation configuration applies the change.
