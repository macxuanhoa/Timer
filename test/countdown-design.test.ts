import { describe, expect, it } from 'vitest';
import { BIG_SCREEN_WARN_MS, DEFAULT_ROUND_DURATION_MS } from '../src/shared/constants';
import { COUNTDOWN_TONE } from '../src/ui/accents';
import {
  COUNTDOWN_WARN_MS,
  countdownStage,
  countdownStateLabel,
  countdownToneHex,
  fractionText,
  isWarnRemaining,
  type CountdownStageInput,
} from '../src/ui/countdown';
import { resolveCountdown } from '../src/client/selectors';
import { TestHub, T0, SEC, MIN } from './helpers/harness';

/**
 * V3.4 §1 — the shared countdown design system.
 *
 * NPC 1's phone and the wall display derive their colour, notation and state
 * words from the same module; these tests pin the single mapping so the two
 * surfaces can never drift apart again the way the V3.3 green wall did. The
 * timing contract itself (the stored deadline) is exercised in flow-v3.test.ts
 * and clients.test.ts — nothing here touches it.
 */

const base: CountdownStageInput = {
  expired: false,
  warn: false,
  running: true,
  won: false,
  aborted: false,
  pendingValidation: false,
};

describe('V3.4 countdown design system', () => {
  it('maps one instant to one stage for every surface', () => {
    expect(countdownStage(base)).toBe('ok');
    expect(countdownStage({ ...base, warn: true })).toBe('warn');
    expect(countdownStage({ ...base, running: false, expired: true })).toBe('danger');
    expect(countdownStage({ ...base, won: true, expired: true })).toBe('frozen');
    expect(countdownStage({ ...base, aborted: true })).toBe('warn');
    expect(countdownStage({ ...base, pendingValidation: true })).toBe('warn');
    // A decided round never reads as "danger" even past the deadline: the
    // frozen official time is a non-running state, not an alarm.
    expect(countdownStage({ ...base, running: false, expired: true, won: true })).toBe('frozen');
  });

  it('never hands the countdown a corporate green', () => {
    for (const stage of ['ok', 'warn', 'danger', 'frozen'] as const) {
      const hex = countdownToneHex(stage);
      expect(hex).toMatch(/^#[0-9a-f]{6}$/i);
      // Green would mean g >= r and g > b by a wide margin; the ember/blood/
      // bone palette is always red-dominant.
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      expect(r > g, `${hex} reads green`).toBe(true);
    }
    expect(COUNTDOWN_TONE.ok).toBe('#f4893a');
  });

  it('states the hundredths as a fraction, never as a stray number', () => {
    expect(fractionText('61')).toBe('.61');
    expect(fractionText('00')).toBe('.00');
    expect(fractionText('9')).toBe('.9'); // never reached from cs, but still a fraction
  });

  it('derives the warning window from the existing configuration only', () => {
    expect(COUNTDOWN_WARN_MS).toBe(BIG_SCREEN_WARN_MS);
    expect(isWarnRemaining(BIG_SCREEN_WARN_MS)).toBe(true);
    expect(isWarnRemaining(BIG_SCREEN_WARN_MS + 1)).toBe(false);
  });

  it('names the running state in Vietnamese for both surfaces', () => {
    expect(countdownStateLabel(base)).toBe('ĐANG CHẠY');
    expect(countdownStateLabel({ ...base, expired: true, running: false })).toBe('HẾT GIỜ');
    expect(countdownStateLabel({ ...base, won: true })).toBe('THÀNH CÔNG');
    expect(countdownStateLabel({ ...base, aborted: true })).toBe('ĐÃ KẾT THÚC SỚM');
    expect(countdownStateLabel({ ...base, pendingValidation: true })).toBe('ĐANG CHỜ XÁC MINH');
  });
});

describe('V3.4 phone and wall cross the warn boundary at the same ms', () => {
  it('resolveCountdown.warnMs is the configured wall threshold', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.command('corridor', 'CONFIRM_FLOOR2');
    hub.command('gate', 'START_GAME');
    const snap = hub.snapshot();
    const view = resolveCountdown(snap, hub.now());
    expect(view.warnMs).toBe(BIG_SCREEN_WARN_MS);
    // The default round still runs on the protected 05:00.
    expect(view.durationMs).toBe(DEFAULT_ROUND_DURATION_MS);
    // One frame inside the window flips the tone; one frame outside does not.
    hub.advance(view.durationMs - BIG_SCREEN_WARN_MS - 1 * SEC);
    expect(resolveCountdown(snap, hub.now()).tone).toBe('primary');
    hub.advance(2 * SEC);
    expect(resolveCountdown(snap, hub.now()).tone).toBe('warn');
    // …and the same instant is exactly where the shared stage says "warn".
    const at = resolveCountdown(snap, hub.now());
    expect(
      countdownStage({
        expired: at.expired,
        warn: !at.settled && at.remainingMs <= at.warnMs,
        running: at.running,
        won: at.result === 'WON',
        aborted: at.result === 'ABORTED',
        pendingValidation: at.result === 'PENDING_VALIDATION',
      }),
    ).toBe('warn');
    // Well past the deadline the same decision reads danger.
    hub.advance(3 * MIN);
    const over = resolveCountdown(snap, hub.now());
    expect(
      countdownStage({
        expired: over.expired,
        warn: !over.settled && over.remainingMs <= over.warnMs,
        running: over.running,
        won: over.result === 'WON',
        aborted: over.result === 'ABORTED',
        pendingValidation: over.result === 'PENDING_VALIDATION',
      }),
    ).toBe('danger');
    void T0;
  });
});
