import { prepareZXingModule, readBarcodes, type ReaderOptions } from "zxing-wasm/reader";
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";

// Self-hosted WASM so the app works offline (default would fetch from a CDN).
const ready = prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path),
  },
  fireImmediately: true,
});

const options: ReaderOptions = {
  formats: ["QRCode"],
  tryHarder: true,
  tryRotate: false,
  tryInvert: false,
  maxNumberOfSymbols: 9,
};

let canvas: OffscreenCanvas | undefined;

self.onmessage = async (e: MessageEvent<{ id: number; bitmap: ImageBitmap }>) => {
  const { id, bitmap } = e.data;
  const codes: Uint8Array[] = [];
  try {
    await ready;
    const { width, height } = bitmap;
    if (!canvas || canvas.width !== width || canvas.height !== height) canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    const results = await readBarcodes(ctx.getImageData(0, 0, width, height), options);
    for (const r of results) if (r.isValid && r.bytes.length > 0) codes.push(r.bytes);
  } catch {
    // a failed frame is just a dropped frame
  } finally {
    bitmap.close();
  }
  self.postMessage({ id, codes }, { transfer: codes.map((c) => c.buffer as ArrayBuffer) });
};

void ready.then(() => self.postMessage({ id: -1, codes: [] }));
