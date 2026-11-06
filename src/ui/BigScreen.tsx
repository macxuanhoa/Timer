import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { LiveStore } from '../client/liveStore';
import { pad, resolveBigScreen, resolveCountdown } from '../client/selectors';
import { BIG_SCREEN_WARN_MS, type Role } from '../shared/constants';
import { formatClockSec } from '../shared/metrics';
import { useNow, useWakeLock } from './hooks';
import { alarms } from './sound';
import { countdownStage, countdownStateLabel, countdownStageOf, countdownToneHex } from './countdown';
import { TimeDigits } from './TimeView';

interface Props {
  store: LiveStore;
  role: Role;
  onClose(): void;
  /** True when the display opened by itself because the countdown started. */
  autoOpened: boolean;
}

/**
 * Where the browser left the fullscreen request. `unsupported` and `denied`
 * are recoverable states the operator can see and act on, never silent
 * failures: the display keeps working in the window either way.
 */
type FullscreenMode = 'off' | 'on' | 'unsupported' | 'denied';

/**
 * V3.4 §4 — the SCREAM NIGHT wall countdown.
 *
 * It renders the same derived clock every phone renders, through the same
 * shared countdown design system (tone, typography, fraction notation), and
 * it offers no control over the clock at all: the wall is for watching, and
 * only the authoritative actions on the owning station can ever change what
 * it shows. The layout is one flex column — information band, the giant
 * clock on the remaining stage, utility band — so nothing can float across
 * the digits.
 */
