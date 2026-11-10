-- Monitor groups and tags.
--
-- Two ways of labelling a monitor, and neither is a column on `monitors`: a
-- monitor is in at most one group (one-to-many) and carries any number of tags
-- (many-to-many), so `monitor_groups` and `tags` are the vocabulary and
-- `monitor_tags` is the join. `monitors.group_id` is the single exception,
-- because it is exactly one value per monitor and has to be readable with the
-- row - the status page groups monitors it has already read.
--
-- **No foreign keys anywhere in this file.** Nothing else in this schema
-- declares one - 0008 argues the same for `push_heartbeats` - and in the one
-- place a key would have been worth having it is not possible at all: SQLite
-- cannot add a constrained column to an existing table, and `group_id` arrives
-- below by `ALTER TABLE`, so it can never carry a REFERENCES clause. What that
-- costs is a dangling id, and the API closes it on the write path instead:
-- src/api.ts refuses a `group_id` that names no group (`group_not_found`) and a
-- `tag_id` that names no tag (`tag_not_found`), and src/lib/groups.ts nulls the
-- column in the same batch as the delete, so the group can never be gone while
-- its monitors still point at it. The read path is the second half: a
-- `group_id` naming no group is treated as ungrouped rather than dropped, so
-- even a row written by hand outside the API stays on the status page.
--
-- **`group_id` NULL means ungrouped**, and that is the right default rather
-- than a sentinel group row. A monitor created before groups existed, or one
-- nobody has filed yet, is a member of nothing; a reserved "Ungrouped" row
-- would be one every reader has to know to exclude from the picker, from the
-- group count, and from the console's list of things that can be renamed or
-- deleted. NULL cannot be renamed, deleted or counted by mistake.
--
-- **Ordering is load-bearing**, as in 0004, 0005 and 0008. The ALTER is first,
-- so a second apply dies on "duplicate column name" - SQLite has no `ADD COLUMN
-- IF NOT EXISTS` - before it reaches a single `CREATE TABLE IF NOT EXISTS`.
-- Everything after the ALTER is repeatable (`IF NOT EXISTS` throughout), which
-- is exactly why the one statement that is not has to come first: the file can
-- then never be half-applied, because the statement that can fail fails
-- immediately and the rest is a no-op.
--
-- 监控分组和标签：监控项至多属于一个分组（一对多），可有任意标签（多对多）；
-- monitor_groups、tags 保存词表，monitor_tags 保存关联。monitors.group_id 是例外，
-- 因为每项只有一个值，状态页需要随监控行读取。此文件不设外键：其他表也未声明，
-- 且 SQLite 不能给已有表添加带 REFERENCES 约束的列；group_id 通过 ALTER 添加。
-- API 在写入时拒绝不存在的 group_id/tag_id（group_not_found/tag_not_found），
-- 删除分组时在同一批次将监控项的 group_id 清空；读取时悬空分组按未分组处理，
-- 因此手工写入的行也不会从状态页消失。NULL 表示未分组，是合理默认值：旧监控项
-- 或尚未归组的项不属于任何组；保留“未分组”记录会要求每个读取方将它排除在选择器、
-- 计数和可重命名/删除列表外，NULL 不会被误改、误删或误计数。顺序至关重要：
-- ALTER 首先执行，第二次应用会在任何 CREATE 之前因重复列失败；SQLite 不支持
-- ADD COLUMN IF NOT EXISTS。之后的 CREATE 全部可重复，故唯一不可重复语句必须
-- 放在开头，让失败立即发生，其余重复执行为无操作，避免半完成状态。
ALTER TABLE monitors ADD COLUMN group_id TEXT;

