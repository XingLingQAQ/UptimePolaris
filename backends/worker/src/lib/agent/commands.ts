/** Gate queued commands by feature switch, supported action, announced capability and liveness. The Agent checks host supervision. / 命令入队前检查功能开关、支持的操作、已声明能力及在线状态；Agent 检查主机监管方式。 */

import type { Env, Agent } from '../../types';
import { randomToken } from '../auth/service';
import { getDB } from '../db/factory';
import { commandsSQL } from '../db/sql/commands';
import { readAll } from '../settings/store';

/** Supported parameterless Agent actions. / 支持的无参数 Agent 操作。 */
export const COMMAND_ACTIONS = ['upgrade', 'restart', 're_report', 'check_update'] as const;
export type CommandAction = (typeof COMMAND_ACTIONS)[number];

export function isCommandAction(value: unknown): value is CommandAction {
  return typeof value === 'string' && (COMMAND_ACTIONS as readonly string[]).includes(value);
}

/** Use the Agent's announced capability rather than a release-version comparison. / 使用 Agent 声明的能力，而非比较发布版本。 */
export const COMMAND_CAPABILITY = 'commands';

/** Whether the agent announced command support; malformed capabilities mean no. / Agent 是否声明支持指令；能力字段损坏时视为不支持。 */
export function supportsCommands(probeCapabilities: string | null | undefined): boolean {
  if (typeof probeCapabilities !== 'string') return false;
  try {
    const parsed: unknown = JSON.parse(probeCapabilities);
    return Array.isArray(parsed) && parsed.includes(COMMAND_CAPABILITY);
  } catch {
    return false;
  }
}

/** How long a queued command stays worth running before it expires. / 命令入队后直至过期的有效时长。 */
const COMMAND_TTL_SEC = 900;
/** Lease length, matching the probe queue's grace for a slow upload. / 租约时长，与探测队列的慢上传宽限时间一致。 */
const COMMAND_LEASE_SEC = 120;
/** Attempts before a command is abandoned. / 放弃命令之前的尝试次数。 */
const MAX_ATTEMPTS = 3;
/** Commands handed out per poll, so one agent cannot be flooded. / 每次轮询发放的命令数上限，避免单个 Agent 被淹没。 */
const MAX_PER_POLL = 4;

export interface AgentCommand {
  id: string;
  action: CommandAction;
  lease_token: string;
  lease_expires_at: number;
}

/** Whether the console is allowed to command agents at all. / 控制台是否允许向 Agent 下发命令。 */
export async function commandsEnabled(env: Env): Promise<boolean> {
  const { values } = await readAll(env);
  return values['security.allowAgentCommands'] === true;
}

export type EnqueueError = 'commands_disabled' | 'unknown_action' | 'agent_not_found' | 'agent_unsupported' | 'agent_offline';

export type EnqueueResult =
  | { ok: true; id: string }
  | { ok: false; error: EnqueueError };

/** Queue a command only while the agent is online; an offline queue would fire as a surprise later. / 仅在线时入队；离线队列会在之后意外执行。 */
export async function enqueueCommand(
  env: Env,
  agentId: string,
  action: unknown,
  issuedBy: string | null,
  now: number,
): Promise<EnqueueResult> {
  if (!isCommandAction(action)) return { ok: false, error: 'unknown_action' };
  if (!(await commandsEnabled(env))) return { ok: false, error: 'commands_disabled' };

  const db = getDB(env);
  const agent = await db.queryOne<Agent & { version: string | null; reported_at: number | null; report_interval_secs: number | null; probe_capabilities: string | null }>(
    db.type === 'postgres'
      ? `SELECT m.*, ml.version, ml.reported_at, ml.report_interval_secs, ml.probe_capabilities
           FROM agents m LEFT JOIN machine_live ml ON ml.agent_id = m.id
          WHERE m.id = $1 AND m.active = 1`
      : `SELECT m.*, ml.version, ml.reported_at, ml.report_interval_secs, ml.probe_capabilities
           FROM agents m LEFT JOIN machine_live ml ON ml.agent_id = m.id
          WHERE m.id = ? AND m.active = 1`,
    [agentId],
  );
  if (!agent) return { ok: false, error: 'agent_not_found' };
  // The agent's own announcement, not a version comparison - see COMMAND_CAPABILITY.
  // 使用 Agent 自行声明的能力，而非比较版本，参见 COMMAND_CAPABILITY。
  if (!supportsCommands(agent.probe_capabilities)) return { ok: false, error: 'agent_unsupported' };

  // Use the shared `agentIsOnline` so console and gate agree. / 复用 `agentIsOnline`，保证控制台和入口判断一致。
  const { agentIsOnline, agentStaleAfterSec } = await import('./liveness');
  const online = agentIsOnline(agent.reported_at, now, agentStaleAfterSec(agent.report_interval_secs));
  if (online !== true) return { ok: false, error: 'agent_offline' };

  const id = crypto.randomUUID();
  await db.execute(commandsSQL[db.type].insert, [id, agentId, action, now, issuedBy]);
  return { ok: true, id };
}

export interface BatchEnqueueResult {
  id: string;
  ok: boolean;
  error?: EnqueueError;
}

