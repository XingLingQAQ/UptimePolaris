-- Accounts and sessions.
--
-- Replaces the single shared ADMIN_TOKEN as the way a human signs in. The token
-- is kept (see src/lib/auth.ts) as a machine credential for curl and CI, where
-- there is no browser to hold a cookie - but it is not what the login page
-- authenticates against.
--
-- Why a table and not a variable: a login page implies accounts. One shared
-- secret cannot be revoked per person, cannot be changed without locking
-- everyone out at once, and leaves no record of who did what.
--
-- 账户与会话：使用账户登录替代人类共享 ADMIN_TOKEN；令牌仍作为 curl 和 CI 的
-- 机器凭据（参见 src/lib/auth.ts），因为这些场景没有持有 cookie 的浏览器，
-- 但登录页不以它认证。使用表而非变量，是因为登录页需要账户：共享密钥无法按人
-- 撤销，修改时会同时锁住所有人，也无法记录操作归属。

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  -- Stored lowercased so the unique index actually prevents "Admin" and
  -- "admin" becoming two accounts.
  -- 用户名以小写存储，使唯一索引阻止“Admin”和“admin”成为两个账户。
  username      TEXT    NOT NULL,
  -- PBKDF2-SHA256, encoded as `pbkdf2$<iterations>$<salt-b64>$<hash-b64>`.
  --
  -- The iteration count is stored per row rather than read from a constant so
  -- it can be raised later without invalidating existing passwords: a login
  -- re-hashes with the current cost when it sees an older value.
  -- 使用 PBKDF2-SHA256，编码格式如上；迭代次数逐行存储而非读取常量，
  -- 因此以后提高成本时不会使已有密码失效，登录发现旧次数时会按当前成本重新哈希。
  password_hash TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  -- Failed attempts and the time of the last one, so a password can be
  -- throttled. Without this the login endpoint is an offline-speed oracle.
  -- 保存失败次数和最后一次失败时间以限制密码尝试；否则登录端点会成为高速猜测接口。
  failed_count  INTEGER NOT NULL DEFAULT 0,
  locked_until  INTEGER NOT NULL DEFAULT 0
);

-- NOCASE so the uniqueness check matches the lowercasing applied on write.
-- 使用 NOCASE，使唯一性检查与写入时转小写的规则一致。
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE);

-- Sessions.
--
-- Server-side rather than a self-contained signed token, because the point of
-- a login page is being able to sign out: a stateless token stays valid until
-- it expires, and one that leaks cannot be withdrawn.
--
-- The primary key is the SHA-256 of the cookie value, never the value itself.
-- A leaked database dump then yields no usable session - the same reason
-- password hashes are stored rather than passwords.
--
-- 会话保存在服务器而非使用独立签名令牌，以便退出登录：无状态令牌在过期前仍有效，
-- 泄漏后无法撤销。主键只保存 cookie 值的 SHA-256 而非原值；数据库转储泄漏时
-- 不会直接得到可用会话，与存储密码哈希而非密码的理由相同。
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  -- Kept for the audit trail and for letting a user see where they are signed
  -- in. Truncated on write; never used for authorisation.
  -- 为审计及用户查看登录位置保留；写入时截断，绝不用于授权。
  user_agent TEXT
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
