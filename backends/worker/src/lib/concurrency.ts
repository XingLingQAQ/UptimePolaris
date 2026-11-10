/** Run at most limit jobs concurrently and return settled results in input order. / 最多并发运行 limit 个任务，按输入顺序返回已完成的结果。 */
export async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        out[i] = { status: 'fulfilled', value: await fn(items[i]) };
      } catch (e) {
        out[i] = { status: 'rejected', reason: e };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
