import * as Dialog from '@radix-ui/react-dialog';
import { useMemo, useState } from 'react';
import type { LiveStore } from '../client/liveStore';
import type { StoredSession } from './session';
import { analytics, formatClockMs, formatClockSec, formatDuration, formatSeconds, formatWallTime, leaderboard, roundMetrics } from '../shared/metrics';
import { OUTCOME_LABEL, RESET_TASKS, RESET_TASK_LABEL, REVIEW_REASON_LABEL, ROLE_LABEL, STATUS_LABEL, LAYOUTS, type Role } from '../shared/constants';
import { eventRemainingMs, isGameRunning } from '../shared/machine';
import { disputedRounds } from '../shared/metrics';
import { pad } from '../client/selectors';
import { alarms } from './sound';
import { StationStrip } from './StationStrip';
import type { Round } from '../shared/types';

interface Props {
  open: boolean;
  onClose(): void;
  store: LiveStore;
  account: StoredSession['account'];
  now: number;
  /** Opens the wall display; present while a game is running. */
  onOpenBigScreen?(): void;
  onLogout?(): void;
}

/** Bottom sheet: never navigates away, so live timers keep rendering underneath. */
export function DetailsSheet({ open, onClose, store, account, now, onOpenBigScreen, onLogout }: Props) {
  const state = store.getSnapshot();
  const snap = state.snapshot;
  const isSupervisor = account.role === 'SUPERVISOR';

  const rows = useMemo(() => (snap ? leaderboard(snap) : []), [snap]);
  const stats = useMemo(() => (snap ? analytics(snap, now) : null), [snap, now]);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-overlay" />
        <Dialog.Content className="sheet-content flex flex-col" data-testid="details-sheet" aria-describedby={undefined}>
          <header className="flex items-center justify-between border-b border-hair px-4 py-3">
            <Dialog.Title className="text-[0.8rem] font-semibold tracking-[0.16em] text-snow">
              {snap ? `${snap.rounds.length} LƯỢT · SỰ KIỆN ${formatClockSec(eventRemainingMs(snap.event, now) ?? 0)}` : 'ĐANG ĐỒNG BỘ'}
            </Dialog.Title>
            <Dialog.Close className="rounded px-3 py-1 text-[0.85rem] text-mute" data-testid="close-details">
              Đóng
            </Dialog.Close>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {!snap ? (
              <p className="py-10 text-center text-[0.8rem] text-mute">Đang tải dữ liệu…</p>
            ) : (
              <div className="flex flex-col gap-2">
                {/* Wall display + station switch: the only two actions that are not
                    a handoff, so they live here instead of the operator screen. */}
                <div className="flex gap-2">
                  {isGameRunning(snap.active_round) && onOpenBigScreen && (
                    <button
                      type="button"
                      onClick={onOpenBigScreen}
                      className="flex-1 rounded-[10px] border border-hair bg-panel px-3 py-2.5 text-[0.72rem] font-semibold text-snow active:bg-panel2"
                      data-testid="sheet-big-screen"
                    >
                      MÀN HÌNH LỚN
                    </button>
                  )}
                  {onLogout && (
                    <button
                      type="button"
                      onClick={onLogout}
                      className="flex-1 rounded-[10px] border border-hair bg-panel px-3 py-2.5 text-[0.72rem] text-mute active:bg-panel2"
                      data-testid="logout"
                    >
                      ĐỔI MÁY
                    </button>
                  )}
                </div>
                <Section title="Chi tiết lượt chơi" testid="section-rounds">
                  <RoundDetails snap={snap} now={now} />
                </Section>
                <Section title="Trạng thái NPC" testid="section-npc">
                  <NpcStatus snap={snap} account={account} store={store} now={now} />
                </Section>
                <Section title="Bảng xếp hạng" testid="section-leaderboard">
                  {rows.length === 0 ? (
                    <p className="py-3 text-[0.75rem] text-mute">Chưa có đội hoàn thành trận đồ trong 5:00.</p>
                  ) : (
                    <table className="w-full text-[0.75rem]" data-testid="leaderboard-table">
                      <thead className="text-mute">
                        <tr className="text-left">
                          <th className="py-1 font-normal">#</th>
                          <th className="py-1 font-normal">Đội</th>
                          <th className="py-1 text-right font-normal">Thời gian</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => (
                          <tr key={r.round_id} className="border-t border-hair/60">
                            <td className="py-1.5 text-ember">{r.rank}</td>
                            <td className="py-1.5">#{pad(r.team_number)}{r.team_name ? ` · ${r.team_name}` : ''}</td>
                            <td className="digital py-1.5 text-right text-snow">{formatClockMs(r.duration_ms)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </Section>
                <Section title="Hiệu suất vận hành" testid="section-performance">
                  {stats && <Performance stats={stats} store={store} now={now} />}
                </Section>
                <Section title="Kết nối & cảnh báo" testid="section-connectivity">
                  <Connectivity store={store} now={now} />
                </Section>
                <Section title="Lịch sử thao tác" testid="section-history">
                  <History snap={snap} />
                </Section>
                {isSupervisor && (
                  <Section title="Quản lý" testid="section-admin">
                    <Management store={store} snap={snap} />
                  </Section>
                )}
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ------------------------------------------------------------------ sections */

function Section({ title, testid, children }: { title: string; testid: string; children: React.ReactNode }) {
  return (
    <details className="rounded-panel border border-hair bg-ink/40" data-testid={testid}>
      <summary className="cursor-pointer list-none px-3 py-3 text-[0.8rem] font-semibold tracking-[0.08em] text-snow marker:hidden">
        {title}
        <span className="float-right text-mute">＋</span>
      </summary>
      <div className="border-t border-hair/60 px-3 py-3">{children}</div>
    </details>
  );
}

function Row({ k, v, tone = 'text-snow' }: { k: string; v: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-hair/40 py-1.5 last:border-0">
      <span className="text-[0.72rem] text-mute">{k}</span>
      <span className={`digital text-[0.75rem] ${tone}`}>{v}</span>
    </div>
  );
}

function RoundDetails({ snap, now }: { snap: NonNullable<ReturnType<LiveStore['getSnapshot']>['snapshot']>; now: number }) {
  const rounds = [...snap.rounds].reverse().slice(0, 6);
  if (rounds.length === 0) return <p className="text-[0.75rem] text-mute">Chưa có lượt chơi nào.</p>;
  return (
    <div className="flex flex-col gap-3">
      {rounds.map((r) => {
        // One source for the score: the flexible 5:00 window (pauses excluded).
        const m = roundMetrics(r, snap.reset_tasks, now);
        return (
          <div key={r.id} data-testid={`round-detail-${r.team_number}`}>
            <p className="mb-1 text-[0.75rem] font-semibold text-snow">
              TEAM #{pad(r.team_number)} <span className="text-mute">· {STATUS_LABEL[r.status]}</span>
            </p>
            <Row k="Gọi đội" v={r.called_at ? formatWallTime(r.called_at) : '—'} />
            <Row k="Bắt đầu trận" v={r.game_started_at ? formatWallTime(r.game_started_at) : '—'} />
            <Row k="Chốt giờ" v={r.game_stopped_at ? formatWallTime(r.game_stopped_at) : '—'} />
            <Row
              k="Điểm chính thức"
              v={m.game_ms === null ? '—' : formatClockMs(m.game_ms)}
              tone={m.game_ms !== null && m.game_ms > snap.event.config.game_limit_ms ? 'text-blood' : 'text-snow'}
            />
            <Row k="Chuẩn bị" v={formatSeconds(m.prep_ms)} />
            {r.game_reset_count > 0 && (
              <Row k="Reset 5:00 giữa trận" v={`${r.game_reset_count} lần`} tone="text-ember" />
            )}
            {r.game_pause_count > 0 && <Row k="Tạm dừng 5:00" v={`${r.game_pause_count} lần`} tone="text-ember" />}
            <Row k="Reset tổng" v={formatSeconds(m.reset_total_ms)} tone={isSlowReset(m.reset_total_ms, snap.event.config.reset_target_ms) ? 'text-ember' : 'text-snow'} />
            <Row k="Reset hành lang" v={formatSeconds(m.corridor_reset_ms)} />
            <Row k="Reset phòng 305" v={formatSeconds(m.room_reset_ms)} />
            <Row k="GATE chốt khu vực" v={formatSeconds(m.gate_clear_ms)} />
            <Row k="Kết quả" v={OUTCOME_LABEL[r.outcome]} tone={r.outcome === 'WON' ? 'text-jade' : r.outcome === 'TIMEOUT' ? 'text-blood' : 'text-mute'} />
            {r.needs_review && (
              <p className="mt-1 text-[0.68rem] text-ember" data-testid={`review-${r.team_number}`}>
                CHỜ XÉT: {r.review_reasons.map((x) => REVIEW_REASON_LABEL[x] ?? x).join(' · ')}
              </p>
            )}
            {r.decertified && <p className="mt-1 text-[0.68rem] text-blood">Đã bị loại khỏi bảng xếp hạng (có nhật ký).</p>}
            {r.stop_transport_ms !== null && (
              <p className="mt-1 text-[0.66rem] text-mute">
                Network của nhịp CHỐT GIỜ: {r.stop_transport_ms} ms (không trừ vào điểm)
              </p>
            )}
            {m.admitted_by_override && <p className="mt-1 text-[0.68rem] text-ember">Vào trận bằng ngoại lệ có nhật ký kiểm toán.</p>}
          </div>
        );
      })}
    </div>
  );
}

function isSlowReset(value: number | null, target: number | null): boolean {
  return value !== null && target !== null && value > target * 1.5;
}

function NpcStatus({
  snap,
  account,
  store,
  now,
}: {
  snap: NonNullable<ReturnType<LiveStore['getSnapshot']>['snapshot']>;
  account: StoredSession['account'];
  store: LiveStore;
  now: number;
}) {
  const round = snap.active_round;
  const tasks = round ? snap.reset_tasks.filter((t) => t.round_id === round.id) : [];
  const byRole = (role: Role) => tasks.filter((t) => t.required_role === role);
  const owner = snap.event.config.hidden_object_owner;
  const canSetLayout = account.role === 'SUPERVISOR' || account.role === owner;
  return (
    <div className="flex flex-col gap-1.5" data-testid="npc-status">
      {/* The five-station relay lives here: on the main screen the journey strip
          already names the next press, so the relay is detail, not a second voice. */}
      <StationStrip snap={snap} now={now} self={account.role} className="mb-2" />
      {snap.operators.map((op) => {
        const own = byRole(op.role);
        const state = own.length === 0 ? '—' : own.every((t) => t.completed_at !== null) ? 'XONG' : 'ĐANG LÀM';
        return (
          <div key={op.role} className="flex items-center justify-between gap-2 border-b border-hair/40 py-1.5 last:border-0">
            <div className="min-w-0">
              <p className="text-[0.72rem] font-semibold text-snow">{ROLE_LABEL[op.role]}</p>
              <p className="truncate text-[0.66rem] text-mute">
                {op.last_action ? `${op.last_action} · ${op.last_action_at ? formatWallTime(op.last_action_at) : ''}` : 'chưa thao tác'}
              </p>
            </div>
            <span
              className={`shrink-0 rounded px-2 py-1 text-[0.62rem] font-semibold tracking-[0.08em] ${
                state === 'XONG' ? 'bg-jade/15 text-jade' : state === 'ĐANG LÀM' ? 'bg-ember/15 text-ember' : 'bg-panel text-mute'
              }`}
              data-testid={`npc-${op.role}`}
            >
              {state}
            </span>
          </div>
        );
      })}
      {round && tasks.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          {tasks.map((t) => (
            <Row
              key={t.task_key}
              k={RESET_TASK_LABEL[t.task_key]}
              v={
                t.completed_at && t.cycle === (round.reset_cycle ?? 1)
                  ? `${t.confirmed_by_role ?? ''} ${formatWallTime(t.completed_at)}${t.layout ? ` · ${t.layout}` : ''}`
                  : 'chờ'
              }
              tone={t.completed_at && t.cycle === (round.reset_cycle ?? 1) ? 'text-jade' : 'text-ember'}
            />
          ))}
        </div>
      )}

      {/* Scenario C: one responsible operator prepares the layout, everyone can read it. */}
      <div className="mt-3 rounded-panel border border-hair px-3 py-2" data-testid="layout-block">
        <p className="text-[0.68rem] text-mute">
          Bố trí vật ẩn · <span className="text-snow">{snap.event.config.hiding_layout}</span> · do {owner} chuẩn bị
        </p>
        {canSetLayout && (
          <div className="mt-2 flex gap-2">
            {LAYOUTS.map((l) => (
              <button
                key={l}
                type="button"
                disabled={l === snap.event.config.hiding_layout}
                onClick={() => void store.act('SET_LAYOUT', { layout: l })}
                className={`flex-1 rounded border px-2 py-2 text-[0.72rem] ${
                  l === snap.event.config.hiding_layout ? 'border-jade text-jade' : 'border-hair text-mute'
                }`}
                data-testid={`layout-${l}`}
              >
                {l}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Connectivity({ store, now }: { store: LiveStore; now: number }) {
  const state = store.getSnapshot();
  const snap = state.snapshot;
  const age = store.dataAgeMs();
  return (
    <div data-testid="connectivity">
      <Row k="Trạng thái" v={state.status} tone={state.status === 'CONNECTED' ? 'text-jade' : 'text-ember'} />
      <Row k="Bản trạng thái (revision)" v={String(state.revision)} />
      <Row k="Đọc máy chủ gần nhất cách" v={age === null ? 'chưa đọc' : `${Math.round(age / 1000)}s`} />
      <Row k="Độ trễ vòng gọi (RTT)" v={state.rttMs === null ? 'chưa đo' : `${Math.round(state.rttMs)} ms`} />
      <Row
        k="Sai số hiển thị tối đa"
        v={state.maxDisplayErrorMs === null ? 'chưa hiệu chỉnh' : `±${state.maxDisplayErrorMs} ms`}
      />
      <Row
        k="Âm thanh cảnh báo"
        v={
          alarms.status() === 'READY' ? 'SẴN SÀNG' : alarms.status() === 'UNSUPPORTED' ? 'KHÔNG HỖ TRỢ' : 'CHƯA BẬT'
        }
        tone={alarms.status() === 'READY' ? 'text-jade' : 'text-ember'}
      />
      <button
        type="button"
        onClick={() => {
          alarms.unlock();
          void store.recover();
        }}
        className="mt-2 w-full rounded-panel border border-hair px-3 py-3 text-[0.75rem] text-snow"
        data-testid="recheck-connection"
      >
        KIỂM TRA LẠI KẾT NỐI & ÂM THANH
      </button>
      <p className="mt-2 text-[0.66rem] leading-relaxed text-mute">
        {snap ? `Đồng hồ máy chủ: ${formatWallTime(snap.server_now_ms)} · máy này: ${formatWallTime(now)}` : 'Chưa đọc được trạng thái máy chủ.'}
      </p>
      <p className="mt-1 text-[0.62rem] leading-relaxed text-mute">
        Giới hạn: các điện thoại có thể lệch nhau vài phần chục giây vì mạng; điểm chính thức luôn lấy từ máy chủ, không
        lấy từ số đang hiển thị.
      </p>
    </div>
  );
}

function Performance({ stats, store, now }: { stats: ReturnType<typeof analytics>; store: LiveStore; now: number }) {
  const state = store.getSnapshot();
  return (
    <div data-testid="performance">
      <Row k="Đội đã xử lý" v={String(stats.teams_completed)} />
      <Row k="Đội thành công" v={String(stats.teams_successful)} tone="text-jade" />
      <Row
        k="Kết quả chờ xét"
        v={String(stats.disputed)}
        tone={stats.disputed > 0 ? 'text-ember' : 'text-snow'}
      />
      <Row k="Quá giờ" v={String(stats.timeouts)} tone={stats.timeouts > 0 ? 'text-blood' : 'text-snow'} />
      <Row k="TB thời gian chơi (thành công)" v={formatSeconds(stats.avg_game_ms, 2)} />
      <Row k="TB chuẩn bị" v={formatSeconds(stats.avg_prep_ms)} />
      <Row k="TB reset" v={formatSeconds(stats.avg_reset_ms)} />
      <Row k="TB chu kỳ start→start" v={formatDuration(stats.avg_cycle_ms)} />
      <Row
        k="Nút thắt dài nhất"
        v={stats.longest_reset ? `reset #${pad(stats.longest_reset.team_number)} ${formatSeconds(stats.longest_reset.ms)}` : '—'}
        tone="text-ember"
      />
      <Row k="Tổng thời gian chờ" v={formatDuration(stats.total_idle_ms)} />
      <Row k="Overtime sự kiện" v={formatDuration(stats.total_overtime_ms)} tone={stats.total_overtime_ms > 0 ? 'text-blood' : 'text-snow'} />
      <Row k="Reset 5:00 (toàn sự kiện)" v={String(stats.clock_resets)} tone={stats.clock_resets > 0 ? 'text-ember' : 'text-snow'} />
      <Row k="Tạm dừng 5:00 (toàn sự kiện)" v={String(stats.clock_pauses)} tone={stats.clock_pauses > 0 ? 'text-ember' : 'text-snow'} />
      <Row
        k="Ước tính còn lại"
        v={stats.remaining_capacity_estimate === null ? '—' : `≈ ${stats.remaining_capacity_estimate} đội (ước tính)`}
      />
      <div className="mt-3 rounded-panel border border-hair px-3 py-2 text-[0.66rem] leading-relaxed text-mute" data-testid="sync-quality">
        Đồng bộ hiển thị: offset máy khách đã hiệu chỉnh bằng RTT. RTT trung vị {state.maxDisplayErrorMs === null ? '—' : 'đã đo'}, sai số
        tối đa ước tính {state.maxDisplayErrorMs === null ? 'chưa đồng bộ' : `${state.maxDisplayErrorMs} ms`} · now = {formatWallTime(now)}
      </div>
    </div>
  );
}

function History({ snap }: { snap: NonNullable<ReturnType<LiveStore['getSnapshot']>['snapshot']> }) {
  const entries = [...snap.log].reverse().slice(0, 80);
  return (
    <ul className="flex flex-col gap-1.5" data-testid="history">
      {entries.map((l) => (
        <li key={l.seq} className="border-b border-hair/40 pb-1.5 text-[0.7rem] last:border-0">
          <div className="flex items-baseline justify-between gap-2">
            <span className="digital text-mute">{formatWallTime(l.at_ms)}</span>
            <span className="text-[0.62rem] tracking-[0.08em] text-mute">rev {l.revision}</span>
          </div>
          <p className="text-snow">
            {l.metadata?.detail_text ? String(l.metadata.detail_text) : l.action}
            {l.team_number !== null ? <span className="text-mute"> · #{pad(l.team_number)}</span> : null}
          </p>
          <p className="text-[0.62rem] text-mute">
            {l.actor_role}
            {l.actor_id === 'system.clock' ? ' (tự động)' : ` · ${l.actor_id}`}
            {l.from_state && l.to_state ? ` · ${l.from_state} → ${l.to_state}` : ''}
            {l.metadata?.reason ? ` · lý do: ${String(l.metadata.reason)}` : ''}
          </p>
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------- management */

function Management({ store, snap }: { store: LiveStore; snap: NonNullable<ReturnType<LiveStore['getSnapshot']>['snapshot']> }) {
  const [prep, setPrep] = useState(String(Math.round(snap.event.config.prep_allowance_ms / 1000)));
  const [target, setTarget] = useState(snap.event.config.reset_target_ms === null ? '' : String(Math.round(snap.event.config.reset_target_ms / 1000)));
  const [owner, setOwner] = useState(snap.event.config.hidden_object_owner);
  const [reason, setReason] = useState('');
  const [reopen, setReopen] = useState<{ round_id: string; task_key: string; reason: string }>({
    round_id: '',
    task_key: 'hidden_objects',
    reason: '',
  });
  const [review, setReview] = useState<{ round_id: string; reason: string }>({ round_id: '', reason: '' });
  const [closeReason, setCloseReason] = useState('');
  const [correction, setCorrection] = useState<{ round_id: string; field: string; value: string }>({
    round_id: '',
    field: 'game_stopped_at',
    value: '',
  });
  const started = snap.event.event_started_at !== null;
  const round: Round | null = snap.active_round;
  const disputed = disputedRounds(snap.rounds);
  const reopenable = snap.rounds.filter(
    (r) => (r.status !== 'GATE_CLEARED' && r.game_stopped_at !== null) || (r.system_ready_at !== null && r.id === snap.rounds.at(-1)?.id),
  );

  const saveConfig = () =>
    store.act('CONFIGURE', {
      prep_allowance_ms: Math.max(0, Number(prep) || 0) * 1000,
      reset_target_ms: target.trim() === '' ? null : Math.max(0, Number(target) || 0) * 1000,
      hidden_object_owner: owner,
    });

  const exportCsv = () => {
    const lines = ['team_number,outcome,official_ms,prep_ms,reset_ms,corridor_ms,room_ms,gate_ms'];
    for (const r of snap.rounds) {
      const m = roundMetrics(r, snap.reset_tasks);
      lines.push(
        [r.team_number, r.outcome, m.game_ms ?? '', m.prep_ms ?? '', m.reset_total_ms ?? '', m.corridor_reset_ms ?? '', m.room_reset_ms ?? '', m.gate_clear_ms ?? ''].join(','),
      );
    }
    lines.push('');
    lines.push('revision,at_iso,action,actor_role,actor_id,from_state,to_state,idempotency_key');
    for (const l of snap.log) {
      lines.push([l.revision, new Date(l.at_ms).toISOString(), l.action, l.actor_role, l.actor_id, l.from_state ?? '', l.to_state ?? '', l.idempotency_key].join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `scream-305-${new Date(snap.server_now_ms).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="flex flex-col gap-4" data-testid="management">
      <div className="flex flex-col gap-2">
        <p className="text-[0.7rem] tracking-[0.1em] text-mute">CUỒI SỰ KIỆN (SUPERVISOR)</p>
        <p className="text-[0.7rem] text-mute">
          Thời lượng sự kiện {Math.round(snap.event.config.event_duration_ms / 60000)} phút · giới hạn trận{' '}
          {Math.round(snap.event.config.game_limit_ms / 1000)} giây (mặc định bảo vệ, chỉ đổi trước khi chạy).
        </p>
        {!started && (
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[0.68rem] text-mute">
              Dự bị lên tầng (s)
              <input value={prep} onChange={(e) => setPrep(e.target.value)} inputMode="numeric" className="mt-1 w-full rounded border border-hair bg-ink px-2 py-2 text-[0.75rem] text-snow" data-testid="cfg-prep" />
            </label>
            <label className="text-[0.68rem] text-mute">
              Mục tiêu reset (s, trống = không)
              <input value={target} onChange={(e) => setTarget(e.target.value)} inputMode="numeric" className="mt-1 w-full rounded border border-hair bg-ink px-2 py-2 text-[0.75rem] text-snow" data-testid="cfg-target" />
            </label>
          </div>
        )}
        <label className="text-[0.68rem] text-mute">
          Người đặt lại vật ẩn
          <select value={owner} onChange={(e) => setOwner(e.target.value as Role & typeof owner)} className="mt-1 w-full rounded border border-hair bg-ink px-2 py-2 text-[0.75rem] text-snow" data-testid="cfg-owner">
            <option value="CORRIDOR">CORRIDOR</option>
            <option value="GATE">GATE</option>
          </select>
        </label>
        <button type="button" onClick={saveConfig} className="rounded-panel border border-hair px-3 py-3 text-[0.75rem] text-snow" data-testid="cfg-save">
          LƯU CẤU HÌNH
        </button>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-[0.7rem] tracking-[0.1em] text-mute">KIỂM SOÁT KHẨN CẤP</p>
        {!started ? (
          <p className="rounded-panel border border-hair bg-ink px-3 py-3 text-[0.7rem] leading-snug text-mute" data-testid="admin-start-hint">
            Đồng hồ 90:00 mở khi LOBBY gọi đội đầu tiên — không cần bấm bắt đầu sự kiện.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <input
              value={closeReason}
              onChange={(e) => setCloseReason(e.target.value)}
              placeholder="Lý do đóng sự kiện sớm (bắt buộc, vào nhật ký)"
              className="rounded border border-hair bg-ink px-2 py-2 text-[0.75rem] text-snow"
              data-testid="close-reason"
            />
            <button
              type="button"
              disabled={!closeReason.trim()}
              onClick={() => {
                void store.act('END_EVENT', { reason: closeReason.trim() });
                setCloseReason('');
              }}
              className="rounded-panel border border-hair px-3 py-4 text-[0.78rem] font-semibold text-snow disabled:opacity-50"
              data-testid="admin-end"
            >
              ĐÓNG SỰ KIỆN CÓ KIỂM SOÁT
            </button>
          </div>
        )}
        {round && (
          <>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Lý do can thiệp (bắt buộc)" className="rounded border border-hair bg-ink px-2 py-2 text-[0.75rem] text-snow" data-testid="admin-reason" />
            <button
              type="button"
              disabled={!reason.trim()}
              onClick={() => {
                void store.act('ABORT_ROUND', { reason: reason.trim() });
                setReason('');
              }}
              className="rounded-panel border border-blood/60 bg-blood/10 px-3 py-4 text-[0.78rem] font-bold text-blood disabled:opacity-50"
              data-testid="admin-abort"
            >
              DỪNG KHẨN CẤP ĐỘI #{pad(round.team_number)}
            </button>
          </>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-[0.7rem] tracking-[0.1em] text-mute">HIỆU CHỈNH CÓ NHẬT KÝ</p>
        <select value={correction.round_id} onChange={(e) => setCorrection({ ...correction, round_id: e.target.value })} className="rounded border border-hair bg-ink px-2 py-2 text-[0.75rem] text-snow" data-testid="corr-round">
          <option value="">Chọn đội…</option>
          {[...snap.rounds].reverse().map((r) => (
            <option key={r.id} value={r.id}>#{pad(r.team_number)} · {STATUS_LABEL[r.status]}</option>
          ))}
        </select>
        <div className="grid grid-cols-2 gap-2">
          <select value={correction.field} onChange={(e) => setCorrection({ ...correction, field: e.target.value })} className="rounded border border-hair bg-ink px-2 py-2 text-[0.7rem] text-snow" data-testid="corr-field">
            <option value="game_started_at">Bắt đầu trận</option>
            <option value="game_stopped_at">Chốt giờ</option>
            <option value="puzzle_completed_at">Trận đồ xong</option>
            <option value="exit_confirmed_at">Khách ra</option>
          </select>
        <input
          value={correction.value}
          onChange={(e) => setCorrection({ ...correction, value: e.target.value })}
          placeholder="epoch ms · để trống = hoàn tác mốc"
          inputMode="numeric"
          className="rounded border border-hair bg-ink px-2 py-2 text-[0.7rem] text-snow"
          data-testid="corr-value"
        />
        </div>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Lý do hiệu chỉnh (bắt buộc)" className="rounded border border-hair bg-ink px-2 py-2 text-[0.75rem] text-snow" data-testid="corr-reason" />
        <button
          type="button"
          disabled={!correction.round_id || !reason.trim()}
          onClick={() => {
            void store.act('CORRECT_ROUND', {
              round_id: correction.round_id,
              field: correction.field,
              value_ms: correction.value.trim() === '' ? null : Number(correction.value),
              reason: reason.trim(),
            });
            setReason('');
          }}
          className="rounded-panel border border-hair px-3 py-3 text-[0.75rem] text-snow disabled:opacity-50"
          data-testid="corr-apply"
        >
          ÁP DỤNG HIỆU CHỈNH
        </button>
      </div>

      {disputed.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-[0.7rem] tracking-[0.1em] text-ember">KẾT QUẢ CHỜ XÉT ({disputed.length})</p>
          <select
            value={review.round_id}
            onChange={(e) => setReview({ ...review, round_id: e.target.value })}
            className="rounded border border-hair bg-ink px-2 py-2 text-[0.75rem] text-snow"
            data-testid="review-round"
          >
            <option value="">Chọn đội tranh chấp…</option>
            {disputed.map((r) => (
              <option key={r.id} value={r.id}>
                #{pad(r.team_number)} · {r.official_duration_ms} ms · {r.review_reasons.join(', ')}
              </option>
            ))}
          </select>
          <input
            value={review.reason}
            onChange={(e) => setReview({ ...review, reason: e.target.value })}
            placeholder="Quyết định và lý do (bắt buộc)"
            className="rounded border border-hair bg-ink px-2 py-2 text-[0.75rem] text-snow"
            data-testid="review-reason"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!review.round_id || !review.reason.trim()}
              onClick={() => {
                void store.act('REVIEW_RESOLVE', {
                  round_id: review.round_id,
                  decision: 'ACCEPT',
                  reason: review.reason.trim(),
                });
                setReview({ round_id: '', reason: '' });
              }}
              className="flex-1 rounded-panel border border-jade/50 bg-jade/10 px-2 py-3 text-[0.72rem] font-semibold text-jade disabled:opacity-50"
              data-testid="review-accept"
            >
              CHẤP NHẬN
            </button>
            <button
              type="button"
              disabled={!review.round_id || !review.reason.trim()}
              onClick={() => {
                void store.act('REVIEW_RESOLVE', {
                  round_id: review.round_id,
                  decision: 'REJECT',
                  reason: review.reason.trim(),
                });
                setReview({ round_id: '', reason: '' });
              }}
              className="flex-1 rounded-panel border border-blood/50 bg-blood/10 px-2 py-3 text-[0.72rem] font-semibold text-blood disabled:opacity-50"
              data-testid="review-reject"
            >
              LOẠI BỎ
            </button>
          </div>
        </div>
      )}

      {reopenable.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-[0.7rem] tracking-[0.1em] text-mute">MỞ LẠI RESET (P0-06)</p>
          <select
            value={reopen.round_id}
            onChange={(e) => setReopen({ ...reopen, round_id: e.target.value })}
            className="rounded border border-hair bg-ink px-2 py-2 text-[0.75rem] text-snow"
            data-testid="reopen-round"
          >
            <option value="">Chọn đội…</option>
            {reopenable.map((r) => (
              <option key={r.id} value={r.id}>
                #{pad(r.team_number)} · chu kỳ {r.reset_cycle}
              </option>
            ))}
          </select>
          <select
            value={reopen.task_key}
            onChange={(e) => setReopen({ ...reopen, task_key: e.target.value })}
            className="rounded border border-hair bg-ink px-2 py-2 text-[0.7rem] text-snow"
            data-testid="reopen-task"
          >
            {RESET_TASKS.map((t) => (
              <option key={t} value={t}>
                {RESET_TASK_LABEL[t]}
              </option>
            ))}
          </select>
          <input
            value={reopen.reason}
            onChange={(e) => setReopen({ ...reopen, reason: e.target.value })}
            placeholder="Lý do mở lại (bắt buộc)"
            className="rounded border border-hair bg-ink px-2 py-2 text-[0.75rem] text-snow"
            data-testid="reopen-reason"
          />
          <button
            type="button"
            disabled={!reopen.round_id || !reopen.reason.trim()}
            onClick={() => {
              void store.act('REOPEN_RESET', {
                round_id: reopen.round_id,
                task_key: reopen.task_key,
                reason: reopen.reason.trim(),
              });
              setReopen({ ...reopen, round_id: '', reason: '' });
            }}
            className="rounded-panel border border-ember/50 bg-ember/10 px-3 py-3 text-[0.75rem] font-semibold text-ember disabled:opacity-50"
            data-testid="reopen-apply"
          >
            MỞ LẠI · YÊU CẦU XÁC NHẬN LẠI CẢ BA BƯỚC
          </button>
        </div>
      )}

      <button type="button" onClick={exportCsv} className="rounded-panel border border-hair px-3 py-3 text-[0.75rem] text-snow" data-testid="export-csv">
        XUẤT CSV
      </button>
    </div>
  );
}
