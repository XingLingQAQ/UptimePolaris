/** 一次历史同步的处理数量及完成状态。 / Processed count and completion status for a history sync. */
export interface SyncResult {
  days: number;
  attempted: number;
  succeeded: number;
  failed: number;
  monitors: number;
  status: 'disabled' | 'complete' | 'partial';
}

/** 单个 UTC 日期的观测总数、正常数、警告数及平均值。 / Total, healthy, warning, and average observations for one UTC date. */
export interface DayStat {
  d: string;
  t: number;
  u: number;
  w: number;
  avg: number | null;
  exact?: boolean;
  avg_source?: 'ae';
}

export type HistoryStatus = 'ready' | 'unconfigured' | 'unavailable';

export interface HistoryResult<T> {
  status: HistoryStatus;
  points: T[];
  sampled: boolean;
}
