import type { MonitorTag } from './types';

/** Default resolver shared with the Worker's DNS add-on and shown in the form placeholder. / 与 Worker 的 DNS 附加项共用的默认解析器，也显示在表单占位符中。 */
export const DEFAULT_DOH_RESOLVER = 'https://cloudflare-dns.com/dns-query';

/** Read an option object; malformed, absent or non-object JSON yields {}. Fields are not validated here. / 读取选项对象；JSON 无效、缺失或不是对象时返回 {}，此处不校验字段。 */
export function parseOptions<T>(json: string | null | undefined): T {
  if (!json) return {} as T;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {} as T;
    return parsed as T;
  } catch {
    return {} as T;
  }
}

/** Prefer the tag UUID over the join-row id; standalone tag rows only have id. / 优先使用标签 UUID 而非关联行 ID；独立标签行只有 id。 */
export function tagKey(tag: MonitorTag): string {
  return String(tag.tag_id ?? tag.id);
}

/** Push credential URL on the current origin; treat it as a secret. / 当前源上的 Push 凭据 URL；应作为密钥处理。 */
export function pushEndpointUrl(token: string | null | undefined): string {
  if (!token) return '';
  return `${window.location.origin}/api/public/push/${token}`;
}
