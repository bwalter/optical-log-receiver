// Classic worker wrapping libcimbar's WebAssembly receiver (cimbar_js.js / cimbar_js.wasm, MPL-2.0).
//
// The same script serves two roles, selected by the messages it receives:
// - "frame": finds the cimbar code in a camera frame and decodes its fountain chunks (one worker per CPU core).
// - "chunks": feeds fountain chunks to the fountain decoder and, once the file is complete, decompresses it (a
//   single worker, as the decoder state must be shared).
"use strict";

const pending = [];
let ready = false;
const buffers = {};
let sinkMode = 0;

self.Module = {
  print: () => {},
  printErr: () => {},
  onRuntimeInitialized: () => {
    ready = true;
    for (const data of pending.splice(0)) handle(data);
  },
};
importScripts("cimbar_js.js");

// Buffers are kept as { ptr, size }: wasm memory may grow on any call, which detaches typed array views.
function malloc(name, size) {
  let buffer = buffers[name];
  if (!buffer || buffer.size < size) {
    if (buffer) Module._free(buffer.ptr);
    buffer = { ptr: Module._malloc(size), size };
    buffers[name] = buffer;
  }
  return buffer;
}

function view(name) {
  const buffer = buffers[name];
  return new Uint8Array(Module.HEAPU8.buffer, buffer.ptr, buffer.size);
}

function report() {
  const buffer = malloc("report", 1024);
  const length = Module._cimbard_get_report(buffer.ptr, buffer.size);
  return length > 0 ? new TextDecoder().decode(view("report").subarray(0, length)) : "";
}

let canvas;
let context;

// Draws an ImageBitmap or VideoFrame and returns its RGBA pixels (the image is closed).
function toRgba(image, width, height) {
  if (!canvas || canvas.width !== width || canvas.height !== height) {
    canvas = new OffscreenCanvas(width, height);
    context = canvas.getContext("2d", { willReadFrequently: true });
  }
  try {
    context.drawImage(image, 0, 0, width, height);
  } finally {
    image.close();
  }
  return context.getImageData(0, 0, width, height).data;
}

function copyRgba(pixels, width, height) {
  malloc("image", pixels.length);
  view("image").set(pixels);
  return { format: "RGBA", width, height };
}

const FORMATS = { RGBA: 4, NV12: 12, I420: 420 };

// Copies a VideoFrame into the image buffer, natively (YUV) if the decoder supports its format. Frames without a
// readable format (iOS camera frames report none) are drawn on a canvas instead. copyTo() writes the
// visible rectangle without applying the frame's rotation (iOS camera frames in portrait are rotated by 90°, with
// swapped display sizes), so the visible rectangle gives the buffer's dimensions; the decoder handles any rotation.
async function copyVideoFrame(frame) {
  if (!frame.format) return copyRgba(toRgba(frame, frame.displayWidth, frame.displayHeight), frame.displayWidth, frame.displayHeight);
  try {
    const options = frame.format in FORMATS ? {} : { format: "RGBA" };
    const size = frame.allocationSize(options);
    malloc("image", size);
    await frame.copyTo(view("image").subarray(0, size), options);
    const rect = frame.visibleRect;
    return {
      format: options.format ?? frame.format,
      width: rect ? rect.width : frame.codedWidth,
      height: rect ? rect.height : frame.codedHeight,
    };
  } finally {
    frame.close();
  }
}

async function decodeFrame(data) {
  const via = data.frame ? "videoFrame" : "bitmap";
  let image;
  if (data.frame) {
    image = await copyVideoFrame(data.frame);
  } else {
    image = copyRgba(toRgba(data.bitmap, data.width, data.height), data.width, data.height);
  }
  Module._cimbard_configure_decode(data.mode);
  const fountainSize = Module._cimbard_get_bufsize();
  malloc("fountain", fountainSize);
  const length = Module._cimbard_scan_extract_decode(
    buffers.image.ptr,
    image.width,
    image.height,
    FORMATS[image.format] ?? 4,
    buffers.fountain.ptr,
    fountainSize,
  );
  if (length <= 0) {
    // 0: code found but no chunk decoded, -3: no code found
    self.postMessage({ type: "frame", found: length === 0, mode: data.mode, via });
    return;
  }
  const chunks = view("fountain").slice(0, length);
  self.postMessage({ type: "frame", found: true, mode: data.mode, via, chunks }, [chunks.buffer]);
}

// Drops partially received files: the decoder state is reset whenever the mode changes.
function reset() {
  Module._cimbard_configure_decode(sinkMode === 66 ? 67 : 66);
  sinkMode = 0;
}

function decodeChunks(data) {
  if (data.mode !== sinkMode) {
    sinkMode = data.mode;
    Module._cimbard_configure_decode(data.mode);
  }
  malloc("chunks", data.chunks.length);
  view("chunks").set(data.chunks);
  let result = Module._cimbard_fountain_decode(buffers.chunks.ptr, data.chunks.length);
  result = typeof result === "bigint" ? result : BigInt(result);
  const progressReport = report();
  let progress = [];
  try {
    progress = JSON.parse(progressReport);
  } catch {
    // not a progress report
  }
  if (result <= 0n) {
    self.postMessage({ type: "progress", progress });
    return;
  }

  const id = Number(result & 0xffffffffn);
  const nameBuffer = malloc("name", 512);
  const nameLength = Module._cimbard_get_filename(id, nameBuffer.ptr, nameBuffer.size);
  const name = nameLength > 0 ? new TextDecoder().decode(view("name").subarray(0, nameLength)) : "";
  const outSize = Module._cimbard_get_decompress_bufsize();
  malloc("out", outSize);
  const parts = [];
  let total = 0;
  for (;;) {
    const read = Module._cimbard_decompress_read(id, buffers.out.ptr, outSize);
    if (read < 0) {
      self.postMessage({ type: "error", message: `Decompression failed (${read})` });
      return;
    }
    if (read === 0) break;
    parts.push(view("out").slice(0, read));
    total += read;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  self.postMessage({ type: "done", name, bytes }, [bytes.buffer]);
}

// Messages are handled one at a time: copying a VideoFrame is asynchronous and the wasm buffers are shared.
let queue = Promise.resolve();

function handle(data) {
  queue = queue.then(async () => {
    try {
      if (data.type === "frame") await decodeFrame(data);
      else if (data.type === "chunks") decodeChunks(data);
      else if (data.type === "reset") reset();
    } catch (e) {
      self.postMessage({
        type: data.type === "frame" ? "frame" : "error",
        found: false,
        mode: data.mode,
        via: data.frame ? "videoFrame" : "bitmap",
        message: String(e),
      });
    }
  });
}

self.onmessage = (event) => {
  if (ready) handle(event.data);
  else pending.push(event.data);
};
