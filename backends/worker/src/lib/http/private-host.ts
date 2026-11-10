/**
 * Whether an anonymous fetch must refuse this host.
 *
 * Narrower than "can be monitored": internal targets are valid monitors, but
 * the icon proxy hands bytes to any visitor, so a private host would turn the
 * status page into a LAN reader. It checks the literal host only; a public name
 * resolving to `10.0.0.5` passes here, which is why redirects are re-checked
 * and the feature is off by default.
 * 只拦截字面私网主机；公开域名解析到内网需靠重定向复查和默认关闭。
 */

/** Hostnames that mean "this machine" or a name that never leaves the host. / 表示“本机”或不会离开主机的名称。 */
const LOCAL_NAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback']);

/** Suffixes that are private by definition (RFC 6761 / 6762). / 按定义为私有的后缀（RFC 6761 / 6762）。 */
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

function parseIPv4(host: string): [number, number, number, number] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  return octets as [number, number, number, number];
}

function isPrivateIPv4([a, b]: [number, number, number, number]): boolean {
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;         // link-local, cloud metadata / 链路本地、云元数据
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT / 运营商级 NAT
  if (a >= 224) return true;                        // multicast, reserved / 多播、保留地址
  return false;
}

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === '') return true;

  if (LOCAL_NAMES.has(host)) return true;
  if (LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;

  const v4 = parseIPv4(host);
  if (v4) return isPrivateIPv4(v4);

  // IPv6: loopback, unspecified, unique-local (fc00::/7), link-local (fe80::/10).
  // IPv6：回环、未指定、唯一本地（fc00::/7）和链路本地（fe80::/10）地址。
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
    // IPv4-mapped (::ffff:10.0.0.1) - unwrap and check the tail.
    // IPv4 映射地址（::ffff:10.0.0.1）：提取并检查尾部。
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    if (mapped) {
      const inner = parseIPv4(mapped[1]);
      if (inner) return isPrivateIPv4(inner);
    }
    return false;
  }

  return false;
}