-- The group vocabulary. `weight` is a sort key, not an order of rows: it
-- defaults to 0 so a group created without one lands among what already exists
-- rather than after it, and every reader orders by `weight` then `name`, so the
-- order is total and stable without a renumbering pass whenever a group moves.
--
-- `name` is UNIQUE (index below) so a duplicate is refused by SQLite rather
-- than by a pre-check two concurrent creates would both pass. The constraint is
-- byte-exact - SQLite's default BINARY collation - so `Prod` and `prod` are two
-- groups. That is the safer direction to be wrong in: a case-different
-- near-duplicate is visible in the list and can be renamed, whereas folding
-- case would refuse a name for a reason no form could explain.
--
-- 分组词表的 weight 是排序键而非行序号，默认 0，使未指定权重的新分组与已有项
-- 一起排序；所有读取方先按 weight 再按 name 排序，移动分组无需重编号。
-- name 的唯一索引让 SQLite 拒绝重复，避免并发创建都通过预检查；默认 BINARY
-- 整字节比较，Prod 和 prod 是两个分组。大小写不同的近似项可见且可改名，
-- 比忽略大小写后以表单难以解释的原因拒绝名称更安全。
CREATE TABLE IF NOT EXISTS monitor_groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  weight     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_monitor_groups_name ON monitor_groups(name);

-- Tags: the same vocabulary shape as a group, with a colour instead of a
-- weight. A tag is rendered as a chip, so its colour is part of what the tag
-- *is* rather than a display preference, and it is stored (`#RRGGBB`, defaulted
-- to the brand blue) instead of being derived in the browser. The API refuses
-- anything that is not `#RRGGBB` with `color_invalid`.
--
-- 标签词表与分组类似，但用颜色代替权重。标签渲染为徽章，颜色是标签本身的一部分，
-- 而非展示偏好，因此存储 `#RRGGBB`（默认品牌蓝）而非由浏览器推导；
-- API 以 color_invalid 拒绝不符合格式的值。
CREATE TABLE IF NOT EXISTS tags (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#006FEE',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name ON tags(name);

-- The join. `PRIMARY KEY (monitor_id, tag_id)` rather than a surrogate id: the
-- pair is what has to be unique, and making the pair the key turns a double
-- insert into a constraint error instead of a second identical chip. Both
-- columns are NOT NULL - a join row with a NULL half can never be matched by
-- the join that reads it, so it would be a row nothing could act on.
--
-- No index on `monitor_id`: the primary key already covers it as its leading
-- column, which is the direction every read goes (`WHERE monitor_id IN (...)`).
--
-- 关联表使用 (monitor_id, tag_id) 联合主键而非代理 ID：需要唯一的是该二元组，
-- 重复插入应产生约束错误，而不是第二个相同徽章。两列均为 NOT NULL，
-- 因为任一半为 NULL 的记录无法被关联查询匹配。monitor_id 不另建索引：
-- 它已是主键首列，覆盖所有按监控项读取的查询。
CREATE TABLE IF NOT EXISTS monitor_tags (
  monitor_id TEXT NOT NULL,
  tag_id     TEXT NOT NULL,
  PRIMARY KEY (monitor_id, tag_id)
);

-- The reverse direction, needed by exactly one statement: deleting a tag has to
-- find its join rows, and `monitor_id` being the leading key column does not
-- help with `WHERE tag_id = ?`.
-- 反向索引用于删除标签时查找关联行；主键首列为 monitor_id，无法帮助按 tag_id 查找。
CREATE INDEX IF NOT EXISTS idx_monitor_tags_tag ON monitor_tags(tag_id);

-- For `DELETE /api/groups/:id`, which nulls every monitor pointing at the group
-- it deletes, and for nothing else: the status page buckets monitors it has
-- already read, so it never asks "which monitors are in group X". Last, because
-- it indexes the column the first statement adds.
-- 该索引仅供 DELETE /api/groups/:id 清空引用该组的监控项使用；状态页对已读取
-- 监控项分桶，不查询某分组的成员。放在最后，因为索引的列由第一条语句添加。
CREATE INDEX IF NOT EXISTS idx_monitors_group ON monitors(group_id);
