UPDATE presentation_state SET config_json=json_set(config_json,'$.domains',json((
  SELECT json_group_array(json_object('hostname',json_extract(value,'$.hostname'),'page',json_extract(value,'$.page')))
  FROM json_each(presentation_state.config_json,'$.domains')
))),revision='refinements-'||revision;
