ALTER TABLE agents ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0 CHECK(is_public IN (0,1));
UPDATE agents SET is_public=1 WHERE EXISTS (
  SELECT 1 FROM presentation_state p WHERE p.id='main' AND (
    (p.published_json::jsonb#>>'{pages,agent,selection}'='selected' AND agents.id IN (SELECT jsonb_array_elements_text(p.published_json::jsonb#>'{pages,agent,ids}'))) OR
    (p.published_json::jsonb#>>'{pages,agent,selection}'='groups' AND agents.group_id IN (SELECT jsonb_array_elements_text(p.published_json::jsonb#>'{pages,agent,groupIds}'))) OR
    (p.published_json::jsonb#>>'{pages,agent,selection}'='tags' AND EXISTS (SELECT 1 FROM agent_tag_links l WHERE l.agent_id=agents.id AND l.tag_id IN (SELECT jsonb_array_elements_text(p.published_json::jsonb#>'{pages,agent,tagIds}'))))
  )
);
CREATE INDEX idx_agents_public_active ON agents(is_public,active);
UPDATE presentation_state SET published_json=jsonb_build_object(
  'agentEnabled',published_json::jsonb->'agentEnabled',
  'workerService',published_json::jsonb->'workerService',
  'domains',published_json::jsonb->'domains',
  'pages',jsonb_build_object(
    'monitor',jsonb_build_object('theme',published_json::jsonb#>'{pages,monitor,theme}','themeOptions',published_json::jsonb#>'{pages,monitor,themeOptions}'),
    'agent',jsonb_build_object('theme',published_json::jsonb#>'{pages,agent,theme}','themeOptions',published_json::jsonb#>'{pages,agent,themeOptions}')
  ))::text,revision='settings-v2-'||updated_at;
ALTER TABLE presentation_state DROP COLUMN draft_json;
ALTER TABLE presentation_state RENAME COLUMN published_json TO config_json;
