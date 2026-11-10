/**
 * Status vocabulary shared by both surfaces.
 *
 * These lived in `admin/ui.tsx` until the public page needed them: a
 * `components/shared/*` module cannot import a type from the console without
 * dragging the console's module (and its HeroUI imports) back into the public
 * bundle. Types cost nothing at runtime, so they belong here rather than behind
 * the admin directory.
 *
 * 公开页面与控制台共用状态词汇。它们曾放在 admin/ui.tsx，但共享组件若从控制台
 * 导入类型会将控制台模块及 HeroUI 导入带回公开包；类型无运行时成本，因此放在此处
 * 而非 admin 目录下。
 */

/** Tone names, kept as data rather than class strings so callers stay declarative. / 以数据而非类名保存状态色，让调用方保持声明式。 */
export type Tone = 'up' | 'warn' | 'down' | 'pending' | 'idle';

/** Tints an icon tile can take. Status hues mean status; the rest render neutral. / 图标块支持的色调；状态色表示状态，其余使用中性色。 */
export type Hue =
  | 'primary'
  | 'success'
  | 'warning'
  | 'danger'
  | 'amber'
  | 'violet'
  | 'cyan'
  | 'indigo'
  | 'pink'
  | 'default';
