/**
 * Minimal ZIP reader for theme packages.
 *
 * Hand-rolled because Workers expose `DecompressionStream('deflate-raw')` but
 * no filesystem, so Node and browser unzip libraries do not apply. It rejects
 * ZIP64, encrypted entries, unsupported methods and bad CRCs by name, so a
 * truncated download fails here instead of half-rendering a theme.
 * Worker 只有 DecompressionStream 没有文件系统；ZIP64、加密、未知方法和 CRC 错误都明确拒绝。
 */

/** Raised for a package this reader will not or cannot process. / 读取器拒绝或无法处理主题包时抛出。 */
export class ZipError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ZipError';
  }
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** Signatures, little-endian, as they appear in a byte stream. / 字节流中以小端序表示的签名。 */
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/** Refuse anything absurd before allocating for it. / 分配内存前拒绝明显异常的输入。 */
const MAX_ENTRIES = 2000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/** A DataView over the whole buffer, for the little-endian reads below. / 覆盖整个缓冲区的 DataView，供后续小端读取使用。 */
function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Scan backwards for the EOCD, bounded by the max comment length. / 从尾部查找 EOCD，扫描范围限制在最大注释长度内。 */
function findEocd(bytes: Uint8Array): number {
  const dv = view(bytes);
  const min = Math.max(0, bytes.length - 65535 - 22);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) return i;
  }
  return -1;
}

/** Detect ZIP64 by its locator and refuse it by name. / 识别 ZIP64 定位器并明确拒绝。 */
function assertNotZip64(bytes: Uint8Array, eocd: number): void {
  const dv = view(bytes);
  // The locator is a fixed 20-byte record immediately before the EOCD.
  // 定位器是紧邻 EOCD 之前的固定 20 字节记录。
  const at = eocd - 20;
  if (at >= 0 && dv.getUint32(at, true) === SIG_EOCD64_LOCATOR) {
    throw new ZipError(
      'this ZIP uses ZIP64 (it has more than 4 GB or 65535 files); repackage it as a normal ZIP',
      'zip64_unsupported',
    );
  }
}

