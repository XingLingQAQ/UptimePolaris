import type { DBAdapter, DBType, DBUsage, ExecuteResult } from './adapter';

/**
 * D1-backed adapter.
 *
 * Thin: `query` / `queryOne` / `execute` forward to `prepare(...).bind(...)`,
 * and known write sets use D1's atomic `batch`. The
 * `lastMeta` remains available for existing logMeta callers; usage is scoped
 * to this adapter and sums every result, including batch statements.
 * D1 适配器：`query`、`queryOne` 和 `execute` 转发到 `prepare(...).bind(...)`，
 * 已知写入集合使用 D1 原子 `batch`。`lastMeta` 仍供现有 logMeta 调用方使用；
 * 用量限定在当前适配器内，累计所有结果，包括批处理语句。
 */
export class D1Adapter implements DBAdapter {
  readonly type: DBType = 'd1';

  /** The meta of the most recent statement, exposed for `logMeta`-style logging. / 最近一条语句的元数据，供 `logMeta` 风格的日志使用。 */
  public lastMeta: D1Meta | undefined;

  private usage: DBUsage = {
    binding_requests: 0,
    statements: 0,
    rows_read: 0,
    rows_written: 0,
    duration_ms: 0,
  };

  constructor(private db: D1Database) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.usage.binding_requests++;
    this.usage.statements++;
    const r = await this.db.prepare(sql).bind(...params).all<T>();
    this.lastMeta = r.meta;
    this.record(r.meta);
    return r.results ?? [];
  }

  async queryOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    this.usage.binding_requests++;
    this.usage.statements++;
    const r = await this.db.prepare(sql).bind(...params).all<T>();
    this.lastMeta = r.meta;
    this.record(r.meta);
    return r.results?.[0] ?? null;
  }

  async execute(sql: string, params: unknown[] = []): Promise<ExecuteResult> {
    this.usage.binding_requests++;
    this.usage.statements++;
    const r = await this.db.prepare(sql).bind(...params).run();
    this.lastMeta = r.meta;
    this.record(r.meta);
    return {
      rowsAffected: r.meta.changes ?? 0,
      lastInsertId: r.meta.last_row_id,
    };
  }

  async transaction<T>(_fn: (tx: DBAdapter) => Promise<T>): Promise<T> {
    throw new Error('D1Adapter.transaction is unsupported; use commit() with a fixed statement list');
  }

  /** Run a fixed write set through D1's atomic batch. / 使用 D1 原子批处理执行固定写入集合。 */
  async batchAll(statements: { sql: string; params?: unknown[] }[]): Promise<number[]> {
    if (statements.length === 0) return [];
    this.usage.binding_requests++;
    this.usage.statements += statements.length;
    const prepared = statements.map((s) =>
      this.db.prepare(s.sql).bind(...(s.params ?? [])),
    );
    const results = await this.db.batch(prepared);
    for (const result of results) {
      this.lastMeta = result.meta;
      this.record(result.meta);
    }
    return results.map((r) => r.meta.changes ?? 0);
  }

  async commit(statements: { sql: string; params?: unknown[] }[]): Promise<number[]> {
    return this.batchAll(statements);
  }

  getUsage(): DBUsage {
    return { ...this.usage };
  }

  private record(meta: D1Meta): void {
    this.usage.rows_read += meta.rows_read ?? 0;
    this.usage.rows_written += meta.rows_written ?? 0;
    this.usage.duration_ms += meta.duration ?? 0;
  }
}
