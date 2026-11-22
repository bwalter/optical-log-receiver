import QrWorker from "./qr-worker?worker";
import { FountainDecoder, fnv1a, parseFrame, streamIdentity } from "./protocol";
import { isContainer, unpackContainer } from "./container";
import { buildFile, buildZip, parseVnaPayload } from "./payload";
import { CimbarReceiver } from "./cimbar";
import { SpeedGauge } from "./gauge";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>("video");
const placeholder = $("placeholder");
const bar = $("bar");
const statusEl = $("status");
/** Default full scale of the speed gauge (KB/s) per code type. */
const GAUGE_SCALES = { qr: 20, color: 80 } as const;
const gauge = new SpeedGauge($("gauge"), 80);
const statsEl = $("stats");
const startBtn = $<HTMLButtonElement>("start");
const stopBtn = $<HTMLButtonElement>("stop");
const scanView = $("scan-view");
const resultView = $("result-view");
const shareZipBtn = $<HTMLButtonElement>("share-zip");
const shareLogBtn = $<HTMLButtonElement>("share-log");
const againBtn = $<HTMLButtonElement>("again");
const modeAutoBtn = $<HTMLButtonElement>("mode-auto");
const modeQrBtn = $<HTMLButtonElement>("mode-qr");
const modeColorBtn = $<HTMLButtonElement>("mode-color");

const WORKER_COUNT = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));

let stream: MediaStream | null = null;
let wakeLock: { release(): Promise<void> } | null = null;
let decoder: FountainDecoder | null = null;
let identity = "";
let scanning = false;
let startedAt = 0;
let zipFile: File | null = null;
let logFile: File | null = null;

// "qr": fountain-coded QR stream, "color": cimbar color code, "auto" (default): whichever is found first, so that
// the sender can let the user choose the code type after the receiver has been opened. `?mode=` forces a type.
type CodeType = "qr" | "color";
type ReceiveMode = CodeType | "auto";
const modeParam = new URLSearchParams(location.search).get("mode");
let receiveMode: ReceiveMode = modeParam === "color" || modeParam === "qr" ? modeParam : "auto";
/** Code type found in auto mode, null while searching. */
let detectedType: CodeType | null = null;

/** The code type being decoded, null while both are searched for. */
function activeType(): CodeType | null {
  return receiveMode === "auto" ? detectedType : receiveMode;
}

function searchingText(): string {
  const type = activeType();
  return type === "qr" ? "Searching for QR stream…" : type === "color" ? "Searching for color code…" : "Searching for code…";
}

function setReceiveMode(mode: ReceiveMode): void {
  receiveMode = mode;
  detectedType = null;
  modeAutoBtn.classList.toggle("selected", mode === "auto");
  modeQrBtn.classList.toggle("selected", mode === "qr");
  modeColorBtn.classList.toggle("selected", mode === "color");
  gauge.setDefaultScale(GAUGE_SCALES[mode === "auto" ? "color" : mode]);
  placeholder.textContent =
    mode === "qr"
      ? "Point the camera at the animated QR stream."
      : mode === "color"
        ? "Point the camera at the animated color code."
        : "Point the camera at the animated code.";
}
setReceiveMode(receiveMode);

/** In auto mode, decodes only the given code type from now on. */
function onCodeTypeFound(type: CodeType): void {
  if (receiveMode !== "auto" || detectedType !== null) return;
  detectedType = type;
  gauge.setDefaultScale(GAUGE_SCALES[type]);
}

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

// ---- statistics, shown once per second while scanning to tune the sender speed

const stats = { cameraFrames: 0, decodedFrames: 0, codes: 0, newCodes: 0, found: 0, bytes: 0, since: 0 };

function resetStats(): void {
  Object.assign(stats, {
    cameraFrames: 0,
    decodedFrames: 0,
    codes: 0,
    newCodes: 0,
    found: 0,
    bytes: 0,
    since: performance.now(),
  });
}

