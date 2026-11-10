-- Operator-uploaded site icon - Postgres mirror of 0034.
-- 管理员上传的网站图标：0034 的 Postgres 对应迁移。
--
-- Same columns and same reasoning as the D1 migration; see that file for why
-- this lives in a table rather than in `app_settings` or R2.
-- 列和设计理由与 D1 迁移相同；为何使用表而不是 `app_settings` 或 R2，参见该迁移。
--
-- `BYTEA` rather than `TEXT`: the upload is an image, and base64 in a text
-- column would inflate it by a third for no benefit. The driver hands a
-- `Uint8Array` straight through.
-- 使用 `BYTEA` 而非 `TEXT`：上传的是图片，文本中的 base64 会无益地增加三分之一体积。
-- 驱动直接传递 `Uint8Array`。
CREATE TABLE IF NOT EXISTS site_icon (
  singleton     INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
  bytes         BYTEA NOT NULL,
  content_type  TEXT NOT NULL,
  byte_size     INTEGER NOT NULL,
  filename      TEXT,
  updated_at    BIGINT NOT NULL
);
