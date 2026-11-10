UPDATE app_settings SET value_json=(
  SELECT json_group_array(json_object('kind','weekly','day',json_extract(value,'$.day'),'start',json_extract(value,'$.start'),'end',json_extract(value,'$.end')))
  FROM json_each(app_settings.value_json)
) WHERE key='alerts.maintenanceWindows';
UPDATE presentation_state SET config_json=json_set(config_json,'$.domains',json((
  SELECT json_group_array(json_object('hostname',json_extract(value,'$.hostname'),'page',json_extract(value,'$.page')))
  FROM json_each(presentation_state.config_json,'$.domains')
))),revision='refinements-'||revision;