function updateStats(): void {
  const secs = (performance.now() - stats.since) / 1000;
  if (secs < 1) return;
  gauge.tick();
  const type = activeType();
  if (type === null) {
    statsEl.textContent = `Camera ${video.videoWidth}×${video.videoHeight} @ ${Math.round(stats.cameraFrames / secs)} fps`;
    resetStats();
    return;
  }
  if (type === "color") {
    const found = stats.decodedFrames > 0 ? Math.round((100 * stats.found) / stats.decodedFrames) : 0;
    statsEl.textContent =
      `Camera ${video.videoWidth}×${video.videoHeight} @ ${Math.round(stats.cameraFrames / secs)} fps · ` +
      `decoded ${Math.round(stats.decodedFrames / secs)} fps · code found in ${found}% · ` +
      `${formatBytes(stats.bytes / secs)}/s read` +
      (frameError ? ` · ${frameError}` : "");
    frameError = "";
    resetStats();
    return;
  }
  const perFrame = stats.decodedFrames > 0 ? stats.codes / stats.decodedFrames : 0;
  const duplicates = stats.codes > 0 ? Math.round((100 * (stats.codes - stats.newCodes)) / stats.codes) : 0;
  statsEl.textContent =
    `Camera ${video.videoWidth}×${video.videoHeight} @ ${Math.round(stats.cameraFrames / secs)} fps · decoded ${Math.round(stats.decodedFrames / secs)} fps · ` +
    `${perFrame.toFixed(1)} codes/frame · ${duplicates}% duplicates`;
  resetStats();
}

