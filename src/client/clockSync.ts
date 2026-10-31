/**
 * Client-side estimate of server time.
 *
 * Rendered countdowns are driven by a monotonic delta from the last calibration,
 * so browser clock adjustments can never make a timer jump or run backwards.
 * Nothing here is authoritative: official scores always come from persisted
 * server-side durations.
 */
export interface ClockSample {
  rttMs: number;
  offsetMs: number;
}

export class ServerClockEstimate {
  /** server time at the last calibration, in epoch ms. */
  private serverAtCalibration = 0;
  /** monotonic reading taken at the same instant. */
  private monoAtCalibration = 0;
  private samples: ClockSample[] = [];
  private calibrated = false;

  constructor(private readonly mono: () => number = () => performance.now()) {}

  get isCalibrated(): boolean {
    return this.calibrated;
  }

  /** Median round-trip latency of the recent calibration window. */
  get medianRtt(): number | null {
    if (this.samples.length === 0) return null;
    const sorted = [...this.samples].map((s) => s.rttMs).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  get maxErrorMs(): number | null {
    const rtt = this.medianRtt;
    return rtt === null ? null : Math.ceil(rtt / 2) + 1;
  }

  /**
   * Record one probe: `serverMs` is the value the server reported for the moment
   * between `requestMono` and this call.
   */
  observe(serverMs: number, requestMono: number): void {
    const doneMono = this.mono();
    const rttMs = Math.max(0, doneMono - requestMono);
    const offsetMs = serverMs + rttMs / 2 - doneMono;
    this.samples.push({ rttMs, offsetMs });
    if (this.samples.length > 8) this.samples.shift();
    // Reject the outlier, then trust the best (lowest-latency) sample.
    const ordered = [...this.samples].sort((a, b) => a.offsetMs - b.offsetMs);
    const best = ordered[Math.floor(ordered.length / 2)];
    this.serverAtCalibration = doneMono + best.offsetMs;
    this.monoAtCalibration = doneMono;
    this.calibrated = true;
  }

  /** Estimated authoritative "now". */
  now(): number {
    if (!this.calibrated) return Date.now();
    return this.serverAtCalibration + (this.mono() - this.monoAtCalibration);
  }

  /** Re-anchor after reconnect / foreground resume. */
  reset(): void {
    this.samples = [];
    this.calibrated = false;
  }
}
