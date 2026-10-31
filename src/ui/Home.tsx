import { useEffect, useRef, useState } from 'react';
import { ROLES, type Role } from '../shared/constants';
import type { StationBoard } from '../shared/types';
import { USING_SUPABASE } from '../client/gateway';
import { selectStation, type StoredSession } from './session';

const LABELS: Record<Role, string> = {
  LOBBY: 'SẢNH TẦNG 1', GATE: 'NPC 1 / CỬA VÀO', CORRIDOR: 'NPC 2 / HÀNH LANG',
  ROOM305: 'NPC 3 / PHÒNG 305', SUPERVISOR: 'GIÁM SÁT',
};
const DEV_BOARD: StationBoard = {
  capacity: 5, occupied: 0, locked: false, device_capacity: 6, devices: 0,
  stations: ROLES.map(role => ({ role, occupied: false, capacity: role === 'SUPERVISOR' ? 2 : 1, devices: 0 })),
};

export function Home({ onEnter, canSelect = true, error }: {
  onEnter(session: StoredSession): void; canSelect?: boolean; error: string | null;
}) {
  const [board, setBoard] = useState<StationBoard | null>(USING_SUPABASE ? null : DEV_BOARD);
  const [fresh, setFresh] = useState(!USING_SUPABASE);
  const [busy, setBusy] = useState<Role | null>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const loading = useRef(false);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const entering = useRef(false);
  const lastRead = useRef(0);

  useEffect(() => {
    if (!USING_SUPABASE) return;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    const load = async () => {
      if (loading.current) return;
      loading.current = true;
      try {
        const { stationBoard } = await import('../client/supabaseAuth');
        const next = await stationBoard();
        const valid = next?.device_capacity === 6 && next.stations.length === 5 &&
          ROLES.every(role => next.stations.some(s => s.role === role &&
            s.capacity === (role === 'SUPERVISOR' ? 2 : 1) &&
            Number.isInteger(s.devices) && s.devices! >= 0 && s.devices! <= s.capacity));
        if (!disposed) {
          setFresh(Boolean(valid));
          if (valid) { lastRead.current = performance.now(); setBoard(next); }
        }
      } finally { loading.current = false; }
    };
    refresh.current = load;
    void load();
    void import('../client/supabaseAuth').then(({ watchStationBoard }) => {
      if (!disposed) unsubscribe = watchStationBoard(() => void load());
    });
    const poll = window.setInterval(() => {
      if (performance.now() - lastRead.current > 6_000) setFresh(false);
      void load();
    }, 3_000);
    const visible = () => {
      if (document.visibilityState === 'visible') { setFresh(false); void load(); }
    };
    const offline = () => setFresh(false);
    window.addEventListener('offline', offline);
    window.addEventListener('online', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      disposed = true; unsubscribe?.(); window.clearInterval(poll);
      window.removeEventListener('offline', offline); window.removeEventListener('online', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);

  const claim = async (role: Role) => {
    if (entering.current || !fresh || !canSelect) return;
    entering.current = true;
    setBusy(role); setMessage(null);
    try {
      onEnter(await selectStation(role, role === 'SUPERVISOR' ? pin : undefined));
    } catch (err) {
      setMessage(err instanceof Error && err.name === 'AccessError' ? err.message : 'MẤT KẾT NỐI — CHẠM LẠI VỊ TRÍ ĐỂ TIẾP TỤC');
      await refresh.current();
    } finally {
      entering.current = false; setBusy(null); setPin('');
    }
  };

  return (
    <main className="home-shell safe-top safe-bottom" data-testid="scream-home">
      <div className="home-content">
        <header className="home-header">
          <span className="home-eyebrow"><span className="home-signal" /> ROOM 305 · HALLOWEEN</span>
          <h1>SCREAM<br /><span>ROOM</span></h1>
          <p>Chọn vị trí của bạn để bắt đầu trực.</p>
        </header>
        <div className="home-board-heading">
          <span>VỊ TRÍ TRỰC</span>
          <span className="digital" data-testid="station-count">{fresh && board ? `${board.devices}/6` : '—/6'}</span>
        </div>
        <div className="home-stations" aria-label="Chọn vị trí">
          {ROLES.map((role, index) => {
            const slot = board?.stations.find(s => s.role === role);
            const known = fresh && slot !== undefined;
            const full = known && slot.devices! >= slot.capacity!;
            const available = known && !full;
            return (
              <button key={role} type="button" data-testid={`station-${role}`}
                data-state={!known ? 'unknown' : full ? 'full' : 'available'}
                className={`home-station ${available ? 'is-available' : ''}`}
                disabled={!available || busy !== null || !canSelect}
                onClick={() => {
                  if (role === 'SUPERVISOR') { setMessage(null); setPinOpen(true); }
                  else void claim(role);
                }}>
                <span className="home-station-number digital">0{index + 1}</span>
                <span className="home-station-label"><strong>{role}</strong><small>{LABELS[role]}</small></span>
                <span className="home-station-status">
                  <span className="digital">{role === 'SUPERVISOR' ? `${known ? slot.devices : '—'}/2` : known ? '●' : '○'}</span>
                  <small>{busy === role ? 'ĐANG VÀO…' : !known ? 'ĐANG ĐỒNG BỘ' : full ? 'ĐÃ ĐỦ NGƯỜI' : 'CÒN TRỐNG'}</small>
                </span>
                <span className="home-station-arrow" aria-hidden="true">↗</span>
              </button>
            );
          })}
        </div>
        <div aria-live="polite" className="home-feedback">
          {message || error ? <p role="alert" data-testid="home-error">{message ?? error}</p> :
            !fresh ? <p className="text-mute">Đang kết nối để kiểm tra vị trí…</p> : null}
        </div>
        <footer className="home-footer"><span>SCREAM CONTROL</span><span>MỘT KHÔNG GIAN. MỘT NHỊP CHƠI.</span></footer>
      </div>
      {pinOpen ? (
        <div className="home-pin-backdrop">
          <form className="home-pin" aria-label="PIN SUPERVISOR" onSubmit={e => { e.preventDefault(); void claim('SUPERVISOR'); }}>
            <p className="home-eyebrow">QUYỀN GIÁM SÁT</p><h2>Nhập PIN quản trị</h2>
            <input autoFocus type="password" inputMode="numeric" autoComplete="off" maxLength={12}
              minLength={8} pattern="[0-9]{8,12}" required aria-label="PIN quản trị" value={pin}
              onChange={e => setPin(e.target.value.replace(/\D/g, ''))} disabled={busy !== null} />
            {message ? <p role="alert">{message}</p> : null}
            <button className="cta cta-green" disabled={busy !== null || !fresh || !canSelect} type="submit">
              {busy ? 'ĐANG XÁC MINH…' : 'VÀO GIÁM SÁT'}
            </button>
            <button type="button" className="home-pin-cancel" disabled={busy !== null}
              onClick={() => { setPinOpen(false); setPin(''); setMessage(null); }}>QUAY LẠI</button>
          </form>
        </div>
      ) : null}
    </main>
  );
}
