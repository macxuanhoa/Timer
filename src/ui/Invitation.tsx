import { useState } from 'react';
import { ROLE_LABEL, ROLES, type Role } from '../shared/constants';
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

/**
 * The only screen between a phone and its dashboard. There is no role picker and
 * no password: a phone either holds an invitation link or a session it already
 * redeemed. The self-hosted engine (development and the browser suite) exposes
 * its five stations here instead, because it has no Supabase to redeem against.
 */
export function Invitation({ error, onEnter, onRetryBoot }: Props) {
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const canRetryLink = !!pendingInviteToken();

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
                  className="min-h-[3.25rem] rounded-panel border border-hair bg-panel/40 px-4 py-3 text-left text-[0.85rem] font-semibold tracking-[0.08em] text-snow active:bg-panel2 disabled:opacity-50"
                  data-testid={`dev-station-${role}`}
                >
                  {ROLE_LABEL[role]}
                </button>
              ))}
            </div>
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
