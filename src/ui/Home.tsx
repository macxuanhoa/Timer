import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  BOARD_ROLES,
  OBSERVER_CAPACITY,
  RESET_BLOCK_LABEL,
  ROLE_AREA,
  ROLE_PERSON,
  STATION_ROLES,
  type Role,
} from '../shared/constants';
import type { StationBoard } from '../shared/types';
import { USING_SUPABASE } from '../client/gateway';
import { isClientStale } from '../shared/version';
import { selectStation, type StoredSession } from './session';
import { AdminToggle } from './AdminToggle';
import { ACCENT_HEX, ROLE_ACCENT } from './accents';
import {
  CheckIcon, DoorIcon, EyeIcon, PinIcon, RoomIcon, StairsIcon, UsersIcon,
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
  full: 'ĐÃ CÓ NGƯỜI',
  self: 'MÁY NÀY',
  pending: 'ĐANG VÀO…',
  unknown: 'CHƯA XÁC MINH',
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
  const loading = useRef(false);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const entering = useRef(false);
  const lastRead = useRef(0);

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

  /** V3.4.1 declutter: the picker states each fact once. The card already shows the
   *  seat count and the availability word, so the meters drop their explanatory
   *  notes, the section headings drop (they restated the card titles), the duty
   *  line drops (it is the first CTA on the station's own screen) and the tagline
   *  drops with them. The `aria-label` keeps the full sentence for readers.
   *
   *  A duty seat prints no figure at all: its capacity is one, so "0/1" and
   *  "CÒN TRỐNG" are the same answer twice on the same line, and the aggregate
   *  above already totals the four. The viewer band keeps its n/10 — there the
   *  number is the only way to see how many people are watching. */
  const seatFigure = (role: Role, slot: { devices?: number } | undefined, known: boolean) =>
    SEAT_CAPACITY[role] > 1
      ? (known ? `${slot?.devices ?? 0}/${SEAT_CAPACITY[role]}` : `—/${SEAT_CAPACITY[role]}`)
      : null;
  return (
    <main className="home-shell safe-top safe-bottom" data-testid="scream-home" data-event={eventClosed ? 'closed' : 'open'}>
      <div className="home-content">
        <header className="home-header">
          <div className="home-brand">
            <span className="home-brand-word">SCREAM NIGHT</span>
            <span className="home-brand-room"><span className="home-signal" aria-hidden />ROOM 305</span>
          </div>
          <div className="home-title-row"><h1 className="home-title">CHỌN VỊ TRÍ</h1>
            <AdminToggle disabled={!canSelect || busy !== null} onEnter={onEnter} />
          </div>
        </header>

        <section className="home-overview card" aria-label="Tổng quan bảng vị trí" data-testid="home-overview" data-fresh={fresh ? '1' : '0'} data-busy={floorBusy ? '1' : '0'}>
          <div
            className="home-roster"
            role="img"
            aria-label={`Phân công bốn vị trí: ${STATION_ROLES.map(role => {
              const state = seatState(role, 1);
              return `${ROLE_PERSON[role]} ${SEAT_WORD[state].toLowerCase()}`;
            }).join(', ')}.`}
          >
            <svg className="home-roster-ring" viewBox="0 0 72 72" aria-hidden>
              <circle cx="36" cy="36" r="28" />
            </svg>
            <span className="home-roster-point" data-state={seatState('LOBBY', 1)} style={{ '--point-angle': '0deg' } as CSSProperties} aria-hidden />
            <span className="home-roster-point" data-state={seatState('CORRIDOR', 1)} style={{ '--point-angle': '90deg' } as CSSProperties} aria-hidden />
            <span className="home-roster-point" data-state={seatState('GATE', 1)} style={{ '--point-angle': '180deg' } as CSSProperties} aria-hidden />
            <span className="home-roster-point" data-state={seatState('ROOM305', 1)} style={{ '--point-angle': '270deg' } as CSSProperties} aria-hidden />
            <span className="home-roster-center">
              <span className="home-roster-count digital" data-testid="station-count">
                {dutyDevices === null ? '—/4' : `${dutyDevices}/4`}
              </span>
              <span className="home-roster-label">VỊ TRÍ</span>
            </span>
          </div>
          {floorBusy ? (
            <p className="home-overview-busy" data-testid="home-floor-busy">
              {RESET_BLOCK_LABEL[(blockReason ?? 'RUNNING') as keyof typeof RESET_BLOCK_LABEL]}
            </p>
          ) : null}
        </section>

        <section className="home-duty" aria-label="Bốn vị trí trực">
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
                  aria-label={`${ROLE_PERSON[role]} — ${ROLE_AREA[role]}. ${SEAT_WORD[state]}`}
                  onClick={() => openStation(role)}>
                  <span className="home-station-icon" aria-hidden><Icon className="h-5 w-5" /></span>
                  <span className="home-station-id">
                    <strong>{ROLE_PERSON[role]}</strong>
                    <span className="home-station-area"><PinIcon className="home-station-pin" />{ROLE_AREA[role]}</span>
                  </span>
                  <span className="home-station-state">
                    {seatFigure(role, slot, known) !== null ? (
                      <span className="home-station-seat digital" data-testid={`station-seat-count-${role}`}>
                        {seatFigure(role, slot, known)}
                      </span>
                    ) : null}
                    <span className="badge" data-tone={
                      state === 'available' ? 'available' : state === 'self' ? 'confirmed' : state === 'full' ? 'full' : state === 'pending' ? 'live' : 'queued'
                    }>
                      {state === 'available' ? <span className="home-badge-plus" aria-hidden>+</span> : null}
                      {state === 'full' ? <CheckIcon /> : null}
                      {SEAT_WORD[state]}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="home-viewer" aria-label="Quan sát trực tiếp">
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
                  <strong>XEM TRỰC TIẾP</strong>
                  <small>Chỉ xem</small>
                </span>
                <span className="home-observer-state">
                  <span className="digital" data-testid="observer-seat-count">{known ? `${slot?.devices ?? 0}/${OBSERVER_CAPACITY}` : `—/${OBSERVER_CAPACITY}`}</span>
                  {/* The same word has to look the same everywhere on this board:
                      ember for a seat that is there to take, jade only for the seat
                      this device already holds. The viewer card used to paint
                      "CÒN TRỐNG" in the confirmed tone, which reads as done. */}
                  <span className="badge" data-tone={
                    state === 'available' ? 'available' : state === 'self' ? 'confirmed' : state === 'pending' ? 'live' : state === 'full' ? 'full' : 'queued'
                  }>
                    {state === 'available' ? <span className="home-badge-plus" aria-hidden>+</span> : null}
                    {state === 'full' ? <CheckIcon /> : null}
                    {state === 'full' ? `ĐÃ ĐỦ ${OBSERVER_CAPACITY} CHỖ` : SEAT_WORD[state]}
                  </span>
                </span>
              </button>
            );
          })()}
        </section>

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
              Chưa đọc được vị trí. Kiểm tra kết nối.
            </p>
            <button
              type="button"
              onClick={() => void refresh.current()}
              className="home-board-retry"
              data-testid="home-board-retry"
            >
              THỬ LẠI
            </button>
          </div>
        ) : null}
        {eventClosed ? (
          <p className="notice-band" data-tone="info" role="status" data-testid="home-event-closed">
            <span><strong className="home-closed-strong">SỰ KIỆN ĐÃ KẾT THÚC.</strong>{' '}
            Quản trị: <strong className="home-closed-key">MỞ SỰ KIỆN MỚI</strong>.</span>
          </p>
        ) : null}
        {fresh && board && isClientStale(board.min_client_version) ? (
          <p className="notice-band" data-tone="danger" role="status" data-testid="home-bundle-stale">
            <span>Cần cập nhật. Đóng ứng dụng rồi mở lại.</span>
          </p>
        ) : null}
        <div aria-live="polite" className="home-feedback">
          {message || error ? <p role="alert" data-testid="home-error">{message ?? error}</p> :
            !fresh ? <p>Đang kết nối để kiểm tra vị trí…</p> : null}
        </div>
        <footer className="home-footer"><span>SCREAM CONTROL</span></footer>
      </div>
    </main>
  );
}
