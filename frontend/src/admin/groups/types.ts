/** Status-page group, sorted by weight then name. / 状态页分组，先按权重再按名称排序。 */
export interface MonitorGroup {
  id: string;
  name: string;
  weight: number;
  created_at: number;
  updated_at: number;
}

/** Reusable label with a stored color that survives renaming. / 可复用标签，重命名后保留其存储的颜色。 */
export interface Tag {
  id: string;
  name: string;
  color: string;
  created_at: number;
  updated_at: number;
}
