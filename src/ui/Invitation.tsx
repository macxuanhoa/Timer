import { useEffect, useMemo, useState } from 'react';
import { ROLE_LABEL, ROLES, type Role } from '../shared/constants';
import type { StationBoard, StationSlot } from '../shared/types';
import { USING_SUPABASE } from '../client/gateway';
import {
  localStationLogin,
  pendingInviteToken,
  retryPendingInvite,
  type StoredSession,
} from './session';

interface Props {
  error: string | null;
  onEnter(session: StoredSession): void;
  onRetryBoot(): void;
}

/** The self-hosted engine has no bindings, so its harness keeps every seat free. */
const DEV_BOARD: StationBoard = {
  capacity: ROLES.length,
  occupied: 0,
  locked: false,
  stations: ROLES.map((role) => ({ role, occupied: false })),
};

/** The gate is only visible before a bind; a slow poll keeps it truthful. */
const BOARD_POLL_MS = 5000;

/**
 * The only screen between a phone and its dashboard. There is no role picker and
 * no password: a phone either holds an invitation link or a session it already
 * redeemed. Before any link is opened the gate paints the five-seat board — a
 * station that already has a phone is red and refuses entry, a free one is
 * green — and says out loud when all five are on duty and the links are locked.
 * The self-hosted engine (development and the browser suite) exposes its five
 * stations here instead, because it has no Supabase to redeem against.
 */