export function BigScreen({ store, role, onClose, autoOpened }: Props) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const snap = state.snapshot;
  const now = useNow(store, 'raf');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [digitsOnly, setDigitsOnly] = useState(false);
  const [fullscreen, setFullscreen] = useState<FullscreenMode>('off');
  const [muted, setMuted] = useState(false);

  const clock = useMemo(() => (snap ? resolveBigScreen(snap, now) : null), [snap, now]);
  const hero = useMemo(() => (snap ? resolveCountdown(snap, now) : null), [snap, now]);

  // A wall display must never dim mid-round (where the browser allows it).
  useWakeLock(true);

  /**
   * Browsers only allow fullscreen from a user gesture, so this must never run in
   * an effect: an auto-opened display would log "requestFullscreen … only be
   * initiated by a user gesture" on every mount. The first real tap arms it once.
   * A refusal is not swallowed: it lands in `denied`, which the utility band
   * shows with a retry path instead of a dead button.
   */
  const setFullscreenMode = (on: boolean) => {
    const el = rootRef.current;
    if (on) {
      if (!el || !document.fullscreenEnabled) {
        setFullscreen('unsupported');
        return;
      }
      try {
        void el.requestFullscreen().then(
          () => setFullscreen('on'),
          () => setFullscreen('denied'),
        );
      } catch {
        setFullscreen('denied');
      }
      return;
    }
    try {
      const pending = document.fullscreenElement ? document.exitFullscreen() : undefined;
      void (pending ?? Promise.resolve()).then(
        () => setFullscreen('off'),
        () => setFullscreen('off'),
      );
    } catch {
      setFullscreen('off');
    }
  };

  const armedFullscreen = useRef(false);
  const armFullscreen = () => {
    if (armedFullscreen.current || !autoOpened) return;
    armedFullscreen.current = true;
    setFullscreenMode(true);
  };

  useEffect(() => {
    const sync = () => setFullscreen((prev) => (document.fullscreenElement ? 'on' : prev === 'on' ? 'off' : prev));
    document.addEventListener('fullscreenchange', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    };
  }, []);

  // The countdown stops visually at zero, so the alarm fires once at the boundary
  // and then stays calm: no strobe, no repeated burst while people are walking out.
  const pattern = !clock || muted ? 'none' : clock.expired ? 'critical' : clock.remainingMs <= BIG_SCREEN_WARN_MS ? 'warn' : 'none';
  useEffect(() => {
    alarms.setPattern(pattern);
  }, [pattern]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (digitsOnly) setDigitsOnly(false);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [digitsOnly, onClose]);

  if (!clock || !hero) return null;

  // V3.4: the wall reads the one tone decision the shared countdown system
  // makes for this exact instant — ember while it runs, hot amber inside the
  // configured warning window, blood once the deadline has passed, bone-amber
  // when the server has frozen the result. The green stopwatch is gone; the
  // phone and the wall can no longer disagree about the same second, because
  // both now derive the stage from the same view through the same helper.
  const stageInput = countdownStageOf(hero);
  const tone = countdownToneHex(countdownStage(stageInput));
  const stateLabel = countdownStateLabel(stageInput);
  // V3.5: the header already prints “ĐỘI #001 · 05:00”, so the line under the
  // digits carries only what the header does not — the team's own label. The wall
  // keeps no second copy of the official time either: the digits ARE that time.
  const roundName = snap?.active_round?.team_name ? snap.active_round.team_name : null;
  // In digits-only mode the whole surface is the gesture that brings the buttons back.
  const tap = digitsOnly ? () => setDigitsOnly(false) : undefined;
  const fsLabel = fullscreen === 'on' ? 'BỎ TOÀN MÀN HÌNH' : 'TOÀN MÀN HÌNH';

  return (
    <div
      ref={rootRef}
      className={`safe-top safe-bottom wall-shell fixed inset-0 z-[60] flex select-none flex-col overflow-hidden text-center ${
        clock.expired ? 'alarm-glow' : ''
      }`}
      data-testid="big-screen"
      data-expired={clock.expired}
      data-digits-only={digitsOnly}
      data-tone={tone}
      onClick={tap}
      onPointerDown={() => {
        alarms.unlock();
        armFullscreen();
      }}
    >
      {!digitsOnly && (
        <header className="wall-top">
          <span data-testid="big-team">
            ĐỘI #{pad(clock.teamNumber)} · {formatClockSec(clock.limitMs)}
          </span>
          <span className="wall-state-chip" style={{ color: tone }} data-testid="big-state">
            {stateLabel}
          </span>
        </header>
      )}

      {/* Minutes and seconds carry the whole screen; the fraction stays on the
          clock as its own smaller, dimmer part — `.cs`, decimal included — so
          it reads as hundredths of a second and never as a stray number. The
          authoritative precision behind it is the stored deadline, unchanged.
          One shared component for the phone and the wall: the two surfaces can
          now only ever disagree about size, never about notation or colour. */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-3">
        <TimeDigits mm={hero.mm} ss={hero.ss} cs={hero.cs} stage={stageInput} mode={hero.mode} variant="wall" />

        {!digitsOnly && roundName !== null ? (
          <p className="mt-1 text-[clamp(0.9rem,3vw,1.6rem)] font-bold tracking-[0.1em] text-snow" data-testid="big-label">
            {roundName.toUpperCase()}
          </p>
        ) : null}

        {clock.pendingValidation && (
          <p className="digital mt-2 text-[clamp(0.8rem,3vw,1.6rem)] font-bold tracking-[0.16em] text-ember" data-testid="big-pending">
            HẾT GIỜ — ĐANG CHỜ XÁC MINH MỐC HỢP LỆ
          </p>
        )}

        {clock.result === 'ABORTED' && (
          <p className="mt-2 text-[clamp(1rem,4.5vw,2.6rem)] font-bold tracking-[0.16em] text-blood" data-testid="big-aborted">
            LƯỢT CHƠI ĐÃ HỦY
          </p>
        )}

        {!clock.pendingValidation && clock.expired && clock.result !== 'WON' && clock.result !== 'ABORTED' && (
          <p className="mt-2 text-[clamp(1rem,4.5vw,2.6rem)] font-bold tracking-[0.2em] text-blood" data-testid="big-expired">
            HẾT GIỜ
          </p>
        )}
      </div>

      {!digitsOnly ? (
        <footer className="wall-utils" data-testid="big-controls">
          <div className="wall-utils-row">
            <button type="button" onClick={() => setDigitsOnly(true)} className="wall-util-btn" data-testid="big-focus">
              CHỮ SỐ TO
            </button>
            <button
              type="button"
              onClick={() => setFullscreenMode(fullscreen !== 'on')}
              className="wall-util-btn"
              data-active={fullscreen === 'on' ? '1' : '0'}
              disabled={fullscreen === 'unsupported'}
              title={fullscreen === 'unsupported' ? 'Trình duyệt này không hỗ trợ toàn màn hình' : undefined}
              data-testid="big-full"
            >
              {fsLabel}
            </button>
            <button type="button" onClick={() => setMuted((m) => !m)} className="wall-util-btn" data-active={muted ? '1' : '0'} data-testid="big-mute">
              {muted ? 'BẬT TIẾNG' : 'TẮT TIẾNG'}
            </button>
            <button type="button" onClick={onClose} className="wall-util-btn" data-variant="close" data-testid="big-close">
              ĐÓNG
            </button>
          </div>
          {fullscreen === 'unsupported' && (
            <p className="text-[0.66rem] leading-snug text-ember" data-testid="big-fs-note">
              Trình duyệt không cho phép toàn màn hình — màn hình vẫn hiển thị đầy đủ ở đây.
            </p>
          )}
          {fullscreen === 'denied' && (
            <p className="text-[0.66rem] leading-snug text-ember" data-testid="big-fs-note">
              Trình duyệt từ chối yêu cầu toàn màn hình — bấm TOÀN MÀN HÌNH để thử lại.
            </p>
          )}
          <p className="max-w-[60ch] text-[0.65rem] leading-snug text-mute" data-testid="big-note">
            {role === 'GATE'
              ? 'Màn hình này không điều khiển được đồng hồ. NPC 1 bấm trên điện thoại của mình.'
              : 'Chỉ hiển thị. Đồng hồ do NPC 1 mở và kết thúc theo mốc NPC 2 chốt.'}
          </p>
        </footer>
      ) : (
        <p className="pb-3 text-center text-[0.6rem] tracking-[0.2em] text-mute/50">CHẠM ĐỂ THẤY LẠI NÚT</p>
      )}
    </div>
  );
}
