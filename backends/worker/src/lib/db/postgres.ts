import postgres from 'postgres';
import type { DBAdapter, DBType, ExecuteResult } from './adapter';

/** Postgres adapter using porsager's `postgres`; SQL binds with `$n`, and transactions must use the callback adapter. / Postgres 适配器；SQL 使用 `$n` 绑定，事务必须使用回调里的适配器。 */

export class PostgresAdapter implements DBAdapter {
  readonly type: DBType = 'postgres';

  private sql: ReturnType<typeof postgres>;

  constructor(url: string) {
    this.sql = postgres(url, {
      max: 3,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false,
    });
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const rows = await this.sql.unsafe(sql, params as never[]);
    return rows as unknown as T[];
  }

  async queryOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  async execute(sql: string, params: unknown[] = []): Promise<ExecuteResult> {
    const r = await this.sql.unsafe(sql, params as never[]);
    // `RowList.count` is the affected-row count; Postgres has no `lastrowid`. / `RowList.count` 是影响行数；Postgres 没有 `lastrowid`。
    return {
      rowsAffected: r.count ?? 0,
      lastInsertId: undefined,
    };
  }

  async transaction<T>(fn: (tx: DBAdapter) => Promise<T>): Promise<T> {
    return this.sql.begin(async (tx) => {
      const txAdapter = new PostgresTxAdapter(tx as unknown as ReturnType<typeof postgres>);
      return fn(txAdapter);
    }) as unknown as Promise<T>;
  }

  async commit(statements: { sql: string; params?: unknown[] }[]): Promise<number[]> {
    return this.transaction(async (tx) => {
      const counts: number[] = [];
      for (const statement of statements) {
        counts.push((await tx.execute(statement.sql, statement.params ?? [])).rowsAffected);
      }
      return counts;
    });
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}

/**
 * Adapter scoped to an open transaction.
 *
 * `postgres` gives `sql.begin()` its own handle; call sites inside a
 * transaction must use this adapter or their writes land outside it. Nested
 * `transaction()` is rejected because it needs savepoints and nothing here
 * composes transactions that way.
 * 事务内必须用回调适配器，否则写入不在事务里；嵌套事务未使用，直接拒绝。
 */
class PostgresTxAdapter implements DBAdapter {
  readonly type: DBType = 'postgres';

  constructor(private tx: ReturnType<typeof postgres>) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const rows = await this.tx.unsafe(sql, params as never[]);
    return rows as unknown as T[];
  }

  async queryOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  async execute(sql: string, params: unknown[] = []): Promise<ExecuteResult> {
    const r = await this.tx.unsafe(sql, params as never[]);
    return {
      rowsAffected: r.count ?? 0,
      lastInsertId: undefined,
    };
  }

  async transaction<T>(_fn: (tx: DBAdapter) => Promise<T>): Promise<T> {
    throw new Error(
      'PostgresTxAdapter.transaction: nested transactions are not supported - ' +
        'compose the writes inside the outer callback instead',
    );
  }

  async commit(_statements: { sql: string; params?: unknown[] }[]): Promise<number[]> {
    throw new Error('PostgresTxAdapter.commit is unsupported inside a transaction');
  }
}
