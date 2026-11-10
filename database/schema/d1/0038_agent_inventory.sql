-- Groups belong to monitors; machine identities and telemetry remain independent.
-- 分组属于监控；机器身份和采样数据保持独立。
ALTER TABLE agents DROP COLUMN group_id;
