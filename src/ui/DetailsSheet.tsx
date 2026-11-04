import * as Dialog from '@radix-ui/react-dialog';
import { useMemo, useState } from 'react';
import type { LiveStore } from '../client/liveStore';
import type { StoredSession } from './session';
import { analytics, formatClockCs, formatClockMs, formatClockSec, formatDuration, formatSeconds, formatWallTime, leaderboard, roundMetrics } from '../shared/metrics';
import {
  ABORT_KINDS,
  ABORT_KIND_LABEL,
  ACTION_LABEL,
  ATTEMPT_LABEL,
  OUTCOME_LABEL,
  PHASE_LABEL,
  RESET_TASKS,
  RESET_TASK_LABEL,
  REVIEW_REASON_LABEL,
  ROLE_LABEL,
  ROLE_SHORT,
  ROUND_DURATION_MAX_MS,
  ROUND_DURATION_MIN_MS,
  STATUS_LABEL,
  TRANSPORT_LABEL,
  LAYOUTS,
  type AbortKind,
  type Role,
} from '../shared/constants';
import { flowStatus, liveStatus, roundLimitMs } from '../shared/machine';
import { USING_SUPABASE } from '../client/gateway';
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
  // `analytics` is built entirely from persisted timestamps and never reads the
  // clock argument, so the memo keys on the snapshot alone: with a game running the
  // dashboard ticks at display rate, and this summarised the whole event each time.
  const stats = useMemo(() => (snap ? analytics(snap, now) : null), [snap]); // eslint-disable-line react-hooks/exhaustive-deps
  // The wall display follows the authoritative countdown, not a phone's own timer.
  const counting =
    snap !== null && snap.active_round !== null
      ? liveStatus(snap.active_round, snap.attempts ?? [], roundLimitMs(snap.active_round, snap.event.config.game_limit_ms), now) === 'RUNNING'
      : false;

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-overlay" />
        <Dialog.Content className="sheet-content flex flex-col" data-testid="details-sheet" aria-describedby={undefined}>
          <header className="flex items-center justify-between border-b border-hair px-4 py-3">
            <Dialog.Title className="text-[0.8rem] font-semibold tracking-[0.16em] text-snow">
              {snap ? `${snap.rounds.length} LƯỢT CHƠI` : 'ĐANG ĐỒNG BỘ'}
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
                  {counting && onOpenBigScreen && (
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
                    <p className="py-3 text-[0.75rem] text-mute">Chưa có đội hoàn thành trận đồ trong thời lượng lượt chơi.</p>
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
  const configLimit = snap.event.config.game_limit_ms;
  if (rounds.length === 0) return <p className="text-[0.75rem] text-mute">Chưa có lượt chơi nào.</p>;
  return (
    <div className="flex flex-col gap-3">
      {rounds.map((r) => {
        // One source for the score: the validated claim, frozen when NPC2 finalised it.
        const limit = roundLimitMs(r, configLimit);
        const m = roundMetrics(r, snap.reset_tasks, now, snap.attempts ?? [], configLimit);
        const claims = (snap.attempts ?? []).filter((a) => a.round_id === r.id);
        return (
          <div key={r.id} data-testid={`round-detail-${r.team_number}`}>
            <p className="mb-1 text-[0.75rem] font-semibold text-snow">
              ĐỘI #{pad(r.team_number)}{' '}
              <span className="text-mute">· {STATUS_LABEL[r.status] ?? PHASE_LABEL[flowStatus(r) ?? ''] ?? 'Không rõ'}</span>
            </p>
            <Row k="Nhận đội" v={r.called_at ? formatWallTime(r.called_at) : '—'} />
            <Row
              k="Tầng 2"
              v={r.floor2_confirmed_at ? formatWallTime(r.floor2_confirmed_at) : r.floor2_bypassed_at ? 'BỎ QUA (NPC 1)' : '—'}
              tone={r.floor2_bypassed_at !== null ? 'text-ember' : 'text-snow'}
            />
            <Row k="Bắt đầu lượt chơi" v={r.game_started_at ? formatWallTime(r.game_started_at) : '—'} />
            <Row k="Thời lượng lượt" v={r.game_started_at !== null ? formatClockSec(limit) : '—'} />
            <Row k="Hết giờ" v={r.deadline_at ? formatWallTime(r.deadline_at) : '—'} />
            <Row
              k="Điểm chính thức"
              v={m.game_ms === null ? '—' : formatClockMs(m.game_ms)}
              tone={m.game_ms !== null && m.game_ms > limit ? 'text-blood' : 'text-snow'}
            />
            <Row k="Chuẩn bị" v={formatSeconds(m.prep_ms)} />
            <Row k="Rời tầng 3" v={r.exit_confirmed_at ? formatWallTime(r.exit_confirmed_at) : '—'} />
            <Row k="Hủy lượt" v={r.aborted_at ? `${formatWallTime(r.aborted_at)}${r.abort_kind ? ` · ${ABORT_KIND_LABEL[r.abort_kind]}` : ''}` : '—'} tone={r.aborted_at !== null ? 'text-blood' : 'text-snow'} />
            <Row k="Reset tổng" v={formatSeconds(m.reset_total_ms)} tone={isSlowReset(m.reset_total_ms, snap.event.config.reset_target_ms) ? 'text-ember' : 'text-snow'} />
            <Row k="NPC 1 chốt khu vực" v={formatSeconds(m.gate_clear_ms)} />
            <Row k="Kết quả" v={OUTCOME_LABEL[m.result] ?? 'Không rõ'} tone={m.result === 'WON' ? 'text-jade' : m.result === 'TIME_UP' || m.result === 'ABORTED' ? 'text-blood' : 'text-mute'} />
            {claims.length > 0 && (
              <ul className="mt-1 flex flex-col gap-0.5" data-testid={`claims-${r.team_number}`}>
                {claims.map((a) => (
                  <li key={a.id} className="flex items-baseline justify-between gap-2 text-[0.66rem]">
                    <span className="text-mute">Lần {a.seq} · {formatClockMs(a.elapsed_ms)}</span>
                    <span className={a.status === 'VALID' ? 'text-jade' : a.status === 'INVALID' ? 'text-mute' : 'text-ember'}>
                      {ATTEMPT_LABEL[a.status as keyof typeof ATTEMPT_LABEL] ?? 'Không rõ'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {r.game_reset_count > 0 && (
              <Row k="Reset đồng hồ (lịch sử)" v={`${r.game_reset_count} lần`} tone="text-ember" />
            )}
            {r.needs_review && (
              <p className="mt-1 text-[0.68rem] text-ember" data-testid={`review-${r.team_number}`}>
                CHỜ XÉT: {r.review_reasons.map((x) => REVIEW_REASON_LABEL[x] ?? x).join(' · ')}
              </p>
            )}
            {r.decertified && <p className="mt-1 text-[0.68rem] text-blood">Đã bị loại khỏi bảng xếp hạng (có nhật ký).</p>}
            {r.start_transport_ms !== null && (
              <p className="mt-1 text-[0.66rem] text-mute">
                Network của nhịp BẮT ĐẦU: {r.start_transport_ms} ms (không trừ vào điểm)
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
                {op.last_detail ?? (op.last_action ? ACTION_LABEL[op.last_action] ?? 'Thao tác không rõ' : 'chưa thao tác')}
                {op.last_action_at ? ` · ${formatWallTime(op.last_action_at)}` : ''}
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
                  ? `${ROLE_SHORT[t.confirmed_by_role as Role] ?? ''} ${formatWallTime(t.completed_at)}${t.layout ? ` · kiểu ${t.layout}` : ''}`
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
          Bố trí vật ẩn · <span className="text-snow">kiểu {snap.event.config.hiding_layout}</span> · do {ROLE_SHORT[owner]} chuẩn bị
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
      <Row k="Trạng thái" v={TRANSPORT_LABEL[state.status] ?? state.status} tone={state.status === 'CONNECTED' ? 'text-jade' : 'text-ember'} />
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
      <Row k="Reset đồng hồ (toàn sự kiện)" v={String(stats.clock_resets)} tone={stats.clock_resets > 0 ? 'text-ember' : 'text-snow'} />
      <Row k="Tạm dừng đồng hồ (toàn sự kiện)" v={String(stats.clock_pauses)} tone={stats.clock_pauses > 0 ? 'text-ember' : 'text-snow'} />
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
            <span className="text-[0.62rem] tracking-[0.08em] text-mute">bản {l.revision}</span>
          </div>
          <p className="text-snow">
            {/* The engine already writes a Vietnamese sentence for every press; the
                action type is only a fallback for rows older than that habit. */}
            {l.metadata?.detail_text ? String(l.metadata.detail_text) : ACTION_LABEL[l.action] ?? 'Thao tác không rõ'}
            {l.team_number !== null ? <span className="text-mute"> · #{pad(l.team_number)}</span> : null}
          </p>
          <p className="text-[0.62rem] text-mute">
            {ROLE_SHORT[l.actor_role as Role] ?? l.actor_role}
            {l.actor_id === 'system.clock' ? ' (tự động)' : ''}
            {l.from_state && l.to_state
              ? ` · ${STATUS_LABEL[l.from_state] ?? l.from_state} → ${STATUS_LABEL[l.to_state] ?? l.to_state}`
              : ''}
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
  // The round duration is edited as phút + giây, the way it is read out on the floor.
  const [minutes, setMinutes] = useState(String(Math.floor(snap.event.config.game_limit_ms / 60_000)));
  const [seconds, setSeconds] = useState(String(Math.floor((snap.event.config.game_limit_ms % 60_000) / 1000)));
  const [abortKind, setAbortKind] = useState<AbortKind>('technical');
  // V3.2: the board release is a supervisor action with no secret to type — the
  // caller's own binding is the authorisation. Two taps confirm; a third, separate
  // emergency path forces a release while a round is still open.
  const [releasing, setReleasing] = useState(false);
  const [armed, setArmed] = useState(false);
  const [released, setReleased] = useState<string | null>(null);
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
    field: 'exit_confirmed_at',
    value: '',
  });
  const started = snap.event.event_started_at !== null;
  const round: Round | null = snap.active_round;
  const disputed = disputedRounds(snap.rounds);
  const durationMs = (Number(minutes) || 0) * 60_000 + (Number(seconds) || 0) * 1000;
  const durationValid =
    Number.isInteger(durationMs) && durationMs >= ROUND_DURATION_MIN_MS && durationMs <= ROUND_DURATION_MAX_MS;
  // A reset may only be reopened once the team is out of the area, or on the very
  // last round if readiness was already granted.
  const reopenable = snap.rounds.filter(
    (r) => flowStatus(r) === 'EXIT_CONFIRMED' || (r.system_ready_at !== null && r.id === snap.rounds.at(-1)?.id),
  );

  const saveConfig = () =>
    store.act('CONFIGURE', {
      game_limit_ms: durationMs,
      prep_allowance_ms: Math.max(0, Number(prep) || 0) * 1000,
      reset_target_ms: target.trim() === '' ? null : Math.max(0, Number(target) || 0) * 1000,
      hidden_object_owner: owner,
    });

  /**
   * Every occupied station returns to CÒN TRỐNG so a new shift can pick its seat
   * again. PostgreSQL verifies the caller holds the SUPERVISOR seat — there is no
   * secret any more — and the answer is the same authoritative floor predicate the
   * picker shows. `force` is the emergency path: it aborts a still-open round as a
   * safety cancellation before freeing the seats. Rounds, claims and history are
   * never deleted by either path.
   */
  const releaseBoard = async (force: boolean) => {
    setReleasing(true); setReleased(null); setArmed(false);
    try {
      const { resetAllStations, resetErrorMessage } = await import('../client/supabaseAuth');
      const result = await resetAllStations(force);
      setReleased(result?.ok
        ? (result.freed ?? 0) > 0 ? `ĐÃ GIẢI PHÓNG ${result.freed} VỊ TRÍ · BẢNG CÒN TRỐNG` : 'BẢNG ĐÃ TRỐNG — KHÔNG CÓ VỊ TRÍ NÀO BỊ ĐÁ'
        : resetErrorMessage(result));
    } catch {
      setReleased('MẤT KẾT NỐI — CHƯA GIẢI PHÓNG ĐƯỢC. KIỂM TRA MẠNG RỒI BẤM LẠI');
    } finally {
      setReleasing(false);
    }
  };

  const exportCsv = () => {
    const limit = snap.event.config.game_limit_ms;
    const lines = ['team_number,result,official_ms,deadline_ms,prep_ms,exit_ms,reset_ms,claims,rejected,floor2'];
    for (const r of snap.rounds) {
      const m = roundMetrics(r, snap.reset_tasks, undefined, snap.attempts ?? [], limit);
      lines.push(
        [
          r.team_number,
          m.result,
          m.game_ms ?? '',
          r.deadline_at ?? '',
          m.prep_ms ?? '',
          r.exit_confirmed_at ?? '',
          m.reset_total_ms ?? '',
          m.claims,
          m.rejected,
          r.floor2_bypassed_at !== null ? 'bypassed' : r.floor2_confirmed_at !== null ? 'confirmed' : 'pending',
        ].join(','),
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
        <p className="text-[0.7rem] tracking-[0.1em] text-mute">ĐIỀU KHIỂN SỰ KIỆN · QUẢN TRỊ VIÊN</p>
        <p className="text-[0.7rem] text-mute" data-testid="cfg-duration-current">
          Thời lượng lượt chơi hiện hành: <span className="text-snow">{formatClockSec(snap.event.config.game_limit_ms)}</span>.
          {round && round.game_started_at !== null ? ' Thời lượng mới sẽ áp dụng từ lượt tiếp theo.' : ''}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[0.68rem] text-mute">
            Phút (0–59)
            <input
              value={minutes}
              onChange={(e) => setMinutes(e.target.value.replace(/\D/g, ''))}
              inputMode="numeric"
              maxLength={2}
              className="mt-1 w-full rounded border border-hair bg-ink px-2 py-2 text-[0.75rem] text-snow"
              data-testid="cfg-duration-min"
            />
          </label>
          <label className="text-[0.68rem] text-mute">
            Giây (0–59)
            <input
              value={seconds}
              onChange={(e) => setSeconds(e.target.value.replace(/\D/g, ''))}
              inputMode="numeric"
              maxLength={2}
              className="mt-1 w-full rounded border border-hair bg-ink px-2 py-2 text-[0.75rem] text-snow"
              data-testid="cfg-duration-sec"
            />
          </label>
        </div>
        {!durationValid && (
          <p role="alert" className="text-[0.68rem] text-blood" data-testid="cfg-duration-error">
            Thời lượng hợp lệ từ 00:01 đến {formatClockSec(ROUND_DURATION_MAX_MS)}.
          </p>
        )}
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
            <option value="ROOM305">NPC 2 · PHÒNG 305</option>
            <option value="GATE">NPC 1 · CỬA VÀO</option>
          </select>
        </label>
        <button
          type="button"
          onClick={saveConfig}
          disabled={!durationValid}
          className="rounded-panel border border-hair px-3 py-3 text-[0.75rem] text-snow disabled:opacity-50"
          data-testid="cfg-save"
        >
          LƯU CẤU HÌNH
        </button>
      </div>

      {USING_SUPABASE && (
        <div className="flex flex-col gap-2" data-testid="release-panel">
          <p className="text-[0.7rem] tracking-[0.1em] text-mute">GIẢI PHÓNG BẢNG VỊ TRÍ</p>
          <p className="text-[0.66rem] leading-snug text-mute">
            Thu hồi mọi máy đang giữ chỗ trực, trả về CÒN TRỐNG để ca mới chọn lại vị trí. Đồng hồ,
            kết quả, lần báo hoàn thành và checklist vẫn còn nguyên. Chỉ máy đang giữ ghế Quản trị
            mới làm được việc này.
          </p>
          {/* Normal path: two taps, and PostgreSQL still refuses if the floor is busy. */}
          <button
            type="button"
            disabled={releasing}
            onClick={() => { if (!armed) { setArmed(true); return; } void releaseBoard(false); }}
            className="rounded-panel border border-hair px-3 py-3 text-[0.75rem] font-semibold text-snow disabled:opacity-50"
            data-testid="release-confirm"
          >
            {releasing ? 'ĐANG GIẢI PHÓNG…' : armed ? 'XÁC NHẬN GIẢI PHÓNG BẢNG' : 'GIẢI PHÓNG BẢNG'}
          </button>
          {armed ? (
            <p className="text-[0.64rem] leading-snug text-ember" data-testid="release-armed">
              Lần bấm này sẽ đuổi toàn bộ thiết bị đang trực. Bảng chỉ được giải phóng khi
              không còn đội trong khu vực.
            </p>
          ) : null}
          {/* Emergency path: the same sweep, but it also closes any still-open round
              as a recorded safety cancellation. Hidden until deliberately opened. */}
          <details className="rounded-panel border border-blood/40 bg-blood/5" data-testid="release-emergency-details">
            <summary className="cursor-pointer px-3 py-2 text-[0.68rem] font-semibold text-blood marker:hidden">
              Khẩn cấp: đuổi máy khi vẫn còn đội chưa đóng lượt
            </summary>
            <p className="px-3 pb-2 text-[0.64rem] leading-snug text-mute">
              Dùng khi ca trực đổi người gấp: lượt đang mở sẽ bị HỦY có ghi nhật ký
              (lý do “Emergency reset”), toàn bộ máy bị thu hồi. Điểm và lịch sử không mất.
            </p>
            <button
              type="button"
              disabled={releasing}
              onClick={() => void releaseBoard(true)}
              className="mx-3 mb-3 w-[calc(100%-1.5rem)] rounded-panel border border-blood/60 bg-blood/10 px-3 py-3 text-[0.75rem] font-bold text-blood disabled:opacity-50"
              data-testid="release-force"
            >
              {releasing ? 'ĐANG GIẢI PHÓNG…' : 'GIẢI PHÓNG KHẨN CẤP (HỦY LƯỢT ĐANG MỞ)'}
            </button>
          </details>
          {released !== null && (
            <p role="status" className="text-[0.68rem] leading-snug text-snow" data-testid="release-result">{released}</p>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <p className="text-[0.7rem] tracking-[0.1em] text-mute">KIỂM SOÁT KHẨN CẤP</p>
        {!started ? (
          <p className="rounded-panel border border-hair bg-ink px-3 py-3 text-[0.7rem] leading-snug text-mute" data-testid="admin-start-hint">
            Nhân sự 01 nhận đội đầu tiên ở sảnh. NPC 1 bấm BẮT ĐẦU để mở đồng hồ lượt chơi.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <input
              value={closeReason}
              onChange={(e) => setCloseReason(e.target.value)}
              placeholder="Lý do đóng sự kiện (bắt buộc, vào nhật ký)"
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
            <label className="text-[0.68rem] text-mute">
              Loại hủy lượt chơi
              <select
                value={abortKind}
                onChange={(e) => setAbortKind(e.target.value as AbortKind)}
                className="mt-1 w-full rounded border border-hair bg-ink px-2 py-2 text-[0.75rem] text-snow"
                data-testid="admin-abort-kind"
              >
                {ABORT_KINDS.map((k) => (
                  <option key={k} value={k}>{ABORT_KIND_LABEL[k]}</option>
                ))}
              </select>
            </label>
            <p className="text-[0.66rem] leading-snug text-mute" data-testid="admin-abort-note">
              {abortKind === 'misconduct'
                ? 'Hủy vì kỷ luật: loại kết quả, kể cả lần báo đã ghi trước hạn — chỉ Quản trị viên xét lại mới mở lại được.'
                : 'Hủy vì sự cố hoặc an toàn: lần báo đã ghi trước hạn vẫn còn nguyên và NPC 2 có thể xác minh.'}
              {' '}Hủy lượt không thay thế xác nhận rời khu vực: NPC 1 vẫn phải bấm XÁC NHẬN ĐỘI ĐÃ RỜI TẦNG 3.
            </p>
            <button
              type="button"
              disabled={!reason.trim()}
              onClick={() => {
                void store.act('ABORT_ROUND', { reason: reason.trim(), kind: abortKind });
                setReason('');
              }}
              className="rounded-panel border border-blood/60 bg-blood/10 px-3 py-4 text-[0.78rem] font-bold text-blood disabled:opacity-50"
              data-testid="admin-abort"
            >
              HỦY LƯỢT CHƠI ĐỘI #{pad(round.team_number)}
            </button>
          </>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-[0.7rem] tracking-[0.1em] text-mute">HIỆU CHỈNH CÓ NHẬT KÝ</p>
        <select value={correction.round_id} onChange={(e) => setCorrection({ ...correction, round_id: e.target.value })} className="rounded border border-hair bg-ink px-2 py-2 text-[0.75rem] text-snow" data-testid="corr-round">
          <option value="">Chọn đội…</option>
          {[...snap.rounds].reverse().map((r) => (
            <option key={r.id} value={r.id}>#{pad(r.team_number)} · {STATUS_LABEL[r.status] ?? 'Không rõ'}</option>
          ))}
        </select>
        <div className="grid grid-cols-2 gap-2">
          <select value={correction.field} onChange={(e) => setCorrection({ ...correction, field: e.target.value })} className="rounded border border-hair bg-ink px-2 py-2 text-[0.7rem] text-snow" data-testid="corr-field">
            <option value="game_started_at">Bắt đầu lượt chơi</option>
            <option value="deadline_at">Mốc hết giờ</option>
            <option value="exit_confirmed_at">Đội rời tầng 3</option>
            <option value="floor2_confirmed_at">Xác nhận tầng 2</option>
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
                #{pad(r.team_number)} · {formatClockCs(r.official_duration_ms ?? 0)} ·{' '}
                {r.review_reasons.map((x) => REVIEW_REASON_LABEL[x] ?? x).join(' · ')}
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
          <p className="text-[0.7rem] tracking-[0.1em] text-mute">MỞ LẠI MỘT BƯỚC RESET</p>
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
