import QrWorker from "./qr-worker?worker";
import { FountainDecoder, fnv1a, parseFrame, streamIdentity } from "./protocol";
import { isContainer, unpackContainer } from "./container";
import { buildZip, parseVnaPayload, safeStamp } from "./payload";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>("video");
const placeholder = $("placeholder");
const bar = $("bar");
const statusEl = $("status");
const startBtn = $<HTMLButtonElement>("start");
const stopBtn = $<HTMLButtonElement>("stop");
const scanView = $("scan-view");
const resultView = $("result-view");
const shareZipBtn = $<HTMLButtonElement>("share-zip");
const shareLogBtn = $<HTMLButtonElement>("share-log");
const againBtn = $<HTMLButtonElement>("again");

const WORKER_COUNT = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));

let stream: MediaStream | null = null;
let wakeLock: { release(): Promise<void> } | null = null;
let decoder: FountainDecoder | null = null;
let identity = "";
let scanning = false;
let startedAt = 0;
let zipFile: File | null = null;
let logFile: File | null = null;

function setStatus(text: string, error = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", error);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// ---- decode worker pool: one frame in flight per worker, extra frames dropped.

interface Slot {
  worker: Worker;
  busy: boolean;
}

const slots: Slot[] = [];
let frameId = 0;

function ensureWorkers(): void {
  if (slots.length > 0) return;
  for (let i = 0; i < WORKER_COUNT; i++) {
    const slot: Slot = { worker: new QrWorker(), busy: true };
    slot.worker.onmessage = (e: MessageEvent<{ id: number; codes: Uint8Array[] }>) => {
      slot.busy = false;
      for (const code of e.data.codes) onCode(code);
    };
    slots.push(slot);
  }
}

async function submitFrame(): Promise<void> {
  const slot = slots.find((s) => !s.busy);
  if (!slot || video.readyState < 2 || video.videoWidth === 0) return;
  slot.busy = true;
  try {
    const bitmap = await createImageBitmap(video);
    slot.worker.postMessage({ id: ++frameId, bitmap }, [bitmap]);
  } catch {
    slot.busy = false;
  }
}

type RVFCVideo = HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };

function frameLoop(): void {
  if (!scanning) return;
  void submitFrame();
  const v = video as RVFCVideo;
  if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(frameLoop);
  else requestAnimationFrame(frameLoop);
}

// ---- fountain assembly

function onCode(bytes: Uint8Array): void {
  if (!scanning) return;
  const parsed = parseFrame(bytes);
  if (!parsed.ok) {
    if (parsed.message) setStatus(parsed.message, true);
    return;
  }
  const { header, block } = parsed;
  const id = streamIdentity(header);
  if (id !== identity || !decoder) {
    identity = id;
    decoder = new FountainDecoder(header);
    startedAt = performance.now();
  }
  decoder.addFrame(header.seq, block);
  updateProgress();
  if (decoder.isComplete) void finish(decoder);
}

function updateProgress(): void {
  if (!decoder) return;
  const { k, blockLen, totalLen } = decoder.header;
  // Useful frames track arrival linearly; solved blocks hockey-stick at the end.
  const frac = decoder.isComplete ? 1 : Math.min(0.99, decoder.usefulFrames / (k * 1.05));
  bar.style.width = `${(frac * 100).toFixed(1)}%`;
  const secs = (performance.now() - startedAt) / 1000;
  const rate = secs > 0 ? (decoder.solvedCount * blockLen) / secs : 0;
  setStatus(
    `Receiving ${formatBytes(totalLen)} · ${decoder.solvedCount}/${k} blocks · ${formatBytes(rate)}/s`,
  );
}

async function finish(dec: FountainDecoder): Promise<void> {
  const payload = dec.assemble();
  if (!payload) return;
  if (fnv1a(payload) !== dec.header.payloadFnv) {
    decoder = null;
    identity = "";
    setStatus("Checksum mismatch — restarting reception.", true);
    return;
  }
  stopCamera();
  setStatus("Decoding…");
  try {
    const fileBytes = isContainer(payload) ? await unpackContainer(payload) : payload;
    const log = parseVnaPayload(fileBytes);
    zipFile = buildZip(log);
    logFile = new File([log.text as BlobPart], `vna-${safeStamp(log.datetime)}.log`, { type: "text/plain" });
    showResult(log.datetime, zipFile, logFile);
  } catch (e) {
    resetScanState();
    setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

function showResult(datetime: string, zip: File, log: File): void {
  $("r-datetime").textContent = datetime;
  $("r-logname").textContent = log.name;
  $("r-zipname").textContent = zip.name;
  shareZipBtn.textContent = `Share zip (${formatBytes(zip.size)})`;
  shareLogBtn.textContent = `Share unzipped (${formatBytes(log.size)})`;
  scanView.hidden = true;
  resultView.hidden = false;
}

// ---- camera

async function acquireCamera(): Promise<MediaStream> {
  const base: MediaTrackConstraints = {
    facingMode: { ideal: "environment" },
    width: { ideal: 1280 },
    height: { ideal: 960 },
  };
  try {
    // iOS treats an `ideal` 60 fps as a hint and delivers 30; demand it first.
    return await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...base, frameRate: { exact: 60 } } });
  } catch {
    return await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...base, frameRate: { ideal: 60 } } });
  }
}

async function startCamera(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Camera not available. Open this page via HTTPS.", true);
    return;
  }
  startBtn.disabled = true;
  try {
    ensureWorkers();
    stream = await acquireCamera();
    const track = stream.getVideoTracks()[0];
    try {
      await track?.applyConstraints({ advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet] });
    } catch {
      // not supported on this device
    }
    video.srcObject = stream;
    await video.play();
    placeholder.hidden = true;
    startBtn.hidden = true;
    stopBtn.hidden = false;
    scanning = true;
    setStatus("Searching for QR stream…");
    void requestWakeLock();
    frameLoop();
  } catch (e) {
    setStatus(`Camera error: ${e instanceof Error ? e.message : String(e)}`, true);
    stopCamera();
  } finally {
    startBtn.disabled = false;
  }
}

type WakeLockNav = Navigator & { wakeLock?: { request(t: "screen"): Promise<{ release(): Promise<void> }> } };

async function requestWakeLock(): Promise<void> {
  try {
    wakeLock = (await (navigator as WakeLockNav).wakeLock?.request("screen")) ?? null;
  } catch {
    wakeLock = null;
  }
}

function stopCamera(): void {
  scanning = false;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  placeholder.hidden = false;
  startBtn.hidden = false;
  stopBtn.hidden = true;
  void wakeLock?.release().catch(() => {});
  wakeLock = null;
}

function resetScanState(): void {
  decoder = null;
  identity = "";
  bar.style.width = "0";
}

// ---- share

async function shareFile(file: File | null): Promise<void> {
  if (!file) return;
  const data: ShareData = { files: [file], title: file.name };
  if (navigator.canShare?.(data)) {
    try {
      await navigator.share(data);
      return;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
    }
  }
  // Fallback: plain download.
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

startBtn.addEventListener("click", () => {
  resetScanState();
  void startCamera();
});
stopBtn.addEventListener("click", () => {
  stopCamera();
  setStatus("Stopped.");
});
shareZipBtn.addEventListener("click", () => void shareFile(zipFile));
shareLogBtn.addEventListener("click", () => void shareFile(logFile));
againBtn.addEventListener("click", () => {
  zipFile = null;
  logFile = null;
  resultView.hidden = true;
  scanView.hidden = false;
  resetScanState();
  void startCamera();
});
// The browser drops the wake lock whenever the page is hidden.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && scanning) void requestWakeLock();
});
