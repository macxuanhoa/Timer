/**
 * Alarms are activated only from a foreground user gesture (unlock() is wired to
 * every primary button press), as required for mobile browsers.
 */
type Pattern = 'none' | 'warn' | 'critical';

class AlarmEngine {
  private ctx: AudioContext | null = null;
  private timer: number | null = null;
  private pattern_: Pattern = 'none';

  get patternValue(): Pattern {
    return this.pattern_;
  }

  unlock(): void {
    if (typeof window === 'undefined') return;
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setPattern(next: Pattern): void {
    if (next === this.pattern_) return;
    this.pattern_ = next;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (next === 'none') return;
    const period = next === 'critical' ? 900 : 4000;
    this.ping();
    this.timer = window.setInterval(() => this.ping(), period);
  }

  private ping(): void {
    const ctx = this.ctx;
    if (ctx && ctx.state !== 'running') void ctx.resume();
    if (!ctx || ctx.state !== 'running') return;
    const critical = this.pattern_ === 'critical';
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = critical ? 'square' : 'sine';
    osc.frequency.setValueAtTime(critical ? 660 : 520, ctx.currentTime);
    if (critical) osc.frequency.exponentialRampToValueAtTime(320, ctx.currentTime + 0.22);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(critical ? 0.22 : 0.12, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.32);
    if (critical) navigator.vibrate?.([90, 60, 90]);
  }

  /** Re-arm after the page returns to the foreground. */
  resume(): void {
    if (this.ctx?.state === 'suspended') void this.ctx.resume();
  }

  /** Which alarm is currently demanded; used to deduplicate and to report visually. */
  get pattern(): Pattern {
    return this.pattern_;
  }

  /**
   * Honest audio readiness. Mobile browsers refuse sound until a gesture, so the
   * operator must be able to see whether an alarm would actually be heard.
   */
  status(): 'READY' | 'BLOCKED' | 'UNSUPPORTED' {
    if (typeof window === 'undefined') return 'UNSUPPORTED';
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return 'UNSUPPORTED';
    if (!this.ctx) return 'BLOCKED';
    return this.ctx.state === 'running' ? 'READY' : 'BLOCKED';
  }
}

export const alarms = new AlarmEngine();
