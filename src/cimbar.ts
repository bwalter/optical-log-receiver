// Receiver for cimbar color codes (https://github.com/sz3/libcimbar), using libcimbar's WebAssembly decoder in
// public/cimbar/ (MPL-2.0). Camera frames are decoded by a pool of workers; the fountain chunks they find are
// assembled and decompressed by a single "sink" worker.

/** Header of the fountain chunks, shared by all chunks of a file. */
export interface ChunkHeader {
  encodeId: number;
  /** Size of the transferred (compressed) file. */
  size: number;
}

export interface CimbarCallbacks {
  /** A decoding worker finished a frame: whether it found a code, and the fountain chunks read from it. */
  onFrame(found: boolean, bytes: number, header: ChunkHeader | null): void;
  /** Fountain decoding progress of the files being received, from 0 to 1. */
  onProgress(progress: number[]): void;
  onDone(name: string, bytes: Uint8Array): void;
  onError(message: string): void;
  /** A frame could not be decoded (e.g. unsupported camera frame format). */
  onFrameError?(message: string): void;
}

/** cimbar mode ids: Bm (1024×720, sender on wide displays), Bu (736×637), B (1024×1024). */
const MODES = [67, 66, 68];

interface Slot {
  worker: Worker;
  busy: boolean;
}

type FramePath = "videoFrame" | "bitmap";
type FrameMessage = {
  type: "frame";
  found: boolean;
  mode: number;
  via: FramePath;
  chunks?: Uint8Array;
  message?: string;
};
type SinkMessage =
  | { type: "progress"; progress: number[] }
  | { type: "done"; name: string; bytes: Uint8Array }
  | { type: "error"; message: string };

const workerUrl = `${import.meta.env.BASE_URL}cimbar/cimbar-worker.js`;

export class CimbarReceiver {
  private readonly slots: Slot[] = [];
  private readonly sink: Worker;
  /** Detected sender mode, 0 while unknown: frames are then tried with each mode in turn. */
  private mode = 0;
  private attempt = 0;
  /**
   * How camera frames are passed to the workers. VideoFrame (native YUV, no conversion) is preferred, but camera frames
   * differ between browsers, so until a code is found both paths are tried in turn; the first one finding a code wins.
   */
  private path: FramePath | null = typeof VideoFrame !== "undefined" ? null : "bitmap";
  private submitted = 0;

  constructor(
    workerCount: number,
    private readonly callbacks: CimbarCallbacks,
  ) {
    for (let i = 0; i < workerCount; i++) {
      const slot: Slot = { worker: new Worker(workerUrl), busy: false };
      slot.worker.onmessage = (e: MessageEvent<FrameMessage>) => {
        slot.busy = false;
        this.onFrame(e.data);
      };
      slot.worker.onerror = (e) => {
        slot.busy = false;
        callbacks.onFrameError?.(`worker: ${e.message || "failed to load"}`);
      };
      this.slots.push(slot);
    }
    this.sink = new Worker(workerUrl);
    this.sink.onerror = (e) => callbacks.onError(`Decoder failed: ${e.message || "failed to load"}`);
    this.sink.onmessage = (e: MessageEvent<SinkMessage>) => {
      const data = e.data;
      if (data.type === "progress") callbacks.onProgress(data.progress);
      else if (data.type === "done") callbacks.onDone(data.name, data.bytes);
      else callbacks.onError(data.message);
    };
  }

  /** Starts decoding the current video frame, unless all workers are busy. */
  async submit(video: HTMLVideoElement): Promise<void> {
    const slot = this.slots.find((s) => !s.busy);
    if (!slot || video.readyState < 2 || video.videoWidth === 0) return;
    slot.busy = true;
    const mode = this.mode || MODES[this.attempt++ % MODES.length];
    try {
      const path = this.path ?? (this.submitted++ % 2 === 0 ? "videoFrame" : "bitmap");
      if (path === "videoFrame") {
        try {
          const frame = new VideoFrame(video, { timestamp: 0 });
          slot.worker.postMessage({ type: "frame", mode, frame }, [frame]);
          return;
        } catch {
          this.path = "bitmap";
        }
      }
      const bitmap = await createImageBitmap(video);
      slot.worker.postMessage(
        { type: "frame", mode, bitmap, width: bitmap.width, height: bitmap.height },
        [bitmap],
      );
    } catch {
      slot.busy = false;
    }
  }

  /** Forgets the detected mode and any partially received file. */
  reset(): void {
    this.mode = 0;
    this.sink.postMessage({ type: "reset" });
  }

  dispose(): void {
    for (const slot of this.slots) slot.worker.terminate();
    this.sink.terminate();
  }

  private onFrame(data: FrameMessage): void {
    if (data.message) this.callbacks.onFrameError?.(`${data.via}: ${data.message}`);
    if (data.found && this.path === null) this.path = data.via;
    const chunks = data.chunks;
    const bytes = chunks?.length ?? 0;
    const header = chunks && bytes >= 6 ? parseHeader(chunks) : null;
    this.callbacks.onFrame(data.found, bytes, header);
    if (!chunks || bytes === 0) return;
    this.mode = data.mode;
    this.sink.postMessage({ type: "chunks", mode: data.mode, chunks }, [chunks.buffer]);
  }
}

function parseHeader(chunk: Uint8Array): ChunkHeader {
  const [b0 = 0, b1 = 0, b2 = 0, b3 = 0] = chunk;
  return { encodeId: b0 & 0x7f, size: ((b0 & 0x80) << 17) | (b1 << 16) | (b2 << 8) | b3 };
}