/** CRC-32, table built once on first use. / CRC-32；查找表在首次使用时构建一次。 */
let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = crcTable[(c ^ bytes[i]) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Inflate a raw deflate stream.
 *
 * Wrapped in a `Blob` because `DecompressionStream` takes a stream. The slice
 * is copied first: a `subarray` view would carry the whole archive into each
 * Blob, and a 30 MB package with 200 entries would copy it 200 times.
 * 先复制切片；视图会让每个条目都携带整个归档，可能耗尽内存。
 */
async function inflateRaw(data: Uint8Array, maxOutputBytes: number): Promise<Uint8Array> {
  const owned = new Uint8Array(data.length);
  owned.set(data);

  const reader = new Blob([owned]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxOutputBytes) {
      await reader.cancel();
      throw new ZipError('package expands beyond the configured size limit', 'too_large');
    }
    chunks.push(value);
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/**
 * Normalise entry names: backslashes to slashes, strip a leading `./`.
 *
 * Windows' Compress-Archive writes `dist\index.html`; that becomes an R2 key
 * and a URL path, and a backslash there makes every asset 404. Normalise
 * rather than reject — the package is valid, the separator is not.
 * Windows 压缩工具会写反斜杠；不转换会让主题资源全部 404。
 */
export function normalizeEntryName(name: string): string {
  let out = name.replace(/\\/g, '/');
  while (out.startsWith('./')) out = out.slice(2);
  // Collapse any doubled separators a packager left behind.
  // 合并打包工具留下的重复分隔符。
  out = out.replace(/\/{2,}/g, '/');
  return out;
}

/** Read all entries; directory markers ending in `/` are skipped. / 读取全部条目；跳过以 `/` 结尾的目录标记。 */
export async function readZip(bytes: Uint8Array, limits: { maxEntries?: number; maxTotalBytes?: number } = {}): Promise<ZipEntry[]> {
  if (bytes.length < 22) {
    throw new ZipError('file is too small to be a ZIP', 'not_a_zip');
  }

  const eocd = findEocd(bytes);
  if (eocd < 0) {
    throw new ZipError(
      'no ZIP end-of-central-directory record found; is this a ZIP file?',
      'not_a_zip',
    );
  }
  assertNotZip64(bytes, eocd);

  const dv = view(bytes);
  const entryCount = dv.getUint16(eocd + 10, true);
  const centralOffset = dv.getUint32(eocd + 16, true);
  const maxEntries = Math.min(limits.maxEntries ?? MAX_ENTRIES, MAX_ENTRIES);
  const maxTotalBytes = Math.min(limits.maxTotalBytes ?? MAX_TOTAL_BYTES, MAX_TOTAL_BYTES);

  if (entryCount > maxEntries) {
    throw new ZipError(`too many entries (${entryCount}, limit ${maxEntries})`, 'too_many_entries');
  }
  if (centralOffset >= bytes.length) {
    throw new ZipError('central directory offset is past the end of the file', 'corrupt');
  }

  const entries: ZipEntry[] = [];
  let total = 0;
  let p = centralOffset;

  let scan = centralOffset;
  let declaredTotal = 0;
  for (let i = 0; i < entryCount; i++) {
    if (scan + 46 > bytes.length || dv.getUint32(scan, true) !== SIG_CENTRAL) {
      throw new ZipError(`central directory entry ${i} is invalid`, 'corrupt');
    }
    const nameLength = dv.getUint16(scan + 28, true);
    const extraLength = dv.getUint16(scan + 30, true);
    const commentLength = dv.getUint16(scan + 32, true);
    const size = dv.getUint32(scan + 24, true);
    const name = normalizeEntryName(new TextDecoder().decode(bytes.subarray(scan + 46, scan + 46 + nameLength)));
    scan += 46 + nameLength + extraLength + commentLength;
    if (!name.endsWith('/')) declaredTotal += size;
    if (declaredTotal > maxTotalBytes) throw new ZipError(`package expands beyond ${maxTotalBytes} bytes`, 'too_large');
  }

  for (let i = 0; i < entryCount; i++) {
    if (p + 46 > bytes.length) {
      throw new ZipError(`central directory entry ${i} runs past the end of the file`, 'corrupt');
    }
    if (dv.getUint32(p, true) !== SIG_CENTRAL) {
      throw new ZipError(`central directory entry ${i} has a bad signature`, 'corrupt');
    }

    const method = dv.getUint16(p + 10, true);
    const expectedCrc = dv.getUint32(p + 16, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const uncompressedSize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const flags = dv.getUint16(p + 8, true);

    const rawName = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const name = normalizeEntryName(rawName);
    p += 46 + nameLen + extraLen + commentLen;

    // Directory marker: no data of its own.
    // 目录标记本身不含数据。
    if (name.endsWith('/')) continue;

    // Bit 0 of the flags means the entry is encrypted. Refused rather than
    // attempted: the bytes would inflate to noise and the CRC check below
    // would report it as corruption, which is the wrong diagnosis.
    // 标志位 0 表示加密条目。直接拒绝，否则解压会产生乱码，后续 CRC 检查会误报损坏。
    if (flags & 0x1) {
      throw new ZipError(`"${name}" is encrypted; repackage it without a password`, 'encrypted');
    }

    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      throw new ZipError(
        `"${name}" uses compression method ${method}; only stored (0) and deflate (8) are supported`,
        'unsupported_method',
      );
    }

    if (localOffset + 30 > bytes.length) {
      throw new ZipError(`"${name}" has a local header past the end of the file`, 'corrupt');
    }
    if (dv.getUint32(localOffset, true) !== SIG_LOCAL) {
      throw new ZipError(`"${name}" has a bad local header signature`, 'corrupt');
    }

    /** Use the local header's name/extra lengths, not the central directory's. / 使用本地头的名称/扩展长度，不用中央目录的。 */
    const localNameLen = dv.getUint16(localOffset + 26, true);
    const localExtraLen = dv.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;

    if (dataStart + compressedSize > bytes.length) {
      throw new ZipError(`"${name}" claims more data than the file contains`, 'truncated');
    }

    const raw = bytes.subarray(dataStart, dataStart + compressedSize);
    let data: Uint8Array;
    if (method === METHOD_STORED) {
      data = raw;
    } else {
      try {
        data = await inflateRaw(raw, maxTotalBytes - total);
      } catch (error) {
        if (error instanceof ZipError) throw error;
        throw new ZipError(`"${name}" could not be decompressed; the file may be truncated`, 'inflate_failed');
      }
    }

    if (uncompressedSize !== 0 && data.length !== uncompressedSize) {
      throw new ZipError(
        `"${name}" inflated to ${data.length} bytes, expected ${uncompressedSize}`,
        'size_mismatch',
      );
    }

    /** Verify CRC; this catches truncated downloads. / 校验 CRC，捕获截断的下载。 */
    if (expectedCrc !== 0 && crc32(data) !== expectedCrc) {
      throw new ZipError(`"${name}" failed its CRC check; the download is corrupt`, 'crc_mismatch');
    }

    total += data.length;
    if (total > maxTotalBytes) {
      throw new ZipError(
        `package expands to more than ${maxTotalBytes / 1024 / 1024} MB`,
        'too_large',
      );
    }

    entries.push({ name, data });
  }

  return entries;
}
