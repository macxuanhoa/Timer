import { formatClockCs } from '../shared/metrics';
import { countdownStage, countdownToneHex, fractionText, type CountdownStageInput } from './countdown';
import { CheckIcon } from './icons';

/**
 * V3.4 — the shared SCREAM Night time presentation.
 *
 * The phone hero, the wall display and the official-result card all render the
 * same authoritative clock, so they render it through the same component: one
 * tabular MM:SS field carrying the visual weight and one subordinate `.cs`
 * fraction, coloured through the single stage decision in `countdown.ts`.
 * Nobody re-implements the digits, and no surface can drift from the palette.
 */

interface TimeDigitsProps {
  mm: string;
  ss: string;
  cs: string;
  /** The shared stage input; the tone is never picked per-screen. */
  stage: CountdownStageInput;
  /**
   * Which number these digits carry: the live game clock, or the time the server
   * stored when the round was decided. It comes from the authoritative view
   * rather than being re-derived from `running`, because "not running" covers
   * both the frozen official result and a round that never started — and a
   * reader of the DOM (or a test) must be able to tell them apart.
   */
  mode: 'GAME' | 'RESULT';
  /**
   * `phone` and `wall` are the two sizes. `observer` is the anonymous viewer:
   * the same digits at phone size, but its own test ids, because a viewer's
   * surface is queried separately in the workflow suite.
   */
  variant: 'phone' | 'wall' | 'observer';
}

export function TimeDigits({ mm, ss, cs, stage, mode, variant }: TimeDigitsProps) {
  const tone = countdownToneHex(countdownStage(stage));
  const main = variant === 'wall' ? 'wall-main' : 'countdown-main';
  const frac = variant === 'wall' ? 'wall-fraction' : 'countdown-fraction';
  const clockTestid = variant === 'wall' ? 'big-clock' : variant === 'observer' ? 'observer-clock' : 'hero-clock';
  const fracTestid = variant === 'wall' ? 'big-fraction' : variant === 'observer' ? 'observer-fraction' : 'hero-fraction';
  return (
    <p className={`digital ${main} font-bold leading-none`} style={{ color: tone }} data-stage={countdownStage(stage)}>
      <span data-testid={clockTestid} data-mode={mode}>
        {mm}:{ss}
      </span>
      <span className={frac} data-testid={fracTestid} aria-hidden>
        {fractionText(cs)}
      </span>
    </p>
  );
}

/**
 * The milestone the whole round exists for: a correct attempt has been
 * finalised. It is deliberately not another dashboard card — the official
 * time wears the ivory-gold of the poster's lantern light, and the sentence
 * under it names exactly who owns the next step.
 *
 * `showTime` defaults to true. NPC 2's own phone passes false, because the
 * countdown hero directly above it is already rendering that exact number at
 * the largest size on the surface (V3.4.1): the same time twice in one viewport
 * is the difference between a milestone and a wall of digits.
 */
export function OfficialResultCard({ teamText, officialMs, waitingLine, showTime = true }: {
  teamText: string;
  officialMs: number;
  /** Secondary status in the operator's own words, e.g. the NPC1 handoff. */
  waitingLine: string | null;
  showTime?: boolean;
}) {
  return (
    <section className="official-result-card" data-testid="official-result" data-time={showTime ? '1' : '0'}>
      <p className="official-result-eyebrow" data-testid="official-result-title">
        <span className="ornament-dot" aria-hidden />
        ĐÃ CHỐT KẾT QUẢ
        <span className="ornament-dot" aria-hidden />
      </p>
      <p className="official-result-team" data-testid="official-result-team">{teamText.toUpperCase()}</p>
      {showTime ? (
        <>
          <p className="official-result-label">THỜI GIAN CHÍNH THỨC</p>
          <p className="digital official-result-time" data-testid="official-result-time">{formatClockCs(officialMs)}</p>
        </>
      ) : null}
      {waitingLine ? (
        <p className="official-result-wait" data-testid="official-result-wait">
          <CheckIcon className="h-3.5 w-3.5 shrink-0" />
          {waitingLine}
        </p>
      ) : null}
    </section>
  );
}
