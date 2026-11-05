import { BIG_SCREEN_WARN_MS } from '../shared/constants';
import { COUNTDOWN_TONE } from './accents';

/**
 * V3.4 — the shared countdown design system.
 *
 * NPC 1's phone, the wall display and every other locked surface render the
 * same authoritative clock (`resolveCountdown` / `resolveBigScreen`), so they
 * must also read the same colour, notation and state vocabulary. This module
 * owns that vocabulary and nothing else: it never touches the timing contract,
 * only how the derived view is presented.
 *
 * The stages follow the SCREAM Night semantics:
 *   ok      — the clock is running normally: pumpkin ember.
 *   warn    — inside the configured warning window: hotter burning amber.
 *   danger  — the deadline has passed: blood red.
 *   frozen  — the round is decided (or not counting): bone-amber, a clearly
 *             non-running state. Never green.
 */
export type CountdownStage = keyof typeof COUNTDOWN_TONE;

/** The one warning threshold every surface reads (V3.1 configuration). */
export const COUNTDOWN_WARN_MS = BIG_SCREEN_WARN_MS;

export interface CountdownStageInput {
  /** The authoritative deadline has passed. */
  expired: boolean;
  /** Remaining time is inside the configured warning window. */
  warn: boolean;
  /** The clock is live information (running, undecided). */
  running: boolean;
  /** A validated in-time claim sealed the round. */
  won: boolean;
  /** NPC 1's guarded early exit (or a supervisor cancel) ended the round. */
  aborted: boolean;
  /** The deadline passed while an eligible claim awaits NPC 2. */
  pendingValidation: boolean;
}

/**
 * The single tone decision. Both screens call it with their own derived view
 * so a phone and the wall can never disagree about what the same instant means.
 */
export function countdownStage(input: CountdownStageInput): CountdownStage {
  if (input.won) return 'frozen';
  if (input.aborted || input.pendingValidation) return 'warn';
  if (input.expired) return 'danger';
  if (input.warn) return 'warn';
  if (input.running) return 'ok';
  return 'frozen';
}

export function countdownToneHex(stage: CountdownStage): string {
  return COUNTDOWN_TONE[stage];
}

/**
 * The hundredths field, stated as what it actually is: a fraction of the
 * second. V3.3 printed bare `61` beside the clock, which read as a stray
 * number; V3.4 always renders `.61` with a subordinate weight, and the
 * authoritative precision behind it (the stored deadline) is untouched.
 */
export function fractionText(cs: string): string {
  return `.${cs}`;
}

/** The running state in the operator's own words — Vietnamese, never the enum. */
export function countdownStateLabel(input: CountdownStageInput): string {
  if (input.pendingValidation) return 'ĐANG CHỜ XÁC MINH';
  if (input.won) return 'THÀNH CÔNG';
  if (input.aborted) return 'ĐÃ KẾT THÚC SỚM';
  if (input.expired) return 'HẾT GIỜ';
  if (input.running) return 'ĐANG CHẠY';
  return 'CHƯA CHẠY';
}

/** True when the digits are inside the configured warning window. */
export function isWarnRemaining(remainingMs: number): boolean {
  return remainingMs <= COUNTDOWN_WARN_MS;
}
