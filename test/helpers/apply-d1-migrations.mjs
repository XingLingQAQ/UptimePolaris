// 按产品迁移目录顺序准备 D1 测试结构。
// Prepare D1 test schemas in product migration order.

import { migrationPlan } from '../../scripts/db/build-schema-bootstrap.mjs';

export async function applyD1Migrations(db) {
  await db.exec('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)');
  for (const file of migrationPlan()) {
    await db.batch([
      db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(file.name),
      ...file.statements.map(statement => db.prepare(statement)),
    ]);
  }
}
