-- Public presentation settings and independent machine classifications.
-- 公开展示设置与独立的机器分类。
CREATE TABLE presentation_state (id TEXT PRIMARY KEY, published_json TEXT NOT NULL, draft_json TEXT NOT NULL, revision TEXT NOT NULL, updated_at BIGINT NOT NULL);
CREATE TABLE agent_groups (id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,weight INTEGER NOT NULL DEFAULT 0,created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL);
CREATE TABLE agent_tags (id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,color TEXT NOT NULL,created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL);
ALTER TABLE agents ADD COLUMN group_id TEXT REFERENCES agent_groups(id) ON DELETE SET NULL;
CREATE TABLE agent_tag_links (agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,tag_id TEXT NOT NULL REFERENCES agent_tags(id) ON DELETE CASCADE,PRIMARY KEY(agent_id,tag_id));
CREATE INDEX idx_agents_group ON agents(group_id);
CREATE INDEX idx_agent_tags_lookup ON agent_tag_links(tag_id);
DROP INDEX idx_themes_one_active;
ALTER TABLE themes DROP COLUMN previous_active_version;
ALTER TABLE themes DROP COLUMN active_version;
ALTER TABLE themes DROP COLUMN is_active;
DROP TABLE theme_settings;
