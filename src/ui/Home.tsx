import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  BOARD_ROLES,
  OBSERVER_CAPACITY,
  RESET_BLOCK_LABEL,
  ROLE_AREA,
  ROLE_DUTY,
  ROLE_PERSON,
  STATION_ROLES,
  type Role,
} from '../shared/constants';
import type { StationBoard } from '../shared/types';
import { USING_SUPABASE } from '../client/gateway';
import { isClientStale } from '../shared/version';
import { isAdminRoute, selectStation, type StoredSession } from './session';
import { ACCENT_HEX, ROLE_ACCENT } from './accents';
import {
  DoorIcon, EyeIcon, PinIcon, RoomIcon, StairsIcon, UsersIcon,
} from './icons';

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

/**
 * V3.4 picker states. One vocabulary for the four duty cards and the viewer
 * seat, so a phone always reads the same words in the same places:
 *   available — the server confirmed the seat is free;
 *   full      — the server confirmed every seat of that position is held;
 *   self      — this very device authoritatively holds the position (whoami);
 *   pending   — a claim from this tap is still unacknowledged;
 *   unknown   — the board could not be read, so nothing is promised either way.
 * A station is never shown as available unless the authoritative board said so.
 */
type SeatState = 'available' | 'full' | 'self' | 'pending' | 'unknown';

const SEAT_WORD: Record<SeatState, string> = {
  available: 'CÒN TRỐNG',
  full: 'ĐÃ CÓ NGƯỜI TRỰC',
  self: 'MÁY NÀY ĐANG GIỮ',
  pending: 'ĐANG VÀO…',
  unknown: 'CHƯA XÁC MINH ĐƯỢC',
};

/**
 * The four duty cards read from one shared composition: a distinctive glyph,
 * the person, the place, one responsibility line, the real occupancy, and the
 * whole card as the single interaction surface. The glyphs are the walking
 * route itself — who receives, who climbs, who guards the door, who sits in
 * 305 — so nobody has to memorise a number.
 */
const STATION_ICON = { LOBBY: UsersIcon, CORRIDOR: StairsIcon, GATE: DoorIcon, ROOM305: RoomIcon } as const;