export function Invitation({ error, onEnter, onRetryBoot }: Props) {
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [board, setBoard] = useState<StationBoard | null>(USING_SUPABASE ? null : DEV_BOARD);

  const canRetryLink = !!pendingInviteToken();
  const locked = board?.locked ?? false;
  const stations = useMemo<StationSlot[]>(
    () => board?.stations ?? ROLES.map((role) => ({ role, occupied: false })),
    [board],
  );
  // Until the first board arrives the seats are unknown, not green.
  const unknown = board === null;

  useEffect(() => {
    if (!USING_SUPABASE) return;
    let disposed = false;
    const load = async () => {
      try {
        // The board is public, so this stays a dynamic import: the local build
        // never pulls the Supabase client into the gate bundle.
        const { stationBoard } = await import('../client/supabaseAuth');
        const next = await stationBoard();
        if (!disposed) setBoard(next);
      } catch {
        // Keep the last known board: the retry path stays available.
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), BOARD_POLL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  const retry = async () => {
    setBusy(true);
    setLocalError(null);
    try {
      if (canRetryLink) onEnter(await retryPendingInvite());
      else onRetryBoot();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'KHÔNG MỞ ĐƯỢC LIÊN KẾT');
    } finally {
      setBusy(false);
    }
  };

  const enterDevStation = async (role: Role) => {
    setBusy(true);
    setLocalError(null);
    try {
      onEnter(await localStationLogin(role));
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'KHÔNG VÀO ĐƯỢC VỊ TRÍ NÀY');
    } finally {
      setBusy(false);
    }
  };

  const shown = localError ?? error;

  return (
    <div
      className="flex min-h-[100dvh] flex-col justify-between bg-ink px-5 py-8"
      data-testid="invite-gate"
    >
      <header className="text-center">
        <p className="digital text-[1.05rem] font-bold tracking-[0.28em] text-blood">SCREAM CONTROL</p>
        <p className="mt-1 text-[0.72rem] tracking-[0.2em] text-mute">ROOM 305 · HALLOWEEN 90′</p>
      </header>

      <div className="flex flex-col gap-4">
        <section aria-label="Trạng thái vị trí">
          <div className="flex items-baseline justify-between">
            <p className="text-[0.72rem] tracking-[0.14em] text-mute">VỊ TRÍ TRỰC TIẾP</p>
            <p className="digital text-[0.72rem] tracking-[0.1em] text-mute" data-testid="station-count">
              {board ? `${board.occupied}/${board.capacity}` : `—/${ROLES.length}`}
            </p>
          </div>
          <ul className="mt-2 flex flex-col gap-1.5" data-testid="station-board">
            {stations.map((slot) => (
              <li
                key={slot.role}
                data-testid={`station-${slot.role}`}
                data-occupied={unknown ? 'unknown' : slot.occupied ? 'true' : 'false'}
                className={`flex min-h-[2.5rem] items-center justify-between gap-2 rounded-panel border px-3 py-2 ${
                  unknown
                    ? 'border-hair bg-panel/40'
                    : slot.occupied
                      ? 'border-blood/60 bg-blood/10'
                      : 'border-jade/50 bg-jade/10'
                }`}
              >
                <span
                  className={`text-[0.78rem] font-semibold tracking-[0.06em] ${
                    unknown ? 'text-snow' : slot.occupied ? 'text-blood' : 'text-jade'
                  }`}
                >
                  {ROLE_LABEL[slot.role]}
                </span>
                <span
                  className={`shrink-0 text-[0.6rem] font-semibold tracking-[0.12em] ${
                    unknown ? 'text-mute' : slot.occupied ? 'text-blood/80' : 'text-jade/80'
                  }`}
                >
                  {unknown ? 'ĐANG KIỂM TRA…' : slot.occupied ? '● ĐÃ CÓ NGƯỜI' : '○ CÒN TRỐNG'}
                </span>
              </li>
            ))}
          </ul>
          {locked && (
            <p
              className="mt-2 rounded-panel border border-blood/60 bg-blood/15 px-3 py-2 text-[0.7rem] leading-relaxed text-blood"
              data-testid="station-lock"
            >
              ĐÃ ĐỦ 5/5 VỊ TRÍ — LIÊN KẾT MỚI TẠM KHÓA. NĂM MÁY ĐANG TRỰC GIỮ NGUYÊN VỊ TRÍ.
            </p>
          )}
        </section>

        {USING_SUPABASE ? (
          <>
            <p className="text-[0.72rem] tracking-[0.14em] text-mute">MỞ LIÊN KẾT VỊ TRÍ</p>
            <p className="rounded-panel border border-hair bg-panel/40 px-4 py-5 text-[0.85rem] leading-relaxed text-snow">
              Máy này chưa được cấp vị trí. Mở đúng liên kết ban tổ chức đã gửi cho bạn — ứng dụng sẽ tự vào
              đúng màn hình trực, không cần mật khẩu và không cần chọn vị trí.
            </p>
          </>
        ) : (
          <>
            <p className="text-[0.72rem] tracking-[0.14em] text-mute">
              DEV · CHỌN VỊ TRÍ (chỉ chế độ tự dựng)
            </p>
            <div className="grid grid-cols-1 gap-2">
              {ROLES.map((role) => (
                <button
                  key={role}
                  type="button"
                  disabled={busy}
                  onClick={() => void enterDevStation(role)}
                  className="flex min-h-[3.25rem] items-center justify-between gap-2 rounded-panel border border-jade/50 bg-jade/10 px-4 py-3 text-left active:bg-panel2 disabled:opacity-50"
                  data-testid={`dev-station-${role}`}
                >
                  <span className="text-[0.85rem] font-semibold tracking-[0.08em] text-snow">
                    {ROLE_LABEL[role]}
                  </span>
                  <span className="shrink-0 text-[0.6rem] font-semibold tracking-[0.12em] text-jade/80">
                    ○ CÒN TRỐNG
                  </span>
                </button>
              ))}
            </div>
            <p className="text-[0.65rem] leading-relaxed text-mute">
              Chế độ tự dựng không giữ chỗ: khóa vị trí chỉ áp dụng trên bản Supabase.
            </p>
          </>
        )}

        {shown && (
          <p
            className="rounded-panel border border-blood/50 bg-blood/10 px-3 py-2 text-[0.75rem] leading-relaxed text-blood"
            data-testid="invite-error"
          >
            {shown}
          </p>
        )}

        {(canRetryLink || shown) && (
          <button
            type="button"
            onClick={() => void retry()}
            disabled={busy}
            className="min-h-[3.5rem] rounded-panel border border-hair bg-panel px-4 py-3 text-[0.8rem] font-semibold tracking-[0.08em] text-snow active:bg-panel2 disabled:opacity-50"
            data-testid="invite-retry"
          >
            {busy ? 'ĐANG MỞ LẠI…' : 'THỬ LẠI'}
          </button>
        )}
      </div>

      <p className="text-center text-[0.65rem] leading-relaxed text-mute">
        Năm điện thoại · năm vị trí · một trạng thái duy nhất.
        <br />
        Phiên được lưu trên máy này để mở lại giữa ca mà không phải quét liên kết.
      </p>
    </div>
  );
}
