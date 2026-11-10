export interface AdminEvent {
  id: number;
  monitor_id: string;
  /** 1 UP, 0 DOWN, 2 WARN, 4 PENDING. PENDING events exist (the transition is logged) but never page anyone. / 1 正常、0 故障、2 警告、4 待定；待定状态变更会记录事件，但不会通知任何人。 */
  status: 0 | 1 | 2 | 4;
  message: string | null;
  created_at: number;
}
