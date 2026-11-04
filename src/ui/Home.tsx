import { useEffect, useRef, useState } from 'react';
import {
  BOARD_ROLES,
  OBSERVER_CAPACITY,
  RESET_BLOCK_LABEL,
  ROLE_LABEL,
  ROLE_SHORT,
  type Role,
} from '../shared/constants';
import type { StationBoard } from '../shared/types';
import { USING_SUPABASE } from '../client/gateway';
import { isAdminRoute, selectStation, type StoredSession } from './session';

/** What each tile says to the person about to stand there. */
const LABELS: Record<Role, string> = {
  LOBBY: ROLE_LABEL.LOBBY,
  CORRIDOR: ROLE_LABEL.CORRIDOR,
  GATE: ROLE_LABEL.GATE,
  ROOM305: ROLE_LABEL.ROOM305,
  SUPERVISOR: ROLE_LABEL.SUPERVISOR,
  OBSERVER: 'XEM TRỰC TIẾP · KHÔNG CẦN MẬT KHẨU',
};
/** Operator seats are the ones a shift can fill up; viewing has its own capacity. */
const SEAT_CAPACITY: Record<Role, number> = {
  LOBBY: 1, CORRIDOR: 1, GATE: 1, ROOM305: 1, SUPERVISOR: 2, OBSERVER: OBSERVER_CAPACITY,
};
const DEV_BOARD: StationBoard = {
  board_version: 3,
  capacity: 5, occupied: 0, locked: false, device_capacity: 6, devices: 0, game_running: false,
  reset_allowed: true, reset_block_reason: null,
  observer_capacity: OBSERVER_CAPACITY, observer_devices: 0,
  stations: (Object.keys(SEAT_CAPACITY) as Role[]).map(role => ({
    role, occupied: false, capacity: SEAT_CAPACITY[role], devices: 0,
  })),
};

