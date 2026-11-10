UPDATE app_settings SET value_json=(
  SELECT COALESCE(jsonb_agg(jsonb_build_object('kind','weekly','day',value->'day','start',value->'start','end',value->'end')),'[]'::jsonb)::text
  FROM jsonb_array_elements(app_settings.value_json::jsonb)
) WHERE key='alerts.maintenanceWindows';
UPDATE presentation_state SET config_json=jsonb_set(config_json::jsonb,'{domains}',(
  SELECT COALESCE(jsonb_agg(jsonb_build_object('hostname',value->'hostname','page',value->'page')),'[]'::jsonb)
  FROM jsonb_array_elements(presentation_state.config_json::jsonb->'domains')
))::text,revision='refinements-'||revision;
