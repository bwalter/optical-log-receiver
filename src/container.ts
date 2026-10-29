// Decimen "DCF2" file container (filename, media type, optional gzip, SHA-256).
// Layout (little-endian), 49-byte header:
//   0 "DCF2" · 4 u8 gzip · 5 u16 nameLen · 7 u16 typeLen · 9 u32 fileLen
//   13 u32 transmittedLen · 17 [32] sha256 · 49 name · type · data

const HEADER_LEN = 49;
const MAGIC = [0x44, 0x43, 0x46, 0x32];
export const MAX_BYTES = 64 * 1024 * 1024;

export function isContainer(bytes: Uint8Array): boolean {
  return bytes.length >= HEADER_LEN && MAGIC.every((m, i) => bytes[i] === m);
}

async function gunzip(bytes: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Decompressed data exceeds declared size.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Unpacks and SHA-256-verifies a DCF2 container, returning the original file bytes. */
export async function unpackContainer(container: Uint8Array): Promise<Uint8Array> {
  const view = new DataView(container.buffer, container.byteOffset, container.byteLength);
  const gzip = view.getUint8(4);
  if (gzip > 1) throw new Error("Unknown container compression.");
  const nameLen = view.getUint16(5, true);
  const typeLen = view.getUint16(7, true);
  const fileLen = view.getUint32(9, true);
  const txLen = view.getUint32(13, true);
  const dataOff = HEADER_LEN + nameLen + typeLen;
  if (fileLen === 0 || fileLen > MAX_BYTES || txLen === 0 || dataOff + txLen !== container.length) {
    throw new Error("Container length mismatch.");
  }
  const data = container.slice(dataOff);
  const bytes = gzip === 1 ? await gunzip(data, fileLen) : data;
  if (bytes.length !== fileLen) throw new Error("Container size mismatch.");

  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  const expected = container.subarray(17, 49);
  if (!digest.every((v, i) => v === expected[i])) throw new Error("SHA-256 verification failed.");
  return bytes;
}
