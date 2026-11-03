import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { LiveStore } from '../client/liveStore';
import { pad, resolveBigScreen, resolveCountdown } from '../client/selectors';
import { BIG_SCREEN_WARN_MS, type Role } from '../shared/constants';
import { formatClockCs, formatClockSec } from '../shared/metrics';
import { useNow, useWakeLock } from './hooks';
import { alarms } from './sound';

interface Props {
  store: LiveStore;
  role: Role;
  onClose(): void;
  /** True when the display opened by itself because the countdown started. */
  autoOpened: boolean;
}

/**
 * Wall display for the authoritative round countdown.
 *
 * It renders the same derived clock every phone renders, and it offers no control
 * over the clock at all: the wall is for watching, and only the authoritative
 * actions on the owning station can ever change what it shows.
 */
export function BigScreen({ store, role, onClose, autoOpened }: Props) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const snap = state.snapshot;
  const now = useNow(store, 'raf');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [digitsOnly, setDigitsOnly] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [muted, setMuted] = useState(false);

  const clock = useMemo(() => (snap ? resolveBigScreen(snap, now) : null), [snap, now]);
  const hero = useMemo(() => (snap ? resolveCountdown(snap, now) : null), [snap, now]);

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
    return () => window.removeEventListener('keydown', onKey);
  }, [digitsOnly, onClose]);

  if (!clock || !hero) return null;

  const tone = clock.expired ? '#e1362c' : clock.remainingMs <= BIG_SCREEN_WARN_MS ? '#f0a12a' : '#1fb96e';
  // In digits-only mode the whole surface is the gesture that brings the buttons back.
  const tap = digitsOnly ? () => setDigitsOnly(false) : undefined;

  return (
    <div
      ref={rootRef}
      className={`safe-top safe-bottom fixed inset-0 z-[60] flex select-none flex-col items-center justify-center overflow-hidden bg-ink px-3 text-center ${
        clock.expired ? 'alarm-glow' : ''
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
        <div className="notch-top absolute inset-x-0 flex items-start justify-between gap-3 px-4 pt-3 text-[0.7rem] tracking-[0.16em] text-mute">
          <span data-testid="big-team">
            ĐỘI #{pad(clock.teamNumber)} · {formatClockSec(clock.limitMs)}
          </span>
        </div>
      )}

      {/* Minutes and seconds carry the whole screen; the fraction is deliberately
          an order of magnitude smaller so it never competes with the clock. */}
      <p className="digital wall-main font-bold leading-none" style={{ color: tone }}>
        <span data-testid="big-clock" data-mode={hero.running ? 'GAME' : 'FROZEN'}>
          {hero.mm}:{hero.ss}
        </span>
        <span className="wall-fraction" data-testid="big-fraction" aria-hidden>
          {hero.cs}
        </span>
      </p>

      {!digitsOnly && <p className="mt-3 text-[clamp(0.9rem,3vw,1.6rem)] font-bold tracking-[0.1em] text-snow" data-testid="big-label">{hero.teamText.toUpperCase()}</p>}

      {clock.pendingValidation && (
        <p className="digital mt-2 text-[clamp(0.8rem,3vw,1.6rem)] font-bold tracking-[0.16em] text-ember" data-testid="big-pending">
          HẾT GIỜ — ĐANG CHỜ XÁC MINH MỐC HỢP LỆ
        </p>
      )}

      {clock.result === 'WON' && clock.officialMs !== null && (
        <div className="mt-2 flex flex-col items-center gap-1" data-testid="big-result">
          <p className="text-[clamp(0.75rem,2.6vw,1.3rem)] font-bold tracking-[0.18em] text-jade/80">KẾT QUẢ CHÍNH THỨC</p>
          <p className="digital text-[clamp(0.9rem,3.4vw,1.8rem)] font-bold tracking-[0.08em] text-jade">
            THỜI GIAN HOÀN THÀNH: {formatClockCs(clock.officialMs)}
          </p>
        </div>
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

      {!digitsOnly && (
        <div className="notch-bottom absolute inset-x-0 flex flex-col gap-2 px-3 pb-4" data-testid="big-controls">
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
            {role === 'GATE'
              ? 'Màn hình này không điều khiển được đồng hồ. NPC 1 bấm trên điện thoại của mình.'
              : 'Chỉ hiển thị. Đồng hồ lượt chơi chỉ do NPC 1 mở và chỉ kết thúc theo mốc do NPC 2 chốt.'}
            {autoOpened ? ' Tự đóng khi lượt chơi chốt.' : ''}
          </p>
        </div>
      )}

      {digitsOnly && <p className="notch-bottom absolute mb-3 text-[0.6rem] tracking-[0.2em] text-mute/50">CHẠM ĐỂ THẤY LẠI NÚT</p>}
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
