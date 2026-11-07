import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AdminIcon } from './icons';
import { AccessError, selectStation, type StoredSession } from './session';

export function AdminToggle({ active = false, disabled = false, onEnter, onLeave }: {
  active?: boolean; disabled?: boolean;
  onEnter?(session: StoredSession): void;
  onLeave?(): Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open && !busy && error) input.current?.focus(); }, [open, busy, error]);
  const changeOpen = (next: boolean) => {
    if (pending.current) return;
    setOpen(next); setPin(''); setError(null);
  };
  const submit = async () => {
    if (pending.current || disabled || (!active && pin.length !== 6)) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      if (active) await onLeave?.();
      else {
        const next = await selectStation('SUPERVISOR', pin);
        if (next.account.role !== 'SUPERVISOR') throw new AccessError('Hãy rời vị trí hiện tại trước.', 'ALREADY_BOUND_OTHER_ROLE');
        onEnter?.(next);
      }
      setPin(''); setOpen(false);
    } catch (err) {
      setPin('');
      setError(active
        ? 'Chưa thoát được quyền. Kiểm tra kết nối rồi nhấn lại.'
        : err instanceof AccessError ? err.message : 'Chưa kết nối được. Kiểm tra mạng rồi thử lại.');
    } finally { pending.current = false; setBusy(false); }
  };
  return <Dialog.Root open={open} onOpenChange={changeOpen}>
    <div className="admin-toggle-wrap">
    <button ref={toggle} type="button" className="admin-circle" data-active={active ? '1' : '0'}
      data-testid="admin-toggle" aria-label={active ? 'Thoát quản trị' : 'Mở quản trị'}
      title={active ? 'Về Khách' : 'Quản trị'} aria-pressed={active}
      disabled={disabled || busy} onClick={() => active ? void submit() : changeOpen(true)}>
      <AdminIcon className="h-5 w-5" />
    </button>
    {active && error ? <p role="alert" className="admin-leave-error">{error}</p> : null}
    </div>
    <Dialog.Portal><Dialog.Overlay className="admin-pin-overlay" />
      <Dialog.Content onCloseAutoFocus={e => { e.preventDefault(); toggle.current?.focus(); }} className="admin-pin-dialog" aria-describedby="admin-pin-description" data-testid="admin-pin-dialog">
        <Dialog.Title className="text-lg font-bold text-snow">Quản trị</Dialog.Title>
        <Dialog.Description id="admin-pin-description" className="text-sm text-mute">Nhập mật mã để tiếp tục.</Dialog.Description>
        <form onSubmit={e => { e.preventDefault(); void submit(); }}>
          <label className="sr-only" htmlFor="admin-pin">Mật mã quản trị</label>
          <input ref={input} id="admin-pin" data-testid="admin-pin" type="password" inputMode="numeric"
            autoComplete="off" required pattern="[0-9]{6}" maxLength={6} value={pin} disabled={busy}
            onChange={e => { setPin(e.target.value.replace(/\D/g, '')); setError(null); }} aria-invalid={!!error}
            aria-describedby={error ? 'admin-pin-error' : undefined} />
          {error && <p id="admin-pin-error" role="alert" className="text-sm text-blood">{error}</p>}
          <div className="flex gap-2">
            <Dialog.Close className="btn-quiet flex-1" disabled={busy}>Hủy</Dialog.Close>
            <button type="submit" className="btn-quiet flex-1 text-ember" disabled={busy || disabled || pin.length !== 6} data-testid="admin-unlock">
              {busy ? 'Đang mở…' : 'Mở quản trị'}
            </button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