/** One command per id; a refusal is reported for that id and the loop continues. / 每个 ID 对应一条命令；拒绝时记录该 ID 的结果并继续处理。 */
export async function enqueueCommands(
  env: Env,
  ids: readonly string[],
  action: unknown,
  issuedBy: string | null,
  now: number,
): Promise<BatchEnqueueResult[]> {
  if (!isCommandAction(action)) return ids.map((id) => ({ id, ok: false, error: 'unknown_action' }));
  const results: BatchEnqueueResult[] = [];
  for (const id of ids) {
    const result = await enqueueCommand(env, id, action, issuedBy, now);
    results.push(result.ok ? { id, ok: true } : { id, ok: false, error: result.error });
  }
  return results;
}

/** Leased commands for this poll; empty when the feature is off. / 本次轮询领取的指令；功能关闭时为空。 */
export async function pollCommands(env: Env, agent: Agent, now: number): Promise<AgentCommand[]> {
  if (!agent.active || !(await commandsEnabled(env))) return [];

  const db = getDB(env);
  const sql = commandsSQL[db.type];

  // Housekeeping first, so a command queued while this agent was away is expired
  // rather than delivered late.
  // 先清理过期命令，避免 Agent 离线期间入队的命令被延迟执行。
  await db.execute(sql.expireStale, [agent.id, COMMAND_TTL_SEC, now]);

  const rows = await db.query<{ id: string; action: string }>(
    sql.pollable,
    db.type === 'postgres'
      ? [agent.id, MAX_ATTEMPTS, COMMAND_TTL_SEC, now, now, MAX_PER_POLL]
      : [agent.id, MAX_ATTEMPTS, COMMAND_TTL_SEC, now, now, MAX_PER_POLL],
  );

  const out: AgentCommand[] = [];
  for (const row of rows) {
    if (!isCommandAction(row.action)) {
      // Unknown action from a newer build: expire it instead of returning a permanent no-op. / 更新版本写入的未知动作：使其过期，而不是永久空操作。
      await db.execute(
        db.type === 'postgres' ? "UPDATE agent_commands SET state='expired' WHERE id=$1" : "UPDATE agent_commands SET state='expired' WHERE id=?",
        [row.id],
      );
      continue;
    }
    const leaseToken = randomToken();
    const leaseUntil = now + COMMAND_LEASE_SEC;
    const claimed = await db.execute(
      sql.claim,
      [leaseToken, leaseUntil, row.id, MAX_ATTEMPTS, now],
    );
    // Lost the race against another isolate; skip rather than hand out a lease
    // this request does not own.
    // 其他 isolate 抢先取得租约；跳过，不能发放本请求不拥有的租约。
    if (claimed.rowsAffected !== 1) continue;
    out.push({ id: row.id, action: row.action, lease_token: leaseToken, lease_expires_at: leaseUntil });
  }
  return out;
}

export type CommandResultInput = {
  id?: unknown;
  lease_token?: unknown;
  ok?: unknown;
  message?: unknown;
};

export type CommandResultOutcome = 'recorded' | 'duplicate' | 'stale' | 'not_found' | 'invalid';

/** Record a command result; `duplicate` is a normal outcome for retried uploads. / 记录指令结果；重试上传出现 `duplicate` 属正常。 */
export async function submitCommandResult(
  env: Env,
  agent: Agent,
  body: CommandResultInput,
  now: number,
): Promise<CommandResultOutcome> {
  const id = typeof body.id === 'string' ? body.id : '';
  const leaseToken = typeof body.lease_token === 'string' ? body.lease_token : '';
  if (!id || !leaseToken) return 'invalid';
  if (body.ok !== true && body.ok !== false) return 'invalid';

  const db = getDB(env);
  const sql = commandsSQL[db.type];
  const row = await db.queryOne<{ agent_id: string; state: string; lease_token: string | null; lease_until: number | null }>(
    sql.get,
    [id],
  );
  // A command belonging to another agent is reported as missing, not as
  // forbidden: distinguishing the two would let one agent probe for the
  // existence of another's commands.
  // 属于其他 Agent 的命令返回不存在而非禁止访问，避免泄露其他主机命令是否存在。
  if (!row || row.agent_id !== agent.id) return 'not_found';

  if (row.state === 'completed') return 'duplicate';
  if (row.state !== 'leased' || row.lease_token !== leaseToken || row.lease_until === null || row.lease_until < now) return 'stale';

  const message = typeof body.message === 'string' ? body.message.slice(0, 512) : '';
  const done = await db.execute(sql.complete, [body.ok ? 1 : 0, message, now, id, leaseToken, now]);
  if (done.rowsAffected !== 1) return 'stale';
  return 'recorded';
}

/** Recent commands for one agent, for the detail view. / 单个 Agent 的近期命令，供详情页使用。 */
export async function listCommandsForAgent(
  env: Env,
  agentId: string,
  limit = 20,
): Promise<Array<Record<string, unknown>>> {
  const db = getDB(env);
  return db.query<Record<string, unknown>>(commandsSQL[db.type].listForAgent, [agentId, limit]);
}

/** Drop finished commands past the retention window. / 删除超出保留期的已完成命令。 */
export async function pruneCommands(env: Env, olderThan: number): Promise<void> {
  const db = getDB(env);
  try {
    await db.execute(commandsSQL[db.type].pruneOld, [olderThan]);
  } catch {
    // Same tolerance as every other prune: a missing table on a deployment that
    // has not applied 0029 yet must not fail the sync that did the real work.
    // 与其他清理任务一样容忍缺表：尚未应用 0029 的部署不能因此使已完成实际工作的同步失败。
  }
}
