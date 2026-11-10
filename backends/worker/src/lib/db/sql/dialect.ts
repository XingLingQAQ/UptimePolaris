/**
 * Rewrite a caller-built `IN (?,...)` list to Postgres `$n`.
 *
 * Call sites stay backend-agnostic: they build `'?,?,?'` and pass it here; the
 * count is the only information needed. Static SQL is written per dialect in
 * the table files; only the variable-arity IN goes through this helper.
 * 调用方构造 `IN` 占位符，这里只按数量改写；静态 SQL 仍按方言分别维护。
 */
export function pgPlaceholders(d1Placeholders: string): string {
  const n = (d1Placeholders.match(/\?/g) ?? []).length;
  return Array.from({ length: n }, (_, i) => `$${i + 1}`).join(',');
}

/**
 * Positional token for a backend: `?` on D1, `$i` on Postgres.
 *
 * Used by callers that build a variable number of `SET col = <token>` clauses;
 * the binding rules live here so two engines render them in one place.
 * 供可变数量的 SET 子句使用；两个引擎的绑定规则集中在这里。
 */
export function placeholderFor(dbType: 'd1' | 'postgres', position: number): string {
  return dbType === 'postgres' ? `$${position}` : '?';
}
