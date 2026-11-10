import { DOWN, UP, WARN, type Status } from '../../types';
import type { CheckResult } from './types';

/** Evaluate the last Push heartbeat against intervalSec; an expired heartbeat is DOWN when cron next checks it. / 根据 intervalSec 判断最后一次 Push 心跳；过期后在下次定时检查中标为 DOWN。 */
export function checkPush(
  last: { ts: number; status: number; msg: string; ping: number } | undefined,
  intervalSec: number,
  now: number,
): CheckResult {
  if (!last) {
    return { status: DOWN, latencyMs: 0, statusCode: 0, message: 'no push received' };
  }

  const ageSec = now - last.ts;
  if (ageSec > intervalSec) {
    return {
      status: DOWN,
      latencyMs: 0,
      statusCode: 0,

      message: `no push received in ${ageSec}s`,
    };
  }

  /** Use the pushed status (default UP) and the pusher's ping as latencyMs. / 使用推送的状态（默认 UP）和推送方的 ping 作为 latencyMs。 */
  const status: Status = last.status === DOWN ? DOWN : last.status === WARN ? WARN : UP;
  return { status, latencyMs: last.ping, statusCode: 0, message: last.msg };
}
