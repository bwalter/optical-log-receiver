/**
 * Tells whether the phone is physically held sideways, from the direction of gravity. Unlike the page orientation, this
 * also works while the screen rotation is locked.
 */
export class SidewaysDetector {
  private sideways = false;
  private started = false;
  private readonly onChange: (sideways: boolean) => void;

  constructor(onChange: (sideways: boolean) => void) {
    this.onChange = onChange;
  }

  get isSideways(): boolean {
    return this.sideways;
  }

  /** Starts listening. Call it from a user gesture: iOS asks for the permission to read the motion sensors. */
  async start(): Promise<void> {
    if (this.started) return;
    const api = (window as { DeviceMotionEvent?: { requestPermission?: () => Promise<string> } }).DeviceMotionEvent;
    if (!api) return;
    try {
      if (typeof api.requestPermission === "function" && (await api.requestPermission()) !== "granted") return;
    } catch {
      return;
    }
    this.started = true;
    window.addEventListener("devicemotion", (e) => this.onMotion(e));
  }

  private onMotion(e: DeviceMotionEvent): void {
    const g = e.accelerationIncludingGravity;
    if (g?.x == null || g.y == null) return;
    const x = Math.abs(g.x);
    const y = Math.abs(g.y);
    // Only decides when one axis clearly dominates, e.g. not while the phone lies flat
    let next = this.sideways;
    if (x > 5 && x > 1.5 * y) next = true;
    else if (y > 5 && y > 1.5 * x) next = false;
    if (next === this.sideways) return;
    this.sideways = next;
    this.onChange(next);
  }
}
