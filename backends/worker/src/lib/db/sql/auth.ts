/** SQL for `users` and `sessions`. / `users` 和 `sessions` 的 SQL。 */

const d1 = {
  findUserByName: 'SELECT * FROM users WHERE username = ? COLLATE NOCASE',
  countUsers: 'SELECT COUNT(*) AS n FROM users',
  getSetupState: 'SELECT completed FROM auth_setup_state WHERE id = 1',
  claimSetup: 'UPDATE auth_setup_state SET claim_id = ? WHERE id = 1 AND completed = 0 AND claim_id IS NULL AND NOT EXISTS (SELECT 1 FROM users)',
  findUserIdByName: 'SELECT id FROM users WHERE username = ? COLLATE NOCASE',
  insertFirstUser: `INSERT INTO users (id, username, password_hash, created_at, updated_at, failed_count, locked_until)
    SELECT ?, ?, ?, ?, ?, 0, 0 WHERE NOT EXISTS (SELECT 1 FROM users)
    AND EXISTS (SELECT 1 FROM auth_setup_state WHERE id = 1 AND claim_id = ?)`,
  finishSetup: 'UPDATE auth_setup_state SET completed = 1, claim_id = NULL WHERE id = 1 AND claim_id = ? AND EXISTS (SELECT 1 FROM users WHERE id = ?)',
  insertUser: 'INSERT INTO users (id, username, password_hash, created_at, updated_at, failed_count, locked_until) VALUES (?, ?, ?, ?, ?, 0, 0)',
  updatePassword: 'UPDATE users SET password_hash = ?, updated_at = ?, failed_count = 0, locked_until = 0 WHERE id = ?',
  renameUser: 'UPDATE users SET username = ?, updated_at = ? WHERE id = ?',
  recordFailure:
    'UPDATE users SET failed_count = failed_count + 1, ' +
    'locked_until = CASE WHEN failed_count + 1 >= ? THEN ? ELSE locked_until END ' +
    'WHERE id = ?',
  clearFailures: 'UPDATE users SET failed_count = 0, locked_until = 0 WHERE id = ?',
  clearLoginAttempts: 'DELETE FROM auth_login_limits WHERE key_hash = ?',
  pruneLoginLimits: 'DELETE FROM auth_login_limits WHERE window_started < ?',
  /**
   * One attempt against a rolling login window.
   *
   * The window and ceiling are parameters, not literals: the console settings
   * and `recordFailure`'s own counter must agree, or one locks at 3 while the
   * other allows 8. D1 binds positionally; Postgres mirrors the same twelve
   * values as `$n`.
   * 窗口和上限必须是参数；两处计数不一致会导致一个锁 3 次、另一个允许 8 次。
   */
  reserveLoginAttempt: `INSERT INTO auth_login_limits (key_hash, attempts, window_started, locked_until)
    VALUES (?, 1, ?, 0)
    ON CONFLICT(key_hash) DO UPDATE SET
      attempts = CASE WHEN window_started <= ? - ? THEN 1 ELSE attempts + 1 END,
      window_started = CASE WHEN window_started <= ? - ? THEN ? ELSE window_started END,
      locked_until = CASE WHEN locked_until > ? THEN locked_until
        WHEN (CASE WHEN window_started <= ? - ? THEN 1 ELSE attempts + 1 END) >= ? THEN ? ELSE 0 END
    RETURNING locked_until`,

  insertSession:
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)',
  resolveSession: `SELECT s.expires_at, u.id, u.username
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
  deleteSessionByHash: 'DELETE FROM sessions WHERE token_hash = ?',
  deleteSessionsForUser: 'DELETE FROM sessions WHERE user_id = ?',
  listSessionsForUser:
    'SELECT created_at, expires_at, user_agent FROM sessions WHERE user_id = ? ORDER BY created_at DESC',
} as const;

type AuthSQL = {
  [K in keyof typeof d1]: (typeof d1)[K] extends string ? string : (typeof d1)[K];
};

/**
 * Postgres dialect notes.
 *
 * `COLLATE NOCASE` does not exist, so the case-insensitive username uses
 * `LOWER(username) = LOWER($1)` and the matching index. Booleans are real
 * booleans, so the predicate is `$3 <> 0` rather than SQLite's truthy integer.
 * 用 LOWER 和对应索引；布尔值用 <> 0，不能沿用 SQLite 的整数真值。
 */
const postgres: AuthSQL = {
  findUserByName: 'SELECT * FROM users WHERE LOWER(username) = LOWER($1)',
  countUsers: 'SELECT COUNT(*)::integer AS n FROM users',
  getSetupState: 'SELECT completed FROM auth_setup_state WHERE id = 1',
  claimSetup: 'UPDATE auth_setup_state SET claim_id = $1 WHERE id = 1 AND completed = 0 AND claim_id IS NULL AND NOT EXISTS (SELECT 1 FROM users)',
  findUserIdByName: 'SELECT id FROM users WHERE LOWER(username) = LOWER($1)',
  insertFirstUser: 'INSERT INTO users (id, username, password_hash, created_at, updated_at, failed_count, locked_until) SELECT $1, $2, $3, $4, $5, 0, 0 WHERE NOT EXISTS (SELECT 1 FROM users)',
  finishSetup: 'UPDATE auth_setup_state SET completed = 1, claim_id = NULL WHERE id = 1 AND claim_id = $1 AND EXISTS (SELECT 1 FROM users WHERE id = $1)',
  insertUser: 'INSERT INTO users (id, username, password_hash, created_at, updated_at, failed_count, locked_until) VALUES ($1, $2, $3, $4, $5, 0, 0)',
  updatePassword: 'UPDATE users SET password_hash = $1, updated_at = $2, failed_count = 0, locked_until = 0 WHERE id = $3',
  renameUser: 'UPDATE users SET username = $1, updated_at = $2 WHERE id = $3',
  recordFailure:
    'UPDATE users SET failed_count = failed_count + 1, ' +
    'locked_until = CASE WHEN failed_count + 1 >= $1 THEN $2 ELSE locked_until END ' +
    'WHERE id = $3',
  clearFailures: 'UPDATE users SET failed_count = 0, locked_until = 0 WHERE id = $1',
  clearLoginAttempts: 'DELETE FROM auth_login_limits WHERE key_hash = $1',
  pruneLoginLimits: 'DELETE FROM auth_login_limits WHERE window_started < $1',
  /** Same twelve values as D1; `$3 - $4` needs `::bigint` or Postgres cannot type the operator. / 与 D1 相同的十二个值；`$3 - $4` 需要 `::bigint`，否则 Postgres 无法确定运算符。 */
  reserveLoginAttempt: `INSERT INTO auth_login_limits (key_hash, attempts, window_started, locked_until)
    VALUES ($1, 1, $2, 0)
    ON CONFLICT(key_hash) DO UPDATE SET
      attempts = CASE WHEN auth_login_limits.window_started <= $3::bigint - $4 THEN 1 ELSE auth_login_limits.attempts + 1 END,
      window_started = CASE WHEN auth_login_limits.window_started <= $5::bigint - $6 THEN $7 ELSE auth_login_limits.window_started END,
      locked_until = CASE WHEN auth_login_limits.locked_until > $8 THEN auth_login_limits.locked_until
        WHEN (CASE WHEN auth_login_limits.window_started <= $9::bigint - $10 THEN 1 ELSE auth_login_limits.attempts + 1 END) >= $11 THEN $12 ELSE 0 END
    RETURNING locked_until`,

  insertSession:
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES ($1, $2, $3, $4, $5)',
  resolveSession: `SELECT s.expires_at, u.id, u.username
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1`,
  deleteSessionByHash: 'DELETE FROM sessions WHERE token_hash = $1',
  deleteSessionsForUser: 'DELETE FROM sessions WHERE user_id = $1',
  listSessionsForUser:
    'SELECT created_at, expires_at, user_agent FROM sessions WHERE user_id = $1 ORDER BY created_at DESC',
};

export const authSQL: Record<'d1' | 'postgres', AuthSQL> = {
  d1,
  postgres,
};