export function Home({ onEnter, canSelect = true, error }: {
  onEnter(session: StoredSession): void; canSelect?: boolean; error: string | null;
}) {
  const [board, setBoard] = useState<StationBoard | null>(USING_SUPABASE ? null : DEV_BOARD);
  const [fresh, setFresh] = useState(!USING_SUPABASE);
  const [busy, setBusy] = useState<Role | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // V3.2: the organiser route reveals the admin seat plus this device's uuid, so
  // the organiser can put it on the allow-list once. Players never load any of it.
  const adminRoute = isAdminRoute();
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const loading = useRef(false);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const entering = useRef(false);
  const lastRead = useRef(0);

  useEffect(() => {
    if (!USING_SUPABASE || !adminRoute) return;
    void import('../client/supabaseAuth').then(({ myDeviceId }) =>
      myDeviceId().then(setDeviceId).catch(() => setDeviceId(null)));
  }, [adminRoute]);

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
        // A board that cannot describe every seat is not trusted: an unknown or
        // partial payload must disable the picker rather than guess availability.
        const valid = next !== null && (next.board_version ?? 0) >= 2 && next.device_capacity === 6 && next.observer_capacity === OBSERVER_CAPACITY &&
          BOARD_ROLES.every(role => next.stations.some(s => s.role === role &&
            s.capacity === SEAT_CAPACITY[role] &&
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
      // V3.2: no credential on any seat. The four duty positions, the viewer seat
      // and the admin seat all bind with a single tap; PostgreSQL enforces the
      // one-device-one-seat rule, and the /admin allow-list gates the admin seat.
      onEnter(await selectStation(role));
    } catch (err) {
      setMessage(err instanceof Error && err.name === 'AccessError' ? err.message : 'MẤT KẾT NỐI — CHẠM LẠI VỊ TRÍ ĐỂ TIẾP TỤC');
      await refresh.current();
    } finally {
      entering.current = false; setBusy(null);
    }
  };

  /** V3.2: a station tap is the whole claim. No code sheet exists any more. */
  const openStation = (role: Role) => { void claim(role); };

  /* The board release is no longer offered here: since V3.1 §6.1 it revokes every
     duty binding, so only a phone already holding the SUPERVISOR seat may ask for
     it, and that control lives in the admin sheet of the dashboard. What the picker
     keeps showing is the same authoritative answer about the floor, so nobody who
     arrives for the next shift is misled about what is still occupied. */
  const blockReason = board?.reset_block_reason ?? (board?.game_running === true ? 'RUNNING' : null);
  const floorBusy = fresh && blockReason !== null;
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
          <span className="home-board-tools">
            <span className="digital" data-testid="station-count">{fresh && board ? `${board.devices}/6` : '—/6'}</span>
            <span className="digital" data-testid="observer-count">{fresh && board ? `${board.observer_devices ?? 0}/${OBSERVER_CAPACITY}` : `—/${OBSERVER_CAPACITY}`}</span>
            {floorBusy ? (
              <span className="text-[8.5px] font-semibold tracking-[0.08em] text-ember" data-testid="home-floor-busy">
                {RESET_BLOCK_LABEL[(blockReason ?? 'RUNNING') as keyof typeof RESET_BLOCK_LABEL]}
              </span>
            ) : null}
          </span>
        </div>
        <div className="home-stations" aria-label="Chọn vị trí">
          {BOARD_ROLES.map((role, index) => {
            const slot = board?.stations.find(s => s.role === role);
            const known = fresh && slot !== undefined;
            const full = known && slot.devices! >= slot.capacity!;
            const available = known && !full;
            const observer = role === 'OBSERVER';
            return (
              <button key={role} type="button" data-testid={`station-${role}`}
                data-state={!known ? 'unknown' : full ? 'full' : 'available'}
                data-kind={observer ? 'observer' : 'station'}
                className={`home-station ${available ? 'is-available' : ''} ${observer ? 'home-station-observer' : ''}`}
                disabled={!available || busy !== null || !canSelect}
                onClick={() => openStation(role)}>
                <span className="home-station-number digital">0{index + 1}</span>
                <span className="home-station-label"><strong>{ROLE_SHORT[role]}</strong><small>{LABELS[role]}</small></span>
                <span className="home-station-status">
                  <span className="digital">{observer ? (known ? `${slot.devices}/${OBSERVER_CAPACITY}` : `—/${OBSERVER_CAPACITY}`) : known ? '●' : '○'}</span>
                  <small>{busy === role ? 'ĐANG VÀO…' : !known ? 'ĐANG ĐỒNG BỘ' : full
                    ? observer ? 'ĐÃ ĐỦ CHỖ XEM' : 'ĐÃ ĐỦ NGƯỜI'
                    : observer ? 'XEM ĐƯỢC' : 'CÒN TRỐNG'}</small>
                </span>
                <span className="home-station-arrow" aria-hidden="true">↗</span>
              </button>
            );
          })}
        </div>
        {/* V3.2: the admin seat is not offered on the public board at all. It only
            appears on the private /admin route, where the organiser's device uuid is
            shown once so it can be placed on the allow-list. Players never see this. */}
        {adminRoute ? (
          <div className="home-admin-line" data-testid="admin-panel">
            <p className="home-pin-note">
              Máy này là <strong className="digital" data-testid="admin-device-id">{deviceId ?? '…'}</strong>.
              Nếu đây là lần đầu, mở Supabase → SQL Editor và chạy một lần:
            </p>
            <pre className="home-admin-sql" data-testid="admin-bootstrap-sql">{`insert into sc.admin_devices (user_id, note)
  values ('${deviceId ?? '<uuid-máy-này>'}', 'máy quản trị');`}</pre>
            <div className="flex gap-2">
              <button type="button" data-testid="admin-copy"
                className="flex-1 rounded-[10px] border border-hair bg-panel px-3 py-2 text-[10.5px] font-semibold text-snow/90"
                onClick={() => {
                  if (!deviceId) return;
                  void navigator.clipboard?.writeText(deviceId).catch(() => undefined);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                }}>
                {copied ? 'ĐÃ SAO CHÉP' : 'SAO CHÉP MACHINE ID'}
              </button>
              <button type="button" data-testid="home-admin-open" className="flex-1"
                disabled={!fresh || busy !== null || !canSelect}
                onClick={() => void claim('SUPERVISOR')}>
                {busy === 'SUPERVISOR' ? 'ĐANG VÀO…' : 'VÀO QUẢN TRỊ'}
              </button>
            </div>
          </div>
        ) : null}
        <div aria-live="polite" className="home-feedback">
          {message || error ? <p role="alert" data-testid="home-error">{message ?? error}</p> :
            !fresh ? <p className="text-mute">Đang kết nối để kiểm tra vị trí…</p> : null}
        </div>
        <footer className="home-footer"><span>SCREAM CONTROL</span><span>MỘT KHÔNG GIAN. MỘT NHỊP CHƠI.</span></footer>
      </div>
    </main>
  );
}
