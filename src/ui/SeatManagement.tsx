import { useCallback, useEffect, useState } from 'react';
import type { LiveStore } from '../client/liveStore';
import { USING_SUPABASE } from '../client/gateway';
// Types only here: the Supabase client stays out of the local-backend bundle,
// exactly as DetailsSheet keeps release_station behind a dynamic import.
import type { SeatReport, StationAdminResult } from '../client/supabaseAuth';
import { ACTION_LABEL, ROLE_LABEL, ROLE_PERSON, type Role } from '../shared/constants';
import { formatWallTime } from '../shared/metrics';

/**
 * V3.3 seat management — the one screen the operator reaches for when a tile
 * says "ĐÃ ĐỦ NGƯỜI" and nobody is standing there.
 *
 * It answers three questions in this order, because that is the order they are
 * asked at 11pm: WHO holds the seat, SINCE WHEN, and MAY I FREE IT NOW. Before
 * migration 0021 no screen could answer the first two at all — `sc.operators`
 * RLS lets a device read only itself, so the board could only ever report a
 * count, and a count is not a person.
 *
 * Deliberately narrow, per the brief: this frees a BINDING and nothing else.
 * It does not open an event (that is MỞ SỰ KIỆN MỚI), does not reset props
 * (that is the checklist) and does not cancel a round — PostgreSQL refuses a
 * floor seat while a team is inside, and this panel shows that verdict instead
 * of letting the tap fail.
 *
 * The report degrades on purpose: if `station_admin` is not in the database
 * yet (0021 not applied), the seats still list and still release through
 * `release_station`, which has existed since 0019, just without names.
 */

const DUTY_SEATS: Role[] = ['LOBBY', 'CORRIDOR', 'GATE', 'ROOM305', 'SUPERVISOR'];

/** A binding nobody has touched for this long is the walk-off we are looking
 *  for — described as an observation, never as a claimed connection state. */
const IDLE_HINT_MS = 10 * 60_000;

function agoLabel(ms: number | null, now: number): string {
  if (ms === null) return 'chưa thao tác';
  const diff = Math.max(0, now - ms);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'vừa thao tác';
  if (mins < 60) return `${mins} phút trước`;
  return `${Math.floor(mins / 60)} giờ trước`;
}