export function Home({ onEnter, canSelect = true, error }: {
  onEnter(session: StoredSession): void; canSelect?: boolean; error: string | null;
}) {
  const [board, setBoard] = useState<StationBoard | null>(USING_SUPABASE ? null : DEV_BOARD);
  const [fresh, setFresh] = useState(!USING_SUPABASE);
  const [busy, setBusy] = useState<Role | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // V3.4: the picker mirrors the server's own answer about THIS device. A phone
  // that already holds a seat but could not open its dashboard (gateway failure,
  // lost session write) must see that fact named on the card, not a spinner.
  const [selfRole, setSelfRole] = useState<Role | null>(null);
  // V3.2: the organiser route reveals the admin seat plus this device's uuid, so
  // the organiser can put it on the allow-list once. Players never load any of it.
  const adminRoute = isAdminRoute();
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // The panel mirrors the REAL server-side permission (whoami binding), never a guess:
  // an authorised device is never shown raw UUID/SQL boilerplate again.
  const [adminState, setAdminState] = useState<'checking' | 'ready' | 'none' | 'error'>('checking');
  const loading = useRef(false);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const entering = useRef(false);
  const lastRead = useRef(0);

  useEffect(() => {
    if (!USING_SUPABASE || !adminRoute) return;
    void import('../client/supabaseAuth').then(({ myDeviceId }) =>
      myDeviceId().then(setDeviceId).catch(() => setDeviceId(null)));
  }, [adminRoute]);

  /** Authoritative read of this device's own binding (whoami). Never a guess: a
   *  failed or empty read simply leaves every card in its board-derived state. */
  useEffect(() => {
    if (!USING_SUPABASE) return;
    let disposed = false;
    void import('../client/supabaseAuth').then(({ currentProfile }) => currentProfile())
      .then(profile => { if (!disposed) setSelfRole(profile?.role ?? null); })
      .catch(() => { if (!disposed) setSelfRole(null); });
    return () => { disposed = true; };
  }, []);

  /** Ask the backend who this device really is: a live SUPERVISOR binding can only
   *  exist for an allow-listed device, so it is the authoritative granted state. */
  const checkAdmin = useRef(async () => {});
  useEffect(() => {
    if (!adminRoute) return;
    if (!USING_SUPABASE) { setAdminState('ready'); return; }
    let disposed = false;
    checkAdmin.current = async () => {
      setAdminState('checking');
      try {
        const { currentProfile } = await import('../client/supabaseAuth');
        const profile = await currentProfile();
        if (!disposed) setAdminState(profile?.role === 'SUPERVISOR' ? 'ready' : 'none');
      } catch {
        if (!disposed) setAdminState('error');
      }
    };
    void checkAdmin.current();
    return () => { disposed = true; };
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
      const text = err instanceof Error && err.name === 'AccessError' ? err.message : 'MẤT KẾT NỐI — CHẠM LẠI VỊ TRÍ ĐỂ TIẾP TỤC';
      setMessage(text);
      // A refused admin claim (revoked allow-list entry) drops the panel back to the
      // setup guidance instead of leaving a stale "granted" badge on screen.
      if (role === 'SUPERVISOR' && /QUẢN TRỊ/.test(text)) setAdminState('none');
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
  const eventClosed = fresh && board?.event_ended_at != null;

  /** The overview counts only what the public board is allowed to disclose: the
   *  four duty seats and the ten viewer seats. The aggregate `devices` field also
   *  carries the two hidden SUPERVISOR seats, so it is deliberately not printed —
   *  a "x/6" figure would leak admin capacity into the crew's own arithmetic. */
  const seatSlot = (role: Role) => board?.stations.find(s => s.role === role);
  const dutyDevices = fresh
    ? STATION_ROLES.reduce((sum, role) => sum + (seatSlot(role)?.devices ?? 0), 0)
    : null;
  const observerDevices = fresh ? (board?.observer_devices ?? 0) : null;

  const seatState = (role: Role, capacity: number): SeatState => {
    if (busy === role) return 'pending';
    if (selfRole === role) return 'self';
    const slot = seatSlot(role);
    if (!fresh || slot === undefined) return 'unknown';
    return (slot.devices ?? 0) >= (slot.capacity ?? capacity) ? 'full' : 'available';
  };

  /** A card answers a tap only when the server says there is a seat to take, or
   *  when it is the seat this device already holds (re-enter after a failed boot). */
  const seatEnabled = (state: SeatState) =>
    canSelect && (state === 'available' || state === 'self');

  return (
    <main className="home-shell safe-top safe-bottom" data-testid="scream-home" data-event={eventClosed ? 'closed' : 'open'}>
      <div className="home-content">
        <header className="home-header">
          <div className="home-brand">
            <span className="home-brand-word">SCREAM NIGHT</span>
            <span className="home-brand-room"><span className="home-signal" aria-hidden />ROOM 305</span>
          </div>
          <h1 className="home-title">CHỌN VỊ TRÍ TRỰC</h1>
          <p className="home-instruction">Chạm vào vị trí còn trống để nhận ca trực của bạn.</p>
        </header>

        <section className="home-overview card" aria-label="Tổng quan bảng vị trí" data-testid="home-overview" data-fresh={fresh ? '1' : '0'}>
          <div className="home-meters">
            <div className="home-meter">
              <span className="home-meter-label">Vị trí trực đã chiếm</span>
              <span className="home-meter-value digital" data-testid="station-count">{dutyDevices === null ? '—/4' : `${dutyDevices}/4`}</span>
              <span className="home-meter-note">Bốn vị trí vận hành của ca</span>
            </div>
            <div className="home-meter">
              <span className="home-meter-label">Người đang quan sát</span>
              <span className="home-meter-value digital" data-testid="observer-count">{observerDevices === null ? `—/${OBSERVER_CAPACITY}` : `${observerDevices}/${OBSERVER_CAPACITY}`}</span>
              <span className="home-meter-note">Giới hạn {OBSERVER_CAPACITY} thiết bị xem trực tiếp</span>
            </div>
          </div>
          {floorBusy ? (
            <p className="home-overview-busy" data-testid="home-floor-busy">
              {RESET_BLOCK_LABEL[(blockReason ?? 'RUNNING') as keyof typeof RESET_BLOCK_LABEL]}
            </p>
          ) : null}
        </section>

        <section className="home-duty" aria-label="Bốn vị trí trực">
          <h2 className="home-section-heading"><span>VỊ TRÍ TRỰC</span></h2>
          <div className="home-stations">
            {STATION_ROLES.map(role => {
              const state = seatState(role, 1);
              const slot = seatSlot(role);
              const known = fresh && slot !== undefined;
              const Icon = STATION_ICON[role];
              const accent = ACCENT_HEX[ROLE_ACCENT[role]];
              return (
                <button key={role} type="button" data-testid={`station-${role}`}
                  data-state={state} data-kind="station"
                  className="home-station"
                  style={{ '--role-accent': accent } as CSSProperties}
                  disabled={!seatEnabled(state)}
                  aria-label={`${ROLE_PERSON[role]} — ${ROLE_AREA[role]}. ${SEAT_WORD[state]}${known ? `. ${slot?.devices ?? 0}/${SEAT_CAPACITY[role]}` : ''}`}
                  onClick={() => openStation(role)}>
                  <span className="home-station-icon" aria-hidden><Icon className="h-5 w-5" /></span>
                  <span className="home-station-id">
                    <strong>{ROLE_PERSON[role]}</strong>
                    <span className="home-station-area"><PinIcon className="home-station-pin" />{ROLE_AREA[role]}</span>
                    <small className="home-station-duty">{ROLE_DUTY[role]}</small>
                  </span>
                  <span className="home-station-state">
                    <span className="home-station-seat digital">{known ? `${slot?.devices ?? 0}/${SEAT_CAPACITY[role]}` : `—/${SEAT_CAPACITY[role]}`}</span>
                    <span className="badge" data-tone={
                      state === 'available' ? 'live' : state === 'self' ? 'confirmed' : state === 'full' ? 'idle' : state === 'pending' ? 'live' : 'queued'
                    }>{SEAT_WORD[state]}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="home-viewer" aria-label="Quan sát trực tiếp">
          <h2 className="home-section-heading"><span>QUAN SÁT TRỰC TIẾP</span></h2>
          {(() => {
            const state = seatState('OBSERVER', OBSERVER_CAPACITY);
            const slot = seatSlot('OBSERVER');
            const known = fresh && slot !== undefined;
            return (
              <button type="button" data-testid="station-OBSERVER" data-kind="observer"
                data-state={state}
                className="home-observer-card"
                disabled={!seatEnabled(state)}
                aria-label={`Quan sát trực tiếp. ${state === 'full' ? `Đã đủ ${OBSERVER_CAPACITY} thiết bị` : SEAT_WORD[state]}${known ? `. ${slot?.devices ?? 0}/${OBSERVER_CAPACITY}` : ''}`}
                onClick={() => openStation('OBSERVER')}>
                <span className="home-observer-icon" aria-hidden><EyeIcon className="h-5 w-5" /></span>
                <span className="home-observer-id">
                  <strong>XEM TRỰC TIẾP TOÀN BỘ DIỄN BIẾN</strong>
                  <small>Chỉ đọc — không thao tác vào lượt chơi. Không cần mật khẩu.</small>
                </span>
                <span className="home-observer-state">
                  <span className="digital" data-testid="observer-seat-count">{known ? `${slot?.devices ?? 0}/${OBSERVER_CAPACITY}` : `—/${OBSERVER_CAPACITY}`}</span>
                  <span className="badge" data-tone={
                    state === 'available' ? 'confirmed' : state === 'full' ? 'idle' : state === 'pending' ? 'live' : 'queued'
                  }>{state === 'full' ? `ĐÃ ĐỦ ${OBSERVER_CAPACITY} CHỖ` : SEAT_WORD[state]}</span>
                </span>
              </button>
            );
          })()}
        </section>

        {/* V3.2: the admin seat is not offered on the public board at all. On the private
           /admin route the panel mirrors the real permission: a granted device sees one
           badge and one button; anything else sees short guidance with the UUID/SQL tucked
           into "advanced setup" until deliberately opened. Players never see this. */}
        {adminRoute ? (
          <div className="home-admin-line" data-testid="admin-panel">
            {adminState === 'checking' ? (
              <p className="home-pin-note" data-testid="admin-checking">ĐANG KIỂM TRA QUYỀN MÁY…</p>
            ) : adminState === 'ready' ? (
              <>
                <p className="home-admin-granted" data-testid="admin-granted">
                  <span aria-hidden="true">✓</span> THIẾT BỊ ĐÃ ĐƯỢC CẤP QUYỀN
                </p>
                <button type="button" data-testid="home-admin-open" className="home-admin-primary"
                  disabled={!fresh || busy !== null || !canSelect}
                  onClick={() => void claim('SUPERVISOR')}>
                  {busy === 'SUPERVISOR' ? 'ĐANG VÀO…' : 'VÀO BẢNG QUẢN TRỊ'}
                </button>
              </>
            ) : (
              <>
                <p className="home-pin-note" data-testid="admin-guide">
                  {adminState === 'error'
                    ? 'CHƯA KIỂM TRA ĐƯỢC QUYỀN DO MẤT KẾT NỐI.'
                    : 'VÀO KHU QUẢN TRỊ khi máy đã có trong danh sách cấp quyền. Cấp mới lần đầu? Mở mục Thiết lập nâng cao bên dưới rồi gửi mã máy cho người phụ trách.'}
                </p>
                <div className="flex gap-2">
                  <button type="button" data-testid="home-admin-open" className="home-admin-primary flex-1"
                    disabled={!fresh || busy !== null || !canSelect}
                    onClick={() => void claim('SUPERVISOR')}>
                    {busy === 'SUPERVISOR' ? 'ĐANG VÀO…' : 'VÀO QUẢN TRỊ'}
                  </button>
                  {USING_SUPABASE && adminState === 'error' ? (
                    <button type="button" data-testid="admin-recheck" className="flex-1 rounded-[10px] border border-hair bg-panel px-3 py-2 text-[10.5px] font-semibold text-snow/90"
                      onClick={() => void checkAdmin.current()}>KIỂM TRA LẠI QUYỀN</button>
                  ) : null}
                </div>
                <details className="home-admin-advanced" data-testid="admin-advanced">
                  <summary>THIẾT LẬP NÂNG CAO — LẤY MÃ MÁY & LỆNH CẤP QUYỀN</summary>
                  <p className="home-pin-note">
                    Mã máy này: <strong className="digital" data-testid="admin-device-id">{deviceId ?? '…'}</strong>.
                    Người phụ trách chạy MỘT lần trong Supabase → SQL Editor (quyền luôn được
                    kiểm tra lại phía máy chủ; trang này không tự cấp quyền):
                  </p>
                  <pre className="home-admin-sql" data-testid="admin-bootstrap-sql">{`insert into sc.admin_devices (user_id, note)
  values ('${deviceId ?? '<uuid-máy-này>'}', 'máy quản trị');`}</pre>
                  <button type="button" data-testid="admin-copy"
                    className="w-full rounded-[10px] border border-hair bg-panel px-3 py-2 text-[10.5px] font-semibold text-snow/90"
                    onClick={() => {
                      if (!deviceId) return;
                      void navigator.clipboard?.writeText(deviceId).catch(() => undefined);
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1500);
                    }}>
                    {copied ? 'ĐÃ SAO CHÉP' : 'SAO CHÉP MÃ MÁY'}
                  </button>
                </details>
              </>
            )}
          </div>
        ) : null}
        {/* V3.3 P0: the board now carries the event's real state, so the picker can
            tell the truth instead of leaving every phone guessing at a spinner. The
            three lines below are mutually exclusive diagnoses:
              * board unreachable / too old  → retry, never an infinite "đang đồng bộ";
              * event closed                 → say so, and say who reopens it;
              * bundle below the server floor→ the update gate will take the phone
                over on the next load, so point at it here too. */}
        {USING_SUPABASE && !fresh ? (
          <div className="notice-band" data-tone="warn" role="status" data-testid="home-board-stalled">
            <p>
              Không đọc được bảng vị trí — kiểm tra kết nối internet của máy này.
            </p>
            <button
              type="button"
              onClick={() => void refresh.current()}
              className="home-board-retry"
              data-testid="home-board-retry"
            >
              THỬ LẠI NGAY
            </button>
          </div>
        ) : null}
        {eventClosed ? (
          <p className="notice-band" data-tone="info" role="status" data-testid="home-event-closed">
            <span><strong className="home-closed-strong">SỰ KIỆN ĐÃ KẾT THÚC.</strong>{' '}
            Ca trực trước đã đóng. Quản trị viên bấm <strong className="home-closed-key">MỞ SỰ KIỆN MỚI</strong> ở bảng quản trị
            để bàn giao phòng cho ca tiếp theo — các máy khác sẽ tự chuyển sang sự kiện mới trong vài giây.</span>
          </p>
        ) : null}
        {fresh && board && isClientStale(board.min_client_version) ? (
          <p className="notice-band" data-tone="danger" role="status" data-testid="home-bundle-stale">
            <span>Máy này đang chạy bản ứng dụng cũ. Hãy đóng hẳn ứng dụng và mở lại để nhận bản mới.</span>
          </p>
        ) : null}
        <div aria-live="polite" className="home-feedback">
          {message || error ? <p role="alert" data-testid="home-error">{message ?? error}</p> :
            !fresh ? <p>Đang kết nối để kiểm tra vị trí…</p> : null}
        </div>
        <footer className="home-footer"><span>SCREAM CONTROL</span><span>MỘT KHÔNG GIAN. MỘT NHỊP CHƠI.</span></footer>
      </div>
    </main>
  );
}
