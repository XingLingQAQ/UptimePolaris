import type { Status } from '../../types';

export interface CheckResult {
  /** CT 查询时间；0 表示尚未执行，缓存保留原时间。 / CT lookup time; 0 means unstarted, and cache hits keep the original time. */
  observedAt?: number;
  /** 上游明确报告吊销时保持警告。 / Preserve warnings when the source explicitly reports revocation. */
  revoked?: boolean;
  status: Status;
  latencyMs: number;
  statusCode: number;
  message: string;
  /**
   * Days until expiry, set only by certificate and domain add-ons.
   *
   * Not plotted: time series record the primary latency. It used to be
   * `daysLeft ?? latencyMs`, so a failed RDAP lookup's ~10.8 s latency showed as
   * "10812 days remaining" beside a red Down badge.
   * 只用于附加检查，不进入图表；混用曾被渲染成“剩余 10812 天”。
   */
  daysLeft?: number;
}