function heldLabel(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'vừa nhận';
  if (mins < 60) return `${mins} phút`;
  return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}`;
}

interface Props {
  store: LiveStore;
  /** Server time from the live snapshot, so ages follow the event clock. */
  now: number;
}

export function SeatManagement({ store, now }: Props) {
  const [report, setReport] = useState<StationAdminResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [armed, setArmed] = useState<Role | null>(null);
  const [busy, setBusy] = useState<Role | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const { stationAdmin } = await import('../client/supabaseAuth');
      const next = await stationAdmin();
      setReport(next);
    } catch {
      // No answer at all is still answerable: fall back to the unnamed seat
      // list so the release button is never the thing that is missing.
      setReport(null);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // One effect for both the first read and every later one: the board revision
  // moves on each command, and a release from another admin device changes
  // nothing else the operator is looking at. Following it keeps this list
  // truthful without adding a poll of its own, and the short settle avoids
  // firing two round trips on mount.
  const revision = store.getSnapshot().snapshot?.event.revision ?? 0;
  useEffect(() => {
    if (!USING_SUPABASE) return;
    const id = window.setTimeout(() => void load(), 400);
    return () => window.clearTimeout(id);
  }, [revision, load]);

  const release = async (target: Role) => {
    setBusy(target);
    setArmed(null);
    setResult(null);
    try {
      const { releaseStation, releaseErrorMessage } = await import('../client/supabaseAuth');
      const done = await releaseStation(target);
      setResult(done.ok
        ? `ĐÃ GIẢI PHÓNG ${ROLE_PERSON[target]} — ${done.freed ?? 0} thiết bị, các máy khác vẫn trực bình thường`
        : releaseErrorMessage(done));
      // The picker has to say CÒN TRỐNG now, not on the next heartbeat.
      window.setTimeout(() => void store.refresh(), 250);
      void load();
    } catch {
      setResult('MẤT KẾT NỐI — CHƯA GIẢI PHÓNG ĐƯỢC. KIỂM TRA MẠNG RỒI BẤM LẠI');
    } finally {
      setBusy(null);
    }
  };

  if (!USING_SUPABASE) {
    return (
      <p className="text-[0.68rem] text-mute" data-testid="seat-mgmt-unavailable">
        Bảng vị trí chỉ có trên máy chủ sự kiện.
      </p>
    );
  }

  // Without the 0021 report we cannot know the floor verdict, so we never claim
  // a seat is blocked: the buttons stay live and PostgreSQL gives the answer.
  const knowsFloor = report?.ok === true;

  // Degraded mode (0021 not applied — Production today). The live snapshot
  // already lists which roles a device is currently bound to, so the panel can
  // still say "ĐANG GIỮ" instead of falsely reporting every seat as free. It
  // just cannot name the individual phone, and it says so.
  //
  // Trap worth naming: sc.operator_states() emits a row for all five roles
  // whether or not anybody holds the seat, and marks an empty one with a null
  // display_name. Presence has to be read from that, never from row count.
  const bound = new Set<Role>(
    (store.getSnapshot().snapshot?.operators ?? [])
      .filter((o) => o.role !== 'OBSERVER' && Boolean(o.display_name))
      .map((o) => o.role),
  );
  const stations: SeatReport[] = report?.stations
    ?? DUTY_SEATS.map((role) => ({
      role,
      capacity: role === 'SUPERVISOR' ? 2 : 1,
      devices: bound.has(role) ? 1 : 0,
      holders: [],
      releasable: true,
    }));
  const blockReason = report?.floor_block_reason ?? null;

  return (
    <div className="flex flex-col gap-2" data-testid="seat-management">
      <div className="flex items-start justify-end gap-2">
        {/* V3.4.1: the heading inside this panel spelled “QUẢN LÝ VỊ TRÍ” a second
            time, one row under the group heading of the same name. The refresh
            keeps its place at the right edge. */}
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="text-[0.64rem] text-ember underline underline-offset-2 disabled:opacity-50"
          data-testid="seat-mgmt-refresh"
        >
          {loading ? 'ĐANG TẢI…' : 'LẤY LẠI'}
        </button>
      </div>

      <p className="text-[0.66rem] leading-snug text-mute">
        Chạm hai lần để giải phóng vị trí.
      </p>

      {knowsFloor && blockReason !== null && (
        <p className="rounded-panel border border-ember/40 bg-ember/5 px-2.5 py-2 text-[0.66rem] leading-snug text-ember"
           data-testid="seat-mgmt-floor">
          {blockReason === 'RUNNING'
            ? 'Đội đang chơi. Chốt lượt trước khi giải phóng.'
            : blockReason === 'PENDING_CLAIM'
              ? 'Còn lần báo chờ xét. Vị trí đang khóa.'
              : 'Còn lượt chưa đóng. Cần chốt trước khi bàn giao.'}
        </p>
      )}

      <ul className="flex flex-col divide-y divide-hair/40" data-testid="seat-mgmt-list">
        {stations.map((seat) => {
          const held = seat.devices > 0;
          const canRelease = seat.releasable && seat.role !== 'SUPERVISOR';
          const isArmed = armed === seat.role;
          const isBusy = busy === seat.role;
          return (
            <li key={seat.role} className="flex flex-col gap-1.5 py-2" data-testid={`seat-row-${seat.role}`}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[0.74rem] font-semibold text-snow">{ROLE_LABEL[seat.role]}</span>
                <span
                  className={`text-[0.66rem] font-semibold ${
                    held ? (canRelease || seat.role === 'SUPERVISOR' ? 'text-ember' : 'text-mute') : 'text-jade'
                  }`}
                  data-testid={`seat-state-${seat.role}`}
                >
                  {held
                    ? `${seat.devices}/${seat.capacity} ĐANG GIỮ`
                    : seat.role === 'SUPERVISOR' ? 'TRỐNG' : 'CÒN TRỐNG'}
                </span>
              </div>

              {seat.holders.map((h) => {
                const idle = h.held_ms > IDLE_HINT_MS
                  && (h.last_action_ms === null || now - h.last_action_ms > IDLE_HINT_MS);
                return (
                  <div key={h.user_id} className="flex flex-col gap-0.5 pl-1" data-testid={`seat-holder-${seat.role}`}>
                    <p className="text-[0.68rem] text-snow">
                      {h.display_name ?? 'Chưa đặt tên'}
                      <span className="ml-1 text-[0.62rem] text-mute">· máy {h.user_id.slice(0, 8)}</span>
                    </p>
                    <p className="text-[0.62rem] text-mute" data-testid={`seat-holder-meta-${seat.role}`}>
                      giữ {heldLabel(h.held_ms)} · từ {formatWallTime(h.bound_at_ms)}
                      {' · '}
                      {h.last_action
                        ? `${ACTION_LABEL[h.last_action] ?? 'thao tác khác'} ${agoLabel(h.last_action_ms, now)}`
                        : 'chưa thao tác'}
                      {idle ? ' · có thể đã bỏ máy' : ''}
                    </p>
                  </div>
                );
              })}

              {/* V3.4.1: “Chưa có thiết bị nào nhận ghế này.” restated the CÒN TRỐNG
                  word on the same line of the same row. */}

              {seat.role !== 'SUPERVISOR' && (
                <button
                  type="button"
                  disabled={isBusy || (knowsFloor && !canRelease) || busy !== null}
                  onClick={() => { if (!isArmed) { setArmed(seat.role); setResult(null); return; } void release(seat.role); }}
                  className={`rounded-panel border px-3 py-2.5 text-[0.72rem] font-semibold disabled:opacity-45 ${
                    isArmed ? 'border-blood/60 bg-blood/10 text-blood' : 'border-hair bg-panel text-snow'
                  }`}
                  data-testid={`seat-release-${seat.role}`}
                >
                  {isBusy
                    ? 'ĐANG GIẢI PHÓNG…'
                    : knowsFloor && !canRelease
                      ? 'KHÔNG ĐƯỢC — ĐANG CÓ LƯỢT'
                      : isArmed
                        ? `XÁC NHẬN GIẢI PHÓNG ${ROLE_PERSON[seat.role]}`
                        : held
                          ? `GIẢI PHÓNG ${ROLE_PERSON[seat.role]}`
                          : `KIỂM TRA ${ROLE_PERSON[seat.role]}`}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {armed !== null && (
        <p className="text-[0.64rem] leading-snug text-ember" data-testid="seat-mgmt-armed">
          Nhấn tiếp để thu hồi máy giữ {ROLE_LABEL[armed]}. Thao tác có ghi nhật ký.
        </p>
      )}
      {result !== null && (
        <p role="status" className="text-[0.68rem] leading-snug text-snow" data-testid="seat-mgmt-result">
          {result}
        </p>
      )}
      {failed && !loading && (
        <p className="text-[0.64rem] leading-snug text-mute" data-testid="seat-mgmt-degraded">
          Chưa đọc được thiết bị. Bấm lấy lại danh sách.
        </p>
      )}
    </div>
  );
}
