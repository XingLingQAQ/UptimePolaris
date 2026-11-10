/* 验证重试期间的 PENDING、确认后的 DOWN 及独立附加警告。
 * Check PENDING during retries, confirmed DOWN, and independent add-on warnings. */
import { buildReading, notificationTransition, transitionMessage } from '../../backends/worker/src/lib/jobs/tick.ts';
import { worstStatus } from '../../backends/worker/src/lib/check/run';
import { UP, DOWN, WARN, PENDING, MAX_RETRIES } from '../../backends/worker/src/types.ts';

let pass = 0;
let fail = 0;

function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`);
}

const primary = (status, latencyMs = 100, message = '') => ({
  status,
  latencyMs,
  statusCode: status === DOWN ? 0 : 200,
  message,
});
const addon = (st, days = 0, msg = '') => ({ st, days, msg, ts: 1000 });
const prev = (st, fails) => ({ st, ts: 1, v: 0, code: 0, msg: '', fails });

console.log('\nbuildReading - the PENDING state');

{
  // First failure: not yet DOWN, the retry budget is still intact.
  // 首次失败：尚未 DOWN，重试预算仍有剩余。
  const once = buildReading(primary(DOWN), {}, undefined, 5000).entry;
  eq('first primary failure is PENDING', once.st, PENDING);
  eq('first primary failure counts as fails=1', once.fails, 1);

  // Second failure: still PENDING.
  // 第二次失败：仍为 PENDING。
  const twice = buildReading(primary(DOWN), {}, prev(PENDING, 1), 5000).entry;
  eq('second consecutive failure is still PENDING', twice.st, PENDING);
  eq('second failure accumulates', twice.fails, 2);

  // Third failure (MAX_RETRIES - 1 = 2 prev): now settled.
  // 第三次失败（之前为 MAX_RETRIES - 1，即 2 次）：状态确定。
  const third = buildReading(primary(DOWN), {}, prev(PENDING, MAX_RETRIES - 1), 5000).entry;
  eq(`${MAX_RETRIES}rd consecutive failure settles to DOWN`, third.st, DOWN);
  eq('settled DOWN keeps climbing fails', third.fails, MAX_RETRIES);

  // Fourth and beyond: stays DOWN, no return to PENDING.
  // 第四次及以后保持 DOWN，不会回到 PENDING。
  const fourth = buildReading(primary(DOWN), {}, prev(DOWN, MAX_RETRIES), 5000).entry;
  eq('fourth failure stays DOWN', fourth.st, DOWN);
  eq('fails continues to accumulate', fourth.fails, MAX_RETRIES + 1);

  // Recovery: any UP reading clears the counter and the badge.
  // 恢复：任意 UP 读数清除计数和状态标记。
  const recovered = buildReading(primary(UP), {}, prev(DOWN, MAX_RETRIES), 5000).entry;
  eq('recovery clears the badge', recovered.st, UP);
  eq('recovery resets fails to 0', recovered.fails, 0);

  // A single flap inside the retry budget resolves without ever turning red.
  // 重试预算内的一次短暂抖动可恢复，全程不会变红。
  let state = buildReading(primary(UP), {}, undefined, 5000).entry;
  state = buildReading(primary(DOWN), {}, state, 5001).entry;
  eq('one failure: PENDING', state.st, PENDING);
  state = buildReading(primary(UP), {}, state, 5002).entry;
  eq('one recovery: straight back to UP', state.st, UP);
  eq('recovery after a flap leaves no residue', state.fails, 0);
}

console.log('\nbuildReading - WARN beats PENDING, DOWN beats everything');

{
  // Primary DOWN (would be PENDING) but an add-on is WARN: the badge is WARN,
  // because WARN is a settled fact and PENDING is still tentative.
  // 主检查 DOWN（本应为 PENDING）但附加检查 WARN 时显示 WARN，
  // 因为 WARN 是已确定事实，而 PENDING 仍为暂定状态。
  const both = buildReading(primary(DOWN), { ssl: addon(WARN, 9) }, undefined, 5000).entry;
  eq('WARN add-on beats a PENDING primary', both.st, WARN);
  eq('primary retry counter still increments under WARN', both.fails, 1);
  const confirmed = buildReading(primary(DOWN), { ssl: addon(WARN, 9) }, prev(WARN, MAX_RETRIES - 1), 5000).entry;
  eq('primary failure still becomes DOWN after retry budget under WARN', confirmed.st, DOWN);
  eq('confirmed primary failure keeps incremented retries', confirmed.fails, MAX_RETRIES);

  // But a settled-DOWN primary is the reddest of red - no add-on overrides it.
  // 确定为 DOWN 的主检查优先级最高，附加检查不能覆盖。
  const settledDown = buildReading(
    primary(DOWN),
    { ssl: addon(WARN, 9) },
    prev(DOWN, MAX_RETRIES),
    5000,
  ).entry;
  eq('settled DOWN primary still wins over a WARN add-on', settledDown.st, DOWN);

  // A legacy add-on DOWN is normalized to WARN.
  // 旧附加检查的 DOWN 统一转为 WARN。
  const addonDown = buildReading(primary(UP), { ssl: addon(DOWN, null) }, undefined, 5000).entry;
  eq('add-on failure is WARN on a healthy primary', addonDown.st, WARN);
  eq('add-on failure does not increment retries', addonDown.fails, 0);

  // Priority across all four, exercised directly.
  // 直接验证四种状态之间的优先级。
  eq('worstStatus: DOWN beats PENDING', worstStatus(DOWN, PENDING), DOWN);
  eq('worstStatus: DOWN beats WARN', worstStatus(DOWN, WARN), DOWN);
  eq('worstStatus: WARN beats PENDING', worstStatus(WARN, PENDING), WARN);
  eq('worstStatus: PENDING beats UP', worstStatus(PENDING, UP), PENDING);
  eq('worstStatus: empty is UP', worstStatus(), UP);
}

console.log('\nbuildReading - the ring buffer treats PENDING as up');

{
  // PENDING is the retry window: the availability rail must not start
  // bleeding red for a flap that may resolve on the next tick.
  // PENDING 是重试窗口；可能在下一次 tick 恢复的抖动不应使可用率轨道提前变红。
  const p = buildReading(primary(DOWN), {}, undefined, 5000);
  eq('PENDING remains visible in the heartbeat ring', p.heartbeat.up, PENDING);

  // Only a settled DOWN writes up=0.
  // 只有确定的 DOWN 才写入 up=0。
  const d = buildReading(primary(DOWN), {}, prev(PENDING, MAX_RETRIES - 1), 5000);
  eq('settled DOWN heartbeat records up=0', d.heartbeat.up, 0);

  // WARN likewise stays up - the cert expiring has not stopped serving.
  // WARN 同样保持 up：证书即将过期不代表服务已停止。
  const w = buildReading(primary(UP), { ssl: addon(WARN, 9) }, undefined, 5000);
  eq('WARN remains visible in the heartbeat ring', w.heartbeat.up, WARN);
}

console.log('\nnotification transitions');

{
  const up = buildReading(primary(UP), {}, undefined, 5000).entry;
  const pending = buildReading(primary(DOWN), {}, up, 5001).entry;
  const pendingAgain = buildReading(primary(DOWN), {}, pending, 5002).entry;
  const down = buildReading(primary(DOWN), {}, pendingAgain, 5003).entry;
  const warn = buildReading(primary(UP), { ssl: addon(WARN, null, 'RDAP timeout') }, undefined, 5003).entry;

  eq('UP to PENDING does not notify', notificationTransition(up, pending), null);
  eq('DOWN to PENDING does not notify', notificationTransition({ ...up, st: DOWN }, pending), null);
  eq('WARN to PENDING does not notify', notificationTransition({ ...warn, st: WARN }, pending), null);
  eq('PENDING to UP does not announce recovery', notificationTransition(pending, up), null);
  eq('PENDING to DOWN notifies from last stable UP', notificationTransition(pendingAgain, down), { status: DOWN, prevStatus: UP });
  eq('DOWN to WARN recovery notifies', notificationTransition({ ...down, st: DOWN }, warn), { status: WARN, prevStatus: DOWN });
  eq('WARN to UP recovery notifies', notificationTransition(warn, up), { status: UP, prevStatus: WARN });
  eq('WARN event uses the add-on reason', transitionMessage('200 OK', { ssl: addon(WARN, null, 'SSL lookup failed') }, WARN, UP), 'SSL lookup failed');
}

console.log('\nbuildReading - PENDING and the retry counter together');

{
  /**
   * The full retry arc, end to end:
   *
   *   UP -> (fail 1) PENDING -> (fail 2) PENDING -> (fail 3) DOWN -> DOWN ...
   *   UP <- (recover) DOWN
   * 完整重试过程：UP 依次经两次 PENDING、第三次失败转 DOWN，持续失败保持 DOWN，恢复后回到 UP。
   */
  let state = buildReading(primary(UP), {}, undefined, 5000).entry;
  eq('tick 0: healthy', state.st, UP);
  eq('tick 0: no failures', state.fails, 0);

  state = buildReading(primary(DOWN), {}, state, 5001).entry;
  eq('tick 1: PENDING', state.st, PENDING);
  eq('tick 1: fails=1', state.fails, 1);

  state = buildReading(primary(DOWN), {}, state, 5002).entry;
  eq('tick 2: PENDING', state.st, PENDING);
  eq('tick 2: fails=2', state.fails, 2);

  state = buildReading(primary(DOWN), {}, state, 5003).entry;
  eq('tick 3: DOWN (retry budget spent)', state.st, DOWN);
  eq('tick 3: fails=MAX_RETRIES', state.fails, MAX_RETRIES);

  state = buildReading(primary(DOWN), {}, state, 5004).entry;
  eq('tick 4: still DOWN', state.st, DOWN);

  state = buildReading(primary(UP), {}, state, 5005).entry;
  eq('tick 5: recovery, fails reset', [state.st, state.fails], [UP, 0]);

  // And one more flap afterwards behaves exactly like the first: the counter
  // starts over, no memory of the previous outage.
  // 后续再次抖动应与首次完全一致：计数重新开始，不保留上次故障的记忆。
  state = buildReading(primary(DOWN), {}, state, 5006).entry;
  eq('a fresh failure after recovery starts at fails=1', [state.st, state.fails], [PENDING, 1]);
}

console.log('\nbuildReading - the retry budget is the operator\'s setting');

{
  /* 同时检查默认重试数和显式配置，避免设置只影响展示。
   * Check both default and configured retry counts so the setting affects behavior as well as display. */
  const one = buildReading(primary(DOWN), {}, undefined, 5000, { maxRetries: 1 }).entry;
  eq('maxRetries: 1 settles on the first failure', one.st, DOWN);
  eq('and records fails=1', one.fails, 1);

  const two = buildReading(primary(DOWN), {}, prev(PENDING, 1), 5000, { maxRetries: 2 }).entry;
  eq('maxRetries: 2 settles on the second failure', two.st, DOWN);
  eq('with fails=2', two.fails, 2);

  const stillWaiting = buildReading(primary(DOWN), {}, undefined, 5000, { maxRetries: 5 }).entry;
  eq('a budget of 5 leaves the first failure PENDING', stillWaiting.st, PENDING);

  /**
   * `0` is a legal stored value (`intIn(0, 10)`), and it must mean "settle
   * immediately" rather than being read as "unset". `opts?.maxRetries ?? MAX_RETRIES`
   * gets this right but `||` would not, so it is pinned rather than assumed.
   * 0 是合法存储值（intIn(0, 10)），必须表示立即确定状态，而非未设置。
   * opts?.maxRetries ?? MAX_RETRIES 可正确处理，|| 则不行，因此显式断言。
   */
  const zero = buildReading(primary(DOWN), {}, undefined, 5000, { maxRetries: 0 }).entry;
  eq('a budget of 0 settles on the first failure too', zero.st, DOWN);

  // An explicitly empty opts object behaves exactly like omitting it.
  // 显式空 opts 对象与省略参数行为完全一致。
  const omitted = buildReading(primary(DOWN), {}, prev(PENDING, MAX_RETRIES - 1), 5000).entry;
  const emptyOpts = buildReading(primary(DOWN), {}, prev(PENDING, MAX_RETRIES - 1), 5000, {}).entry;
  eq('an empty opts object is the default budget', emptyOpts.st, omitted.st);
  eq('and produces the same counter', emptyOpts.fails, omitted.fails);

  /**
   * The transition message quotes the same number. A log line reading "gave up
   * after 3 tries" under a budget of 1 is the event log disagreeing with the
   * status the operator sees, which is worse than no message.
   * 状态转移消息须引用同一次数；预算为 1 却记录“尝试 3 次后放弃”，
   * 会让事件日志与操作员看到的状态不一致，比没有消息更糟。
   */
  eq(
    'transitionMessage quotes the configured budget',
    transitionMessage('boom', {}, DOWN, PENDING, { maxRetries: 1 }),
    'gave up after 1 retries: boom',
  );
  eq(
    'and the default message quotes the default budget',
    transitionMessage('boom', {}, DOWN, PENDING),
    `gave up after ${MAX_RETRIES} retries: boom`,
  );
}

console.log('\nbuildReading - slow responses remain warnings');
{
  let state = buildReading(primary(UP), {}, undefined, 5000).entry;
  for (let round = 1; round <= 5; round++) {
    state = buildReading(primary(WARN, 4000, 'slow'), {}, state, 5000 + round).entry;
    eq(`slow round ${round} stays WARN`, [state.st, state.fails], [WARN, 0]);
  }
  state = buildReading(primary(DOWN), {}, state, 5010).entry;
  eq('a failed probe starts its own retry count', [state.st, state.fails], [PENDING, 1]);
  state = buildReading(primary(WARN), {}, state, 5011).entry;
  eq('a successful slow response clears failed probes', [state.st, state.fails], [WARN, 0]);
  const addonWarn = buildReading(primary(UP), { ssl: addon(WARN, 9) }, prev(WARN, 2), 5012).entry;
  eq('an add-on warning also clears failed probes', [addonWarn.st, addonWarn.fails], [WARN, 0]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
