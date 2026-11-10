const d1 = {
  metadata: 'SELECT version FROM user_avatars WHERE user_id = ?',
  image: 'SELECT data_url FROM user_avatars WHERE user_id = ?',
  upsert: `INSERT INTO user_avatars (user_id, data_url, version, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET data_url = excluded.data_url, version = excluded.version, updated_at = excluded.updated_at`,
  remove: 'DELETE FROM user_avatars WHERE user_id = ?',
};

const postgres: Record<keyof typeof d1, string> = {
  metadata: 'SELECT version FROM user_avatars WHERE user_id = $1',
  image: 'SELECT data_url FROM user_avatars WHERE user_id = $1',
  upsert: `INSERT INTO user_avatars (user_id, data_url, version, updated_at) VALUES ($1, $2, $3, $4)
    ON CONFLICT(user_id) DO UPDATE SET data_url = excluded.data_url, version = excluded.version, updated_at = excluded.updated_at`,
  remove: 'DELETE FROM user_avatars WHERE user_id = $1',
};

export const avatarSQL = { d1, postgres };
