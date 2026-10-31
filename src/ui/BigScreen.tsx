import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { LiveStore } from '../client/liveStore';
import { pad, resolveBigScreen } from '../client/selectors';
import { BIG_SCREEN_WARN_MS, type Role } from '../shared/constants';
import { formatClockSec } from '../shared/metrics';
import { useNow, useWakeLock } from './hooks';
import { StationStrip } from './StationStrip';
import { alarms } from './sound';

interface Props {
  store: LiveStore;
  role: Role;
  onClose(): void;
  /** True when the display opened by itself because the game clock started. */
  autoOpened: boolean;
}

/**
 * Wall display for the 5-minute game countdown. GATE (or the supervisor) may
 * pause or restart the 5:00 from here; both are audited commands, and the display
 * closes itself when GATE stops the game clock.
 */
export function BigScreen({ store, role, onClose, autoOpened }: Props) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const snap = state.snapshot;
  const now = useNow(store, 'slow');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [digitsOnly, setDigitsOnly] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [muted, setMuted] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const clock = useMemo(() => (snap ? resolveBigScreen(snap, now) : null), [snap, now]);
  const canControl = role === 'GATE' || role === 'SUPERVISOR';
  const busy = state.pending !== null;

  // A wall display must never dim mid-round (where the browser allows it).
  useWakeLock(true);

  /**
   * Browsers only allow fullscreen from a user gesture, so this must never run in
   * an effect: an auto-opened display would log "requestFullscreen … only be
   * initiated by a user gesture" on every mount. The first real tap arms it once.
   */
  const setFullscreenMode = (on: boolean) => {
    try {
      const pending = on ? rootRef.current?.requestFullscreen() : document.fullscreenElement ? document.exitFullscreen() : undefined;
      void pending?.catch(() => undefined);
    } catch {
      /* refused */
    }
  };

  // A wall display should go fullscreen on its first touch; the overlay already
  // covers the viewport, so a refusal simply leaves the digits on screen.
  const armedFullscreen = useRef(false);
  const armFullscreen = () => {
    if (armedFullscreen.current || !autoOpened) return;
    armedFullscreen.current = true;
    setFullscreenMode(true);
  };

  useEffect(() => {
    const sync = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    };
  }, []);

  const pattern = !clock || muted ? 'none' : clock.expired && !clock.paused ? 'critical' : clock.remainingMs <= BIG_SCREEN_WARN_MS ? 'warn' : 'none';

  // While this screen is up it owns the alarm, so the dashboard stops re-arming it.
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
    return () => window.removeEventListener('keydown', onKey);
  }, [digitsOnly, onClose]);

  // An accidental tap must never wipe a running clock: the reset needs a confirm.
  useEffect(() => setConfirmReset(false), [clock?.resetCount, clock?.key]);

  if (!clock) return null;

  const overtimeMs = -clock.remainingMs;
  const digits = formatClockSec(Math.max(0, clock.remainingMs));

  const togglePause = () => {
    alarms.unlock();
    void store.act(clock.paused ? 'GAME_RESUME' : 'GAME_PAUSE');
  };

  const reset = () => {
    alarms.unlock();
    // A real command: restart the official 5:00 window. The round is then flagged
    // for supervisor review.
    void store.act('GAME_RESET');
    setMuted(false);
    setConfirmReset(false);
  };

  // In digits-only mode the whole surface is the gesture that brings the buttons back.
  const tap = digitsOnly ? () => setDigitsOnly(false) : undefined;

  return (
    <div
      ref={rootRef}
      className={`safe-top safe-bottom fixed inset-0 z-[60] flex select-none flex-col items-center justify-center overflow-hidden bg-ink px-3 text-center ${
        clock.expired ? 'alarm-flash' : ''
      }`}
      data-testid="big-screen"
      data-expired={clock.expired}
      data-digits-only={digitsOnly}
      onClick={tap}
      onPointerDown={() => {
        alarms.unlock();
        armFullscreen();
      }}
    >
      {!digitsOnly && (
        <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-3 px-4 pt-3 text-[0.7rem] tracking-[0.16em] text-mute">
          <span data-testid="big-team">
            ĐỘI #{pad(clock.teamNumber)} · {formatClockSec(clock.limitMs)}
            {clock.resetCount > 0 ? <span className="ml-2 text-ember" data-testid="big-reset-count">RESET {clock.resetCount}</span> : null}
          </span>
        </div>
      )}

      {!digitsOnly && snap && (
        <div className="mb-3 w-full max-w-[min(94vw,52rem)] px-3">
          <StationStrip snap={snap} now={now} size="wall" self={role} />
        </div>
      )}

      <p className={`digital text-bigscreen leading-none text-blood ${clock.paused ? 'opacity-70' : ''}`} data-testid="big-clock">
        {digits}
      </p>

      {clock.paused && (
        <p className="digital mt-2 text-[clamp(1rem,4.5vw,2.4rem)] font-bold tracking-[0.24em] text-ember" data-testid="big-paused">
          TẠM DỪNG 5:00
        </p>
      )}

      {clock.expired && !clock.paused && (
        <p
          className="alarm-blink digital mt-2 text-[clamp(1.2rem,6vw,3.5rem)] font-bold tracking-[0.24em] text-blood"
          data-testid="big-expired"
        >
          HẾT GIỜ{overtimeMs > 1000 ? ` +${formatClockSec(overtimeMs)}` : ''}
        </p>
      )}

      {!digitsOnly && (
        <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2 px-3 pb-4" data-testid="big-controls">
          <div className="flex gap-2">
            {confirmReset ? (
              <button
                type="button"
                onClick={reset}
                disabled={!canControl || busy}
                className="min-h-[4.5rem] flex-1 rounded-panel bg-ember px-4 text-[0.9rem] font-extrabold uppercase tracking-[0.06em] text-[#1a1204] disabled:opacity-60"
                data-testid="big-reset-confirm"
              >
                XÁC NHẬN RESET — MẤT GIỜ ĐANG CHẠY
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmReset(true)}
                disabled={!canControl || busy}
                className="min-h-[4.5rem] flex-1 rounded-panel bg-blood px-4 text-[1rem] font-extrabold uppercase tracking-[0.06em] text-[#140606] active:bg-[#c8382e] disabled:opacity-60"
                data-testid="big-reset"
              >
                RESET 5:00
              </button>
            )}
            <button
              type="button"
              onClick={togglePause}
              disabled={!canControl || busy}
              className="min-h-[4.5rem] flex-1 rounded-panel border border-ember/50 bg-ember/10 px-4 text-[0.95rem] font-bold uppercase tracking-[0.06em] text-ember disabled:opacity-60"
              data-testid="big-pause"
            >
              {clock.paused ? 'CHẠY TIẾP' : 'TẠM DỪNG'}
            </button>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <GhostButton onClick={() => setDigitsOnly(true)} testid="big-focus">
              CHỈ SỐ TO
            </GhostButton>
            <GhostButton onClick={() => setFullscreenMode(!fullscreen)} testid="big-full">
              {fullscreen ? 'BỎ TO MÀN HÌNH' : 'TO MÀN HÌNH'}
            </GhostButton>
            <GhostButton onClick={() => setMuted((m) => !m)} testid="big-mute">
              {muted ? 'BẬT TIẾNG' : 'TẮT TIẾNG'}
            </GhostButton>
            <GhostButton onClick={onClose} testid="big-close">
              ĐÓNG
            </GhostButton>
          </div>
          <p className="text-[0.65rem] leading-snug text-mute" data-testid="big-note">
            {canControl
              ? 'Reset đưa đồng hồ về 5:00 và làm kết quả chờ SUPERVISOR xét.'
              : 'Chỉ GATE hoặc SUPERVISOR mới được reset hoặc tạm dừng 5:00.'}
            {autoOpened ? ' Tự đóng khi GATE chốt giờ.' : ''}
          </p>
        </div>
      )}

      {digitsOnly && <p className="absolute bottom-3 text-[0.6rem] tracking-[0.2em] text-mute/50">CHẠM ĐỂ THẤY LẠI NÚT</p>}
    </div>
  );
}

function GhostButton({ onClick, testid, children }: { onClick(): void; testid: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-h-[3.2rem] rounded-panel border border-hair px-3 text-[0.72rem] font-semibold tracking-[0.06em] text-snow active:bg-panel"
      data-testid={testid}
    >
      {children}
    </button>
  );
}
