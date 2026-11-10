ALTER TABLE agents ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0 CHECK(is_public IN (0,1));
UPDATE agents SET is_public=1 WHERE EXISTS (
  SELECT 1 FROM presentation_state p WHERE p.id='main' AND (
    (json_extract(p.published_json,'$.pages.agent.selection')='selected' AND agents.id IN (SELECT value FROM json_each(p.published_json,'$.pages.agent.ids'))) OR
    (json_extract(p.published_json,'$.pages.agent.selection')='groups' AND agents.group_id IN (SELECT value FROM json_each(p.published_json,'$.pages.agent.groupIds'))) OR
    (json_extract(p.published_json,'$.pages.agent.selection')='tags' AND EXISTS (SELECT 1 FROM agent_tag_links l WHERE l.agent_id=agents.id AND l.tag_id IN (SELECT value FROM json_each(p.published_json,'$.pages.agent.tagIds'))))
  )
);
CREATE INDEX idx_agents_public_active ON agents(is_public,active);
UPDATE presentation_state SET published_json=json_object(
  'agentEnabled',json(CASE WHEN json_extract(published_json,'$.agentEnabled')=1 THEN 'true' ELSE 'false' END),
  'workerService',json_extract(published_json,'$.workerService'),
  'domains',json_extract(published_json,'$.domains'),
  'pages',json_object(
    'monitor',json_object('theme',json_extract(published_json,'$.pages.monitor.theme'),'themeOptions',json_extract(published_json,'$.pages.monitor.themeOptions')),
    'agent',json_object('theme',json_extract(published_json,'$.pages.agent.theme'),'themeOptions',json_extract(published_json,'$.pages.agent.themeOptions'))
  )),revision='settings-v2-'||updated_at;
ALTER TABLE presentation_state DROP COLUMN draft_json;
ALTER TABLE presentation_state RENAME COLUMN published_json TO config_json;
INSERT INTO app_settings(key,value_json,updated_at)
  SELECT 'maintenance.scheduleEnabled','true',updated_at FROM app_settings WHERE key='alerts.maintenanceWindows' AND json_array_length(value_json)>0
  ON CONFLICT(key) DO NOTHING;
