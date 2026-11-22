// Speed gauge: shows the current reception speed (useful bytes over the last few seconds) with a needle, plus the
// average speed and the remaining time.

const SVG = "http://www.w3.org/2000/svg";
/** Window of the current speed: short enough to follow the needle, long enough to smooth the fountain bursts. */
const WINDOW_MS = 3000;
/** Full-scale values in KB/s; the smallest one above the default and the peak speed is used. */
const SCALES = [20, 40, 80, 120, 160, 240, 320];
const CX = 100;
const CY = 100;
const R = 80;

interface Sample {
  time: number;
  bytes: number;
}

function formatRate(bytesPerSecond: number): string {
  const kb = bytesPerSecond / 1024;
  return kb < 10 ? kb.toFixed(1) : Math.round(kb).toString();
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "–";
  const s = Math.max(0, Math.round(seconds));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

/** Point on the dial for a fraction (0 = left, 1 = right) of the scale. */
function dialPoint(fraction: number, radius: number): [number, number] {
  const angle = Math.PI * (1 - fraction);
  return [CX + radius * Math.cos(angle), CY - radius * Math.sin(angle)];
}

export class SpeedGauge {
  private samples: Sample[] = [];
  private startedAt = 0;
  private total = 0;
  private bytes = 0;
  private peak = 0;
  private scale = 0;
  private readonly arc: SVGPathElement;
  private readonly needle: SVGLineElement;
  private readonly ticks: SVGGElement;
  private readonly valueEl: HTMLElement;
  private readonly detailEl: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private defaultScale: number,
  ) {
    const svg = root.querySelector("svg")!;
    const [x0, y0] = dialPoint(0, R);
    const [x1, y1] = dialPoint(1, R);
    const dial = `M${x0} ${y0} A${R} ${R} 0 0 1 ${x1} ${y1}`;
    const track = document.createElementNS(SVG, "path");
    track.setAttribute("d", dial);
    track.setAttribute("class", "gauge-track");
    this.arc = document.createElementNS(SVG, "path");
    this.arc.setAttribute("d", dial);
    this.arc.setAttribute("class", "gauge-arc");
    this.arc.setAttribute("pathLength", "100");
    this.ticks = document.createElementNS(SVG, "g");
    this.ticks.setAttribute("class", "gauge-ticks");
    this.needle = document.createElementNS(SVG, "line");
    this.needle.setAttribute("x1", `${CX}`);
    this.needle.setAttribute("y1", `${CY}`);
    this.needle.setAttribute("x2", `${CX}`);
    this.needle.setAttribute("y2", `${CY - R + 12}`);
    this.needle.setAttribute("class", "gauge-needle");
    const hub = document.createElementNS(SVG, "circle");
    hub.setAttribute("cx", `${CX}`);
    hub.setAttribute("cy", `${CY}`);
    hub.setAttribute("r", "6");
    hub.setAttribute("class", "gauge-hub");
    svg.append(track, this.arc, this.ticks, this.needle, hub);
    this.valueEl = root.querySelector(".gauge-value")!;
    this.detailEl = root.querySelector(".gauge-detail")!;
    this.reset();
  }

  /** Default full scale in KB/s, e.g. depending on the code type. */
  setDefaultScale(kbPerSecond: number): void {
    this.defaultScale = kbPerSecond;
    this.reset();
  }

  reset(): void {
    this.samples = [];
    this.startedAt = 0;
    this.total = 0;
    this.bytes = 0;
    this.peak = 0;
    this.root.hidden = true;
    this.render(0);
  }

  /** Records the useful bytes received so far out of [total]. */
  update(bytes: number, total: number): void {
    const now = performance.now();
    if (this.startedAt === 0) this.startedAt = now;
    this.total = total;
    this.bytes = Math.max(this.bytes, bytes);
    this.samples.push({ time: now, bytes: this.bytes });
    this.root.hidden = false;
    this.refresh(now);
  }

  /** Called periodically so that the needle drops when nothing is received anymore. */
  tick(): void {
    if (this.startedAt === 0) return;
    const now = performance.now();
    this.samples.push({ time: now, bytes: this.bytes });
    this.refresh(now);
  }

  private refresh(now: number): void {
    while (this.samples.length > 2 && now - this.samples[1]!.time >= WINDOW_MS) this.samples.shift();
    const first = this.samples[0]!;
    const span = Math.max(now - first.time, 500);
    const current = ((this.bytes - first.bytes) * 1000) / span;
    this.render(current);
  }

  private render(current: number): void {
    this.peak = Math.max(this.peak, current);
    const needed = Math.max(this.defaultScale, this.peak / 1024);
    const scale = SCALES.find((s) => s >= needed) ?? SCALES[SCALES.length - 1]!;
    if (scale !== this.scale) this.drawTicks(scale);
    const fraction = Math.min(1, current / 1024 / scale);
    this.arc.setAttribute("stroke-dasharray", `${(100 * fraction).toFixed(2)} 100`);
    this.needle.style.transform = `rotate(${(180 * fraction - 90).toFixed(1)}deg)`;
    this.valueEl.textContent = formatRate(current);

    const secs = this.startedAt > 0 ? (performance.now() - this.startedAt) / 1000 : 0;
    const average = secs > 0 ? this.bytes / secs : 0;
    const remaining = Math.max(0, this.total - this.bytes);
    const eta = current > 0 ? remaining / current : Infinity;
    this.detailEl.textContent =
      this.startedAt > 0 ? `avg ${formatRate(average)} KB/s · ${formatDuration(eta)} left` : "";
  }

  private drawTicks(scale: number): void {
    this.scale = scale;
    this.ticks.replaceChildren();
    for (let i = 0; i <= 4; i++) {
      const [x, y] = dialPoint(i / 4, R - 22);
      const label = document.createElementNS(SVG, "text");
      label.setAttribute("x", x.toFixed(1));
      label.setAttribute("y", (y + 4).toFixed(1));
      label.textContent = `${(scale * i) / 4}`;
      this.ticks.append(label);
    }
  }
}
