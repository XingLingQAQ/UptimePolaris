function isNonCanonicalIPv4(host: string): boolean {
  const name = host.endsWith('.') ? host.slice(0, -1) : host;
  return /^\d+(\.\d+){3}$/.test(name) &&
    name.split('.').some((part) => part.length > 1 && part.startsWith('0'));
}

/** URL 解析前检查前导零 IPv4，避免规范化后丢失原始写法。 / Check leading-zero IPv4 before URL parsing loses the original spelling. */
export function hasNonCanonicalHttpIPv4(target: string): boolean {
  const authority = target.replace(/[\t\n\r]/g, '').match(/^https?:[\/\\]+([^/\\?#]*)/i)?.[1];
  if (!authority) return false;
  const host = authority.slice(authority.lastIndexOf('@') + 1).split(':')[0];
  try {
    return isNonCanonicalIPv4(decodeURIComponent(host));
  } catch {
    return false;
  }
}

export function isMonitorHostname(host: string): boolean {
  if (!host) return false;
  if (host.includes(':')) {
    try {
      new URL(`http://[${host}]/`);
      return true;
    } catch {
      return false;
    }
  }
  const name = host.endsWith('.') ? host.slice(0, -1) : host;
  if (/^\d+(\.\d+){3}$/.test(name)) {
    return !isNonCanonicalIPv4(name) && name.split('.').every((part) => part.length <= 3 && Number(part) <= 255);
  }
  const labels = name.split('.');
  if (name.length > 253 || !labels.every((label) =>
    label.length <= 63 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(label))) return false;
  try {
    for (const label of labels) {
      if (/^xn--/i.test(label)) new URL(`http://${label}.invalid/`);
    }
    return true;
  } catch {
    return false;
  }
}
