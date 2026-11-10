-- Widen the agent_commands action CHECK to admit `check_update`.
-- 扩展 agent_commands 的 action CHECK，允许 `check_update`。
--
-- The constraint was created inline in 0010, so Postgres named it
-- agent_commands_action_check. Dropping by that name and re-adding narrows the
-- window between the two statements to this transaction.
-- 该约束在 0010 中内联创建，因此 Postgres 将其命名为
-- agent_commands_action_check。按名称删除后重新添加，使两条语句间的窗口限于此事务。
ALTER TABLE agent_commands DROP CONSTRAINT IF EXISTS agent_commands_action_check;

ALTER TABLE agent_commands ADD CONSTRAINT agent_commands_action_check
  CHECK (action IN ('upgrade', 'restart', 're_report', 'check_update'));
