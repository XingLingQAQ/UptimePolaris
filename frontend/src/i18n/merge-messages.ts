/**
 * Deep-merge message catalogs; later sources win on conflicts.
 *
 * A non-plain value (string, array, null) replaces a plain object wholesale.
 * Missing keys fall through to en-US, never rendering a raw key path or an
 * empty string.
 * 非对象值整体替换；缺失键回退到 en-US。
 */

type MessageValue = string | { [key: string]: MessageValue };
export type MessageTree = { [key: string]: MessageValue };

function isPlainObject(value: unknown): value is MessageTree {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

export function mergeMessages(base: MessageTree, override: MessageTree): MessageTree {
  const out: MessageTree = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = mergeMessages(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** fold a chain [lowest ← ... ← highest] into one catalog. / 将优先级链 [最低 ← ... ← 最高] 合并为一个语言包。 */
export function mergeChain(chain: MessageTree[]): MessageTree {
  return chain.reduce<MessageTree>((acc, layer) => mergeMessages(acc, layer), {});
}
