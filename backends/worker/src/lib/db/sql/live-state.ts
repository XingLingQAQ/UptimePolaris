/** SQL for the singleton `live_state` row. / 单行 `live_state` 的 SQL。 */

const d1 = {
  read: 'SELECT json FROM live_state WHERE id = ?',
  upsert: `INSERT INTO live_state (id, json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
  merge: `INSERT INTO live_state (id, json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET json = (
       SELECT json_group_object(key, json(value)) FROM (
         SELECT key, value FROM json_each(live_state.json)
         WHERE key NOT IN (SELECT key FROM json_each(excluded.json))
         UNION ALL SELECT key, value FROM json_each(excluded.json)
       )
     ), updated_at = excluded.updated_at`,
} as const;

type LiveStateSQL = {
  [K in keyof typeof d1]: (typeof d1)[K] extends string ? string : (typeof d1)[K];
};

const postgres: LiveStateSQL = {
  read: 'SELECT json FROM live_state WHERE id = $1',
  upsert: `INSERT INTO live_state (id, json, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT(id) DO UPDATE SET json = EXCLUDED.json, updated_at = EXCLUDED.updated_at`,
  merge: `INSERT INTO live_state (id, json, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT(id) DO UPDATE SET json = (live_state.json::jsonb || EXCLUDED.json::jsonb)::text,
       updated_at = EXCLUDED.updated_at`,
};

export const liveStateSQL: Record<'d1' | 'postgres', LiveStateSQL> = {
  d1,
  postgres,
};
