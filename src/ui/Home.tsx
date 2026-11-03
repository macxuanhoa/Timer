import { useEffect, useRef, useState } from 'react';
import {
  BOARD_ROLES,
  OBSERVER_CAPACITY,
  RESET_BLOCK_LABEL,
  ROLE_LABEL,
  ROLE_SHORT,
  STATION_CODE_MAX,
  STATION_CODE_MIN,
  type Role,
} from '../shared/constants';
import type { StationBoard } from '../shared/types';
import { USING_SUPABASE } from '../client/gateway';
import { selectStation, type StoredSession } from './session';
import { EyeIcon, EyeOffIcon } from './icons';

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
  // The self-hosted development engine has no seat ownership to prove and keeps its
  // own development passcodes, so the picker does not ask for a crew code there.
  codes_required: false,
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
  const [pinOpen, setPinOpen] = useState(false);
  const [pin, setPin] = useState('');
  // The crew-code sheet: which station it is open for, and what has been typed.
  const [codeOpen, setCodeOpen] = useState(false);
  const [codeAt, setCodeAt] = useState<Role>('LOBBY');
  const [code, setCode] = useState('');
  const [codeShown, setCodeShown] = useState(false);
  const codeField = useRef<HTMLInputElement | null>(null);
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

  const claim = async (role: Role, code?: string) => {
    if (entering.current || !fresh || !canSelect) return;
    entering.current = true;
    setBusy(role); setMessage(null);
    try {
      // The four operating positions authenticate with their crew code, the retained
      // admin with its own PIN, and the viewer seat with nothing at all (V3.1 §5.2).
      const secret = role === 'SUPERVISOR' ? pin : code;
      onEnter(await selectStation(role, secret));
    } catch (err) {
      setMessage(err instanceof Error && err.name === 'AccessError' ? err.message : 'MẤT KẾT NỐI — CHẠM LẠI VỊ TRÍ ĐỂ TIẾP TỤC');
      await refresh.current();
    } finally {
      entering.current = false; setBusy(null); setPin(''); setCode('');
    }
  };

  /**
   * A station tap either claims straight away (local development, where the picker
   * has no seat ownership to prove) or opens the crew-code sheet first. Unknown
   * board information is treated as "a code is required", never as "no code".
   */
  const openStation = (role: Role) => {
    if (role === 'OBSERVER' || board?.codes_required === false) { void claim(role); return; }
    setMessage(null);
    setCodeAt(role);
    setCodeOpen(true);
  };

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
        {/* The retained admin position is not a station on the floor any more, so it
            is not offered as one: it opens the same PIN sheet from a quiet line. */}
        <div className="home-admin-line">
          <button type="button" data-testid="home-admin-open" disabled={!fresh || busy !== null}
            onClick={() => { setMessage(null); setPinOpen(true); }}>
            QUẢN TRỊ · GIÁM SÁT
          </button>
        </div>
        <div aria-live="polite" className="home-feedback">
          {message || error ? <p role="alert" data-testid="home-error">{message ?? error}</p> :
            !fresh ? <p className="text-mute">Đang kết nối để kiểm tra vị trí…</p> : null}
        </div>
        <footer className="home-footer"><span>SCREAM CONTROL</span><span>MỘT KHÔNG GIAN. MỘT NHỊP CHƠI.</span></footer>
      </div>
      {pinOpen ? (
        <div className="home-pin-backdrop">
          <form className="home-pin" aria-label="PIN QUẢN TRỊ" onSubmit={e => { e.preventDefault(); void claim('SUPERVISOR'); }}>
            <p className="home-eyebrow">QUYỀN QUẢN TRỊ</p><h2>Nhập PIN quản trị</h2>
            <input autoFocus type="password" inputMode="numeric" autoComplete="off" maxLength={12}
              minLength={8} pattern="[0-9]{8,12}" required aria-label="PIN quản trị" value={pin}
              onChange={e => setPin(e.target.value.replace(/\D/g, ''))} disabled={busy !== null} />
            {message ? <p role="alert">{message}</p> : null}
            <button className="cta cta-green" disabled={busy !== null || !fresh || !canSelect} type="submit">
              {busy ? 'ĐANG XÁC MINH…' : 'VÀO QUẢN TRỊ'}
            </button>
            <button type="button" className="home-pin-cancel" disabled={busy !== null}
              onClick={() => { setPinOpen(false); setPin(''); setMessage(null); }}>QUAY LẠI</button>
          </form>
        </div>
      ) : null}
      {codeOpen ? (
        <div className="home-pin-backdrop">
          <form className="home-pin" aria-label={`MÃ VỊ TRÍ · ${ROLE_SHORT[codeAt]}`}
            onSubmit={e => { e.preventDefault(); void claim(codeAt, code.trim().toUpperCase()); }}>
            <p className="home-eyebrow">CHỈ DÀNH CHO NHÂN SỰ</p>
            <h2>Vị trí {ROLE_SHORT[codeAt]}</h2>
            <p className="home-pin-note">{ROLE_LABEL[codeAt]}. Nhập mã vị trí do người phụ trách sự kiện cấp.
              Mã chỉ mở được đúng vị trí này và chỉ hỏi một lần cho mỗi thiết bị.</p>
            <div className="home-pin-field">
              <input ref={codeField} autoFocus type={codeShown ? 'text' : 'password'} autoComplete="off"
                autoCapitalize="characters" autoCorrect="off" spellCheck={false}
                minLength={STATION_CODE_MIN} maxLength={STATION_CODE_MAX} required
                aria-label="Mã vị trí" value={code}
                onChange={e => { setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '')); setMessage(null); }}
                disabled={busy !== null} />
              <button type="button" className="home-pin-peek" data-testid="home-code-peek" disabled={busy !== null}
                aria-label={codeShown ? 'Ẩn mã vị trí' : 'Hiện mã vị trí'} aria-pressed={codeShown}
                onClick={() => {
                  setCodeShown(shown => !shown);
                  requestAnimationFrame(() => codeField.current?.focus());
                }}>
                {codeShown ? <EyeOffIcon className="h-5 w-5" /> : <EyeIcon className="h-5 w-5" />}
              </button>
            </div>
            {message ? <p role="alert">{message}</p> : null}
            <button className="cta cta-green" disabled={busy !== null || !fresh || !canSelect || code.trim().length < STATION_CODE_MIN}
              type="submit" data-testid="home-code-confirm">
              {busy === codeAt ? 'ĐANG XÁC MINH…' : `VÀO VỊ TRÍ ${ROLE_SHORT[codeAt]}`}
            </button>
            <button type="button" className="home-pin-cancel" disabled={busy !== null}
              onClick={() => { setCodeOpen(false); setCode(''); setCodeShown(false); setMessage(null); }}>QUAY LẠI</button>
          </form>
        </div>
      ) : null}
    </main>
  );
}