function ensureWorkers(): void {
  if (slots.length > 0) return;
  for (let i = 0; i < WORKER_COUNT; i++) {
    const slot: Slot = { worker: new QrWorker(), busy: true };
    slot.worker.onmessage = (e: MessageEvent<{ id: number; codes: Uint8Array[] }>) => {
      slot.busy = false;
      if (e.data.id >= 0) stats.decodedFrames++;
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

// ---- cimbar color code reception

let cimbar: CimbarReceiver | null = null;
/** Size of the file being received, read from the fountain chunk headers (0 while unknown). */
let cimbarSize = 0;
/** Last frame decoding error since the stats were shown. */
let frameError = "";

function ensureCimbar(): CimbarReceiver {
  if (cimbar) return cimbar;
  const count = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
  cimbar = new CimbarReceiver(count, {
    onFrame: (found, bytes, header) => {
      if (activeType() !== "color" && !header) return;
      stats.decodedFrames++;
      if (found) stats.found++;
      stats.bytes += bytes;
      if (!scanning || !header) return;
      onCodeTypeFound("color");
      if (startedAt === 0) startedAt = performance.now();
      cimbarSize = header.size;
    },
    onProgress: (progress) => {
      if (!scanning || progress.length === 0) return;
      const done = Math.max(...progress);
      bar.style.width = `${(100 * done).toFixed(1)}%`;
      if (cimbarSize > 0) gauge.update(done * cimbarSize, cimbarSize);
      setStatus(`Receiving ${cimbarSize > 0 ? formatBytes(cimbarSize) : "…"} · ${Math.round(100 * done)}%`);
    },
    onDone: (_name, bytes) => {
      if (scanning) void finishPayload(bytes);
    },
    onError: (message) => setStatus(`Error: ${message}`, true),
    onFrameError: (message) => {
      frameError = message;
    },
  });
  return cimbar;
}

type RVFCVideo = HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };

/** Incremented to stop the running frame loop when a new one is started. */
let frameLoopId = 0;

function startFrameLoop(): void {
  const id = ++frameLoopId;
  const v = video as RVFCVideo;
  const step = (): void => {
    if (!scanning || id !== frameLoopId) return;
    stats.cameraFrames++;
    updateStats();
    const type = activeType();
    // While searching, each frame is offered to both decoders (each one drops it if all its workers are busy)
    if (type !== "qr") void ensureCimbar().submit(video);
    if (type !== "color") void submitFrame();
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(step);
    else requestAnimationFrame(step);
  };
  step();
}

/**
 * iOS pauses the video (and may end the camera track) while the page is hidden; the frame callbacks then stop. Resumes
 * the camera without losing the reception progress.
 */
let resuming = false;

async function resumeCamera(): Promise<void> {
  if (!scanning || resuming) return;
  resuming = true;
  try {
    const track = stream?.getVideoTracks()[0];
    if (!track || track.readyState === "ended") {
      stopCamera();
      await startCamera();
      return;
    }
    try {
      await video.play();
    } catch {
      // retried on the next visibility change
    }
    startFrameLoop();
  } finally {
    resuming = false;
  }
}

// ---- fountain assembly

function onCode(bytes: Uint8Array): void {
  if (!scanning || activeType() === "color") return;
  const parsed = parseFrame(bytes);
  if (!parsed.ok) {
    if (parsed.message) setStatus(parsed.message, true);
    return;
  }
  onCodeTypeFound("qr");
  const { header, block } = parsed;
  const id = streamIdentity(header);
  if (id !== identity || !decoder) {
    identity = id;
    decoder = new FountainDecoder(header);
    startedAt = performance.now();
  }
  stats.codes++;
  if (decoder.addFrame(header.seq, block)) stats.newCodes++;
  updateProgress();
  if (decoder.isComplete) void finish(decoder);
}

function updateProgress(): void {
  if (!decoder) return;
  const { k, blockLen, totalLen } = decoder.header;
  // Only solved blocks are real progress: how many repair frames are needed to solve the missing blocks depends on
  // how many were missed, so any estimate based on the received frames fills up long before the end.
  bar.style.width = `${((100 * decoder.solvedCount) / k).toFixed(1)}%`;
  // Every new frame carries one block's worth of information, even if it only solves blocks later on.
  gauge.update(Math.min(decoder.usefulFrames * blockLen, totalLen), totalLen);
  // Repair frames which could not be used yet; each one solves at most one block once enough others are known.
  const buffered = decoder.usefulFrames - decoder.solvedCount;
  setStatus(
    `Receiving ${formatBytes(totalLen)} · ${decoder.solvedCount}/${k} blocks` +
      (buffered > 0 ? ` (+${buffered} repair frames buffered)` : ""),
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
  await finishPayload(isContainer(payload) ? await unpackContainer(payload) : payload);
}

async function finishPayload(fileBytes: Uint8Array): Promise<void> {
  stopCamera();
  setStatus("Decoding…");
  try {
    const log = parseVnaPayload(fileBytes);
    zipFile = buildZip(log);
    logFile = buildFile(log);
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
    // Dense codes need every camera pixel: iOS picks the closest format which also supports the frame rate below
    // (1920×1440 on recent iPhones, 1920×1080 or 1280×960 otherwise).
    width: { ideal: 1920 },
    height: { ideal: 1440 },
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
    track?.addEventListener("unmute", () => void resumeCamera());
    video.srcObject = stream;
    await video.play();
    placeholder.hidden = true;
    startBtn.hidden = true;
    stopBtn.hidden = false;
    scanning = true;
    resetStats();
    statsEl.textContent = "";
    if (!startedAt) setStatus(searchingText());
    void requestWakeLock();
    startFrameLoop();
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
  startedAt = 0;
  cimbarSize = 0;
  if (receiveMode === "auto") setReceiveMode("auto");
  cimbar?.reset();
  gauge.reset();
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
for (const [button, mode] of [
  [modeAutoBtn, "auto"],
  [modeQrBtn, "qr"],
  [modeColorBtn, "color"],
] as const) {
  button.addEventListener("click", () => {
    if (mode === receiveMode) return;
    setReceiveMode(mode);
    resetScanState();
    if (scanning) setStatus(searchingText());
  });
}
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
  if (document.visibilityState !== "visible" || !scanning) return;
  void requestWakeLock();
  void resumeCamera();
});
