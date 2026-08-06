import { inflateRawSync } from 'zlib';

/**
 * Sprint 6.2.4 — Dependency-free ZIP reader.
 *
 * ICICI Direct (Breeze SecurityMaster.zip) and Shoonya (`<EXCH>_symbols.txt.zip`)
 * publish their instrument masters as ZIP archives, whereas Zerodha/Fyers serve
 * plain CSV. Rather than add a new runtime dependency, we parse the ZIP central
 * directory directly and inflate each entry with Node's built-in `zlib`
 * (DEFLATE = method 8; STORED = method 0). This covers every entry produced by
 * the broker security-master tooling.
 */

export interface ZipEntry {
  name: string;
  data: Buffer;
}

const EOCD_SIG = 0x06054b50; // End of Central Directory
const CDH_SIG = 0x02014b50; // Central Directory File Header

export function extractZipEntries(buf: Buffer): ZipEntry[] {
  // The EOCD lives at the tail of the archive; scan backwards for its
  // signature (the trailing comment is almost always empty for these files).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('Invalid ZIP archive: End of Central Directory not found');
  }

  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  const entries: ZipEntry[] = [];
  let p = cdOffset;

  for (let n = 0; n < entryCount; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CDH_SIG) break;

    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // Skip directory entries.
    if (!name.endsWith('/')) {
      // The local file header repeats the name/extra lengths; use them to
      // locate the compressed payload (the central directory's compressed
      // size is authoritative even when a data descriptor is used).
      const lhNameLen = buf.readUInt16LE(localOffset + 26);
      const lhExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
      const compData = buf.subarray(dataStart, dataStart + compSize);

      let data: Buffer;
      if (method === 0) {
        data = Buffer.from(compData);
      } else if (method === 8) {
        data = inflateRawSync(compData);
      } else {
        throw new Error(
          `Unsupported ZIP compression method ${method} for entry "${name}"`,
        );
      }
      entries.push({ name, data });
    }

    p += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}
