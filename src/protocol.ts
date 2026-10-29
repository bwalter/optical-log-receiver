// Decimen wire format v3 receiver side: frame header parsing and the
// systematic-carousel fountain decoder. Must stay bit-compatible with
// https://github.com/bashalarmistalt/decimen-optical-transfer (shared/protocol.ts, shared/fountain.ts).

export const HEADER_LEN = 22;
const MAGIC0 = 0xd1;
const MAGIC1 = 0xc3;
const WIRE_VERSION = 3;
const CRITICAL_FLAGS = 0x0f;

export interface FrameHeader {
  flags: number;
  sessionId: number;
  seq: number;
  k: number;
  blockLen: number;
  totalLen: number;
  payloadFnv: number;
}

export type ParseResult =
  | { ok: true; header: FrameHeader; block: Uint8Array }
  | { ok: false; reason: "foreign" | "malformed" | "unsupported"; message?: string };

const LEGACY_MAGIC1: Record<number, number> = { 0x0c: 1, 0x0d: 2 };

export function parseFrame(bytes: Uint8Array): ParseResult {
  if (bytes.length < 4 || bytes[0] !== MAGIC0) return { ok: false, reason: "foreign" };
  if (bytes[1] !== MAGIC1) {
    const legacy = LEGACY_MAGIC1[bytes[1]!];
    return legacy === undefined
      ? { ok: false, reason: "foreign" }
      : { ok: false, reason: "unsupported", message: `Sender uses old Decimen format v${legacy}. Update the sender.` };
  }
  const version = bytes[2]!;
  if (version !== WIRE_VERSION) {
    return { ok: false, reason: "unsupported", message: `Sender uses Decimen format v${version}; this app supports v${WIRE_VERSION}.` };
  }
  if ((bytes[3]! & CRITICAL_FLAGS) !== 0) {
    return { ok: false, reason: "unsupported", message: "Sender uses an unsupported Decimen feature (e.g. encryption)." };
  }
  if (bytes.length <= HEADER_LEN) return { ok: false, reason: "malformed" };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header: FrameHeader = {
    flags: bytes[3]!,
    sessionId: dv.getUint16(4, true),
    seq: dv.getUint32(6, true),
    k: dv.getUint16(10, true),
    blockLen: dv.getUint16(12, true),
    totalLen: dv.getUint32(14, true),
    payloadFnv: dv.getUint32(18, true),
  };
  if (header.k === 0 || header.blockLen === 0 || header.totalLen === 0) return { ok: false, reason: "malformed" };
  if (bytes.length !== HEADER_LEN + header.blockLen) return { ok: false, reason: "malformed" };
  if (header.totalLen > header.k * header.blockLen) return { ok: false, reason: "malformed" };
  return { ok: true, header, block: bytes.subarray(HEADER_LEN) };
}

/** Everything that must stay constant within one stream (seq excluded). */
export function streamIdentity(h: FrameHeader): string {
  return `${h.sessionId}:${h.k}:${h.blockLen}:${h.totalLen}:${h.payloadFnv}:${h.flags & CRITICAL_FLAGS}`;
}

export function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function splitmix32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x9e3779b9) | 0;
    let t = s ^ (s >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return t >>> 0;
  };
}

function frameSeed(sessionId: number, seq: number): number {
  let h = (Math.imul(sessionId + 1, 0x9e3779b1) ^ (seq + 0x85ebca6b)) | 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) | 0;
}

const REPAIR_DEGREE_MIN = 4;
const REPAIR_DEGREE_MAX = 24;

/** Block indices XORed into frame `seq`: a systematic sweep of k blocks, then k repair frames. */
function frameComposition(k: number, sessionId: number, seq: number): number[] {
  const pos = seq % (2 * k);
  if (pos < k) return [pos];
  const rnd = splitmix32(frameSeed(sessionId, seq));
  const d = Math.min(k, REPAIR_DEGREE_MIN + (rnd() % (REPAIR_DEGREE_MAX - REPAIR_DEGREE_MIN + 1)));
  const set = new Set<number>();
  while (set.size < d) set.add(rnd() % k);
  return [...set];
}

function xorInto(dst: Uint32Array, src: Uint32Array): void {
  for (let i = 0; i < dst.length; i++) dst[i] = dst[i]! ^ src[i]!;
}

interface PendingFrame {
  idx: Set<number>;
  words: Uint32Array;
}

/** Peeling LT decoder for the carousel stream. */
export class FountainDecoder {
  private readonly words: number;
  private readonly solved: (Uint32Array | null)[];
  private readonly byBlock = new Map<number, Set<PendingFrame>>();
  private readonly seen = new Set<number>();
  solvedCount = 0;
  usefulFrames = 0;

  constructor(readonly header: FrameHeader) {
    this.words = Math.ceil(header.blockLen / 4);
    this.solved = new Array<Uint32Array | null>(header.k).fill(null);
  }

  get k(): number {
    return this.header.k;
  }

  get isComplete(): boolean {
    return this.solvedCount >= this.header.k;
  }

  addFrame(seq: number, block: Uint8Array): void {
    if (this.isComplete || this.seen.has(seq)) return;
    this.seen.add(seq);

    const idx = new Set(frameComposition(this.header.k, this.header.sessionId, seq));
    const words = new Uint32Array(this.words);
    new Uint8Array(words.buffer).set(block.subarray(0, this.header.blockLen));
    for (const b of [...idx]) {
      const s = this.solved[b];
      if (s) {
        xorInto(words, s);
        idx.delete(b);
      }
    }
    if (idx.size === 0) return;
    this.usefulFrames++;
    if (idx.size === 1) {
      this.resolve(idx.values().next().value!, words);
      return;
    }
    const pf: PendingFrame = { idx, words };
    for (const b of idx) {
      let set = this.byBlock.get(b);
      if (!set) this.byBlock.set(b, (set = new Set()));
      set.add(pf);
    }
  }

  private resolve(b0: number, w0: Uint32Array): void {
    const queue: [number, Uint32Array][] = [[b0, w0]];
    while (queue.length > 0) {
      const [b, w] = queue.pop()!;
      if (this.solved[b]) continue;
      this.solved[b] = w;
      this.solvedCount++;
      const waiting = this.byBlock.get(b);
      if (!waiting) continue;
      this.byBlock.delete(b);
      for (const pf of waiting) {
        xorInto(pf.words, w);
        pf.idx.delete(b);
        if (pf.idx.size === 1) {
          const r = pf.idx.values().next().value!;
          this.byBlock.get(r)?.delete(pf);
          if (!this.solved[r]) queue.push([r, pf.words]);
        }
      }
    }
  }

  assemble(): Uint8Array | null {
    if (!this.isComplete) return null;
    const { k, blockLen, totalLen } = this.header;
    const out = new Uint8Array(totalLen);
    for (let b = 0; b < k; b++) {
      const start = b * blockLen;
      const len = Math.min(blockLen, totalLen - start);
      if (len > 0) out.set(new Uint8Array(this.solved[b]!.buffer, 0, len), start);
    }
    return out;
  }
}
