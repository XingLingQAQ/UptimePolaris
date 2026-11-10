export function udpPacketOptions(options: { send?: unknown; expect?: unknown; encoding?: unknown }): { payload: Uint8Array; expected: Uint8Array } | null {
  const encoding = options.encoding ?? 'text';
  if (encoding !== 'text' && encoding !== 'hex') return null;
  const decode = (value: unknown): Uint8Array | null => {
    if (typeof value !== 'string') return null;
    if (encoding === 'hex') {
      const compact = value.replace(/\s/g, '');
      if (!/^(?:[0-9a-fA-F]{2})*$/.test(compact) || compact.length > 8192) return null;
      return Uint8Array.from(compact.match(/../g) ?? [], byte => parseInt(byte, 16));
    }
    const bytes = new TextEncoder().encode(value);
    return bytes.length <= 4096 ? bytes : null;
  };
  const payload = decode(options.send ?? 'ping');
  const expected = decode(options.expect ?? '');
  return payload && payload.length > 0 && expected ? { payload, expected } : null;
}
