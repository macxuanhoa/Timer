import { useState } from 'react';
import { login, saveSession, type StoredSession } from './session';
import { ROLE_LABEL, ROLES, type Role } from '../shared/constants';
import { USING_SUPABASE } from '../client/gateway';

const ACCOUNT_BY_ROLE: Record<Role, string> = {
  LOBBY: 'lobby',
  GATE: 'gate',
  CORRIDOR: 'corridor',
  ROOM305: 'room305',
  SUPERVISOR: 'supervisor',
};

export function Login({ onSignedIn }: { onSignedIn(session: StoredSession): void }) {
  const [role, setRole] = useState<Role>('LOBBY');
  const [passcode, setPasscode] = useState('');
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const session = await login(ACCOUNT_BY_ROLE[role], passcode);
      saveSession(session);
      onSignedIn(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ĐĂNG NHẬP THẤT BẠI');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-[100dvh] flex-col justify-between bg-ink px-5 py-8">
      <header className="text-center">
        <p className="digital text-[1.05rem] font-bold tracking-[0.28em] text-blood">SCREAM CONTROL</p>
        <p className="mt-1 text-[0.72rem] tracking-[0.2em] text-mute">ROOM 305 · HALLOWEEN 90′</p>
      </header>

      <div className="flex flex-col gap-4">
        <p className="text-[0.72rem] tracking-[0.14em] text-mute">CHỌN VỊ TRÍ TRỰC</p>
        <div className="grid grid-cols-1 gap-2" role="radiogroup" data-testid="role-picker">
          {ROLES.map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={role === r}
              onClick={() => setRole(r)}
              className={`min-h-[3.25rem] rounded-panel border px-4 py-3 text-left text-[0.85rem] font-semibold tracking-[0.08em] ${
                role === r ? 'border-blood bg-blood/10 text-snow' : 'border-hair bg-panel/40 text-mute'
              }`}
              data-testid={`role-${r}`}
            >
              {ROLE_LABEL[r]}
            </button>
          ))}
        </div>

        <div>
          <label htmlFor="passcode" className="block text-[0.72rem] tracking-[0.14em] text-mute">
            {USING_SUPABASE ? 'MẬT KHẨU TÀI KHOẢN' : 'MẬT KHẨU TRỰC'}
          </label>
          <div className="relative mt-2">
            <input
              id="passcode"
              type={shown ? 'text' : 'password'}
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              autoComplete="off"
              className="w-full rounded-panel border border-hair bg-ink px-4 py-4 pr-14 text-[0.9rem] text-snow outline-none focus:border-blood"
              data-testid="passcode"
            />
            {/* Duty codes get read aloud across the counter, so checking them by eye is normal. */}
            <button
              type="button"
              onClick={() => setShown((s) => !s)}
              aria-label={shown ? 'ẨN mật khẩu' : 'HIỆN mật khẩu'}
              aria-pressed={shown}
              className="absolute inset-y-0 right-0 flex min-w-[3.25rem] items-center justify-center pr-2 text-mute active:text-snow"
              data-testid="toggle-passcode"
            >
              <EyeIcon shown={shown} />
            </button>
          </div>
        </div>

        {error && (
          <p className="rounded-panel border border-blood/50 bg-blood/10 px-3 py-2 text-[0.75rem] text-blood" data-testid="login-error">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={submit}
          disabled={busy || passcode.length === 0}
          className="min-h-[4rem] rounded-panel bg-blood px-4 py-4 text-[0.95rem] font-extrabold tracking-[0.08em] text-[#140606] disabled:opacity-50"
          data-testid="login-submit"
        >
          {busy ? 'ĐANG ĐĂNG NHẬP…' : 'VÀO TRỰC'}
        </button>
      </div>

      <p className="text-center text-[0.65rem] leading-relaxed text-mute">
        Năm điện thoại · năm vị trí · một trạng thái duy nhất.
        <br />
        Đăng nhập được lưu để mở lại giữa ca mà không phải nhập lại.
      </p>
    </div>
  );
}

/** Eye when the code is hidden, eye with a slash once it is plain text. */
function EyeIcon({ shown }: { shown: boolean }) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.4 12S6 5.9 12 5.9 21.6 12 21.6 12 18 18.1 12 18.1 2.4 12 2.4 12Z" />
      <circle cx="12" cy="12" r="2.7" />
      {shown ? <path d="M4.5 19.5 19.5 4.5" /> : null}
    </svg>
  );
}
