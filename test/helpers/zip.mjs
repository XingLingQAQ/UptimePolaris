/* 构造不压缩的 ZIP，精确控制正常和损坏条目，无需外部归档工具。
 * Build stored ZIP fixtures with controlled valid or malformed entries without an external archive tool. */

/** CRC-32, the checksum a ZIP entry carries. / ZIP 条目携带的 CRC-32 校验值。 */
function crc32(bytes) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * @param {Record<string, string | Uint8Array>} files  path -> contents
 * @param {{ separator?: string, extraEntries?: Record<string, string> }} [opts]
 *   `separator` rewrites path separators, which is how the Windows-shaped
 *   fixture is built on any platform.
 * files 将路径映射到字符串或字节内容；opts.separator 可替换路径分隔符，以便在任意平台构造 Windows 形态的测试样本。
 * opts.extraEntries 可添加额外条目。
 */
export function makeStoredZip(files, opts = {}) {
  const { separator = '/', extraEntries = {} } = opts;
  const all = { ...files, ...extraEntries };

  const encoder = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [rawName, content] of Object.entries(all)) {
    const name = separator === '/' ? rawName : rawName.split('/').join(separator);
    const nameBytes = encoder.encode(name);
    const data = typeof content === 'string' ? encoder.encode(content) : content;
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header / 本地文件头
    lv.setUint16(4, 20, true); // version needed / 所需版本
    lv.setUint16(6, 0, true); // flags / 标志位
    lv.setUint16(8, 0, true); // method: stored / 存储方式：不压缩
    lv.setUint16(10, 0, true); // mod time / 修改时间
    lv.setUint16(12, 0, true); // mod date / 修改日期
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); // compressed / 压缩后大小
    lv.setUint32(22, data.length, true); // uncompressed / 未压缩大小
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra length / 附加字段长度
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory header / 中央目录头
    cv.setUint16(4, 20, true); // version made by / 创建版本
    cv.setUint16(6, 20, true); // version needed / 所需版本
    cv.setUint16(8, 0, true); // flags / 标志位
    cv.setUint16(10, 0, true); // method / 存储方式
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true); // local header offset / 本地文件头偏移
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true); // entries on this disk / 此磁盘条目数
  ev.setUint16(10, centrals.length, true); // entries total / 总条目数
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true); // central directory offset / 中央目录偏移

  const total = offset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const l of locals) {
    out.set(l, p);
    p += l.length;
  }
  for (const c of centrals) {
    out.set(c, p);
    p += c.length;
  }
  out.set(eocd, p);
  return out;
}
