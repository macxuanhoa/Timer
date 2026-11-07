import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
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
  ROLE_SHORT,
  ROUND_DURATION_MAX_MS,
  ROUND_DURATION_MIN_MS,
  STATUS_LABEL,
  TRANSPORT_LABEL,
  LAYOUTS,
  abortKindWord,
  type AbortKind,
  type Role,
} from '../shared/constants';
import { flowStatus, liveStatus, roundLimitMs } from '../shared/machine';
import { USING_SUPABASE } from '../client/gateway';
import { disputedRounds, reviewPendingRounds } from '../shared/metrics';
import { pad, resolveOpsCommand, resolveOpsLayout, resolveOpsRoles, resolveResetBoard, resolveSyncState, roundCounts, statusOf, OPS_EVENT_STATE_WORD, OPS_SEAT_WORD } from '../client/selectors';
import { alarms } from './sound';
import { SeatManagement } from './SeatManagement';
import { HelpDetails } from './HelpDetails';
import { ACCENT_HEX, ROLE_ACCENT } from './accents';
import {
  AlertIcon, CheckIcon, ChevronDownIcon, DoorIcon, GearIcon, LockIcon,
  PinIcon, RoomIcon, SignalIcon, SignalOffIcon, StairsIcon, UsersIcon,
} from './icons';
import type { Round, Snapshot } from '../shared/types';

interface Props {
  open: boolean;
  onClose(): void;
  store: LiveStore;
  account: StoredSession['account'];
  now: number;
  /** Opens the wall display; present while a game is running. */
  onOpenBigScreen?(): void;
  onLogout?(): void;
  /** Which of the three information groups the sheet opens on (operator IA). */
  initialTab?: 'ops' | 'admin' | 'report';
}

type SheetTab = 'ops' | 'admin' | 'report';

/** Bottom sheet: never navigates away, so live timers keep rendering underneath.
 * V3.4 §1–§5: the Điều hành group is now the shift's command centre — event
 * state, the team on the floor, the workflow stage, blocked roles and the next
 * action in that order, then the four duty seats, the hidden-object layout and
 * a human connection summary with the technical metrics behind
 * “CHẨN ĐOÁN KỸ THUẬT”. Quản trị (supervisor-only controls, the board release is
 * the first thing there) and Báo cáo (history, stats, audit) keep the V3.2 flat
 * groups. Nothing was removed and no business call changed. */
export function DetailsSheet({ open, onClose, store, account, now, onOpenBigScreen, onLogout, initialTab = 'ops' }: Props) {
  const state = store.getSnapshot();
  const snap = state.snapshot;
  const isSupervisor = account.role === 'SUPERVISOR';
  const [tab, setTab] = useState<SheetTab>(initialTab);
  // Re-open where the caller meant to land; a supervisor's stale 'admin' tab
  // must not leak into another device's session.
  useEffect(() => { if (open) setTab(initialTab === 'admin' && !isSupervisor ? 'ops' : initialTab); }, [open, initialTab, isSupervisor]);

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
  const activeTab: SheetTab = tab === 'admin' && !isSupervisor ? 'ops' : tab;

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-overlay" />
        <Dialog.Content className="sheet-content flex flex-col" data-testid="details-sheet" aria-describedby={undefined}>
          <header className="sheet-head flex items-center justify-between gap-2 border-b border-hair px-4 pt-3">
            <div className="min-w-0">
              {/* V3.4 §3: the header names the current event state, never an
                  ambiguous cumulative counter. Round totals live in the ops
                  command card and the report tab, where their semantics
                  (recorded / closed / open / cancelled) are spelled out. */}
              <Dialog.Title className="sheet-title" data-testid="sheet-event-state">
                {snap ? OPS_EVENT_STATE_WORD[statusOf(snap, now)] : 'ĐANG ĐỌC TRẠNG THÁI…'}
              </Dialog.Title>
              <p className="sheet-sub truncate" data-testid="sheet-event-name">
                {snap ? snap.event.config.event_name : 'Sự kiện phòng 305'}
              </p>
            </div>
            <Dialog.Close className="rounded px-3 py-1 text-[0.85rem] text-mute" data-testid="close-details">
              Đóng
            </Dialog.Close>
          </header>

          <nav className="sheet-tabs" role="tablist" aria-label="Nhóm thông tin">
            <button type="button" role="tab" aria-selected={activeTab === 'ops'} data-testid="sheet-tab-ops"
              className={`sheet-tab${activeTab === 'ops' ? ' is-active' : ''}`} onClick={() => setTab('ops')}>
              ĐIỀU HÀNH
            </button>
            {isSupervisor && (
              <button type="button" role="tab" aria-selected={activeTab === 'admin'} data-testid="sheet-tab-admin"
                className={`sheet-tab${activeTab === 'admin' ? ' is-active' : ''}`} onClick={() => setTab('admin')}>
                QUẢN TRỊ
              </button>
            )}
            <button type="button" role="tab" aria-selected={activeTab === 'report'} data-testid="sheet-tab-report"
              className={`sheet-tab${activeTab === 'report' ? ' is-active' : ''}`} onClick={() => setTab('report')}>
              BÁO CÁO
            </button>
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {!snap ? (
              <p className="py-10 text-center text-[0.8rem] text-mute">Đang tải dữ liệu…</p>
            ) : activeTab === 'ops' ? (
              <OpsTab
                store={store}
                snap={snap}
                account={account}
                now={now}
                counting={counting}
                onOpenBigScreen={onOpenBigScreen}
                onLogout={onLogout}
                onOpenReport={() => setTab('report')}
              />
            ) : activeTab === 'admin' ? (
              <div className="flex flex-col gap-2">
                <div data-testid="section-admin"><Management store={store} snap={snap} /></div>
              </div>
            ) : stats === null ? (
              <p className="py-10 text-center text-[0.8rem] text-mute">Đang đọc số liệu…</p>
            ) : (
              <ReportTab store={store} snap={snap} now={now} rows={rows} stats={stats} />
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ------------------------------------------------------------ ops command tab */

/** One icon per station, so a supervisor scanning the four duty cards finds the
 * right one by shape before reading the name (V3.4 §4). */
const OPS_SEAT_ICON: Record<string, (props: { className?: string }) => React.ReactElement> = {
  LOBBY: UsersIcon,
  CORRIDOR: StairsIcon,
  GATE: DoorIcon,
  ROOM305: RoomIcon,
};

/** The seat line's icon agrees with the word it carries — never colour alone. */
const OPS_SEAT_ICON_BY_STATE: Record<string, (props: { className?: string }) => React.ReactElement> = {
  held: CheckIcon,
  free: SignalOffIcon,
  unknown: AlertIcon,
};

/**
 * V3.4 §1–§5 — the Điều hành group, built as the shift's command centre. The order
 * is the order a supervisor asks the questions: what state is the event in, which
 * team is on the floor and where, which workflow stage, who is blocked, what to do
 * next — then the four duty seats, the hidden-object layout and the connection
 * summary, with the raw technical readout folded behind “CHẨN ĐOÁN KỸ THUẬT”.
 *
 * Every word on this screen comes from the authoritative selectors in
 * `client/selectors.ts` (resolveOpsCommand / resolveOpsRoles / resolveOpsLayout /
 * resolveSyncState), so nothing here invents a frontend condition: the seat card
 * reads the stored binding, the layout card mirrors the server's SET_LAYOUT
 * permission and legal window, and a blocked role is a state-machine fact rather
 * than the most recent audit line. Controls shown are only controls the RPC would
 * accept for this caller at this moment.
 */
function OpsTab({
  store,
  snap,
  account,
  now,
  counting,
  onOpenBigScreen,
  onLogout,
  onOpenReport,
}: {
  store: LiveStore;
  snap: Snapshot;
  account: StoredSession['account'];
  now: number;
  counting: boolean;
  onOpenBigScreen?: () => void;
  onLogout?: () => void;
  onOpenReport(): void;
}) {
  const cmd = resolveOpsCommand(snap, now, { isSupervisor: account.role === 'SUPERVISOR' });
  // The local demo backend keeps no multi-device seat board, so the cards must not
  // claim a seat is empty: they read CHƯA XÁC MINH ĐƯỢC GHẾ instead.
  const seats = resolveOpsRoles(snap, now, { seatKnown: USING_SUPABASE });
  const layout = resolveOpsLayout(snap, account.role, now);
  const state = store.getSnapshot();
  const sync = resolveSyncState(state.status, { dataAgeMs: store.dataAgeMs() });
  // The checklist is a live question only while the floor is being put back:
  // resolveResetBoard answers empty outside that window, so this sheet can never
  // read “chờ xác nhận” for a round that has not started its reset.
  const resetBoard = resolveResetBoard(snap, account.role);

  return (
    <div className="flex flex-col gap-3">
      <section className="card p-3" data-testid="ops-command">
        {/* V3.4 §1 (UI-08): the card no longer opens by restating the sheet
            header. "SỰ KIỆN ĐANG DIỄN RA" was printed twice within 150px — once
            as the dialog title, once as the card's headline — and the second one
            bought nothing. The event verdict is answered by the header, which
            sits outside the scroll box and so stays on screen at every scroll
            position; the card starts with what the header does not say: the
            workflow stage, the team, and where that team physically is. */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="badge" data-tone={cmd.state === 'LIVE' ? 'live' : cmd.state === 'ENDED' ? 'idle' : 'queued'} data-testid="ops-stage">
            {cmd.stageWord}
          </span>
          <span className="text-[0.74rem] font-semibold text-snow" data-testid="ops-team">{cmd.teamText}</span>
        </div>
        {cmd.whereText !== null && (
          <p className="mt-1 text-[0.68rem] leading-snug text-mute" data-testid="ops-where">
            Vị trí: <span className="text-snow">{cmd.whereText}</span>
          </p>
        )}
        <p className="mt-2 border-t border-hair/60 pt-2 text-[0.64rem] leading-snug text-mute" data-testid="ops-round-counts">
          {cmd.counts.sentence}
        </p>
        {cmd.next === null ? (
          <p className="mt-2 text-[0.7rem] text-mute" data-testid="ops-next-action">
            Chưa có thao tác cần làm.
          </p>
        ) : (
          <div className="mt-2 rounded-panel border border-ember/50 bg-ember/10 px-3 py-2" data-testid="ops-next-action">
            <p className="text-[0.58rem] font-bold uppercase tracking-[0.14em] text-ember">Tiếp theo</p>
            <p className="mt-0.5 text-[0.78rem] font-bold leading-snug text-snow">{cmd.next.who}</p>
            <p className="text-[0.72rem] leading-snug text-ember">{cmd.next.what}</p>
          </div>
        )}
        {cmd.attention.length > 0 && (
          <ul className="mt-2 flex flex-col gap-1" data-testid="ops-attention">
            {cmd.attention.map((line) => (
              <li key={line} className="notice-band border-blood/50 text-[0.68rem] text-blood" data-testid="ops-attention-item">
                <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* The two station-switch actions that are not a handoff, plus the report
          shortcut — never a second copy of the operator's own primary CTA. */}
      <div className="flex gap-2">
        {counting && onOpenBigScreen && (
          <button
            type="button"
            onClick={onOpenBigScreen}
            className="btn-quiet flex-1 text-[0.72rem] font-semibold"
            data-testid="sheet-big-screen"
          >
            MÀN HÌNH LỚN
          </button>
        )}
        <button type="button" onClick={onOpenReport} className="btn-quiet flex-1 text-[0.72rem]" data-testid="ops-open-report">
          XEM BÁO CÁO
        </button>
        {onLogout && (
          <button type="button" onClick={onLogout} className="btn-quiet flex-1 text-[0.72rem]" data-testid="logout">
            ĐỔI MÁY
          </button>
        )}
      </div>

      <Section title="Bốn vị trí trực" testid="section-ops-seats">
        {/* V3.4 §1 (UI-08): the five-chip station strip used to sit here. On a
            station screen it earns its place by marking which chip is this phone;
            inside this tab it duplicated four cards that were already stacked
            directly below it, and at 320px its labels truncated to "02 · TẦN…".
            The one fact worth keeping — "this machine is that position" — is now
            marked on the card itself, in words. */}
        <div className="flex flex-col gap-1.5">
          {seats.map((r) => {
            const Icon = OPS_SEAT_ICON[r.role] ?? PinIcon;
            const SeatIcon = OPS_SEAT_ICON_BY_STATE[r.seat] ?? AlertIcon;
            return (
              <div
                key={r.role}
                className="rounded-panel border border-hair bg-ink/40 px-3 py-2"
                style={{ borderLeft: `3px solid ${ACCENT_HEX[ROLE_ACCENT[r.role]]}` } as CSSProperties}
                data-testid={`ops-seat-${r.role.toLowerCase()}`}
                data-state={r.stateWord}
                data-self={account.role === r.role ? '1' : '0'}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-start gap-2">
                    <Icon className="mt-0.5 h-4 w-4 shrink-0 text-mute" />
                    <div className="min-w-0">
                      <p className="text-[0.74rem] font-bold leading-tight text-snow">
                        {r.person}
                        {account.role === r.role ? <span className="ops-seat-self" data-testid="ops-seat-self">· máy này</span> : null}
                      </p>
                      <p className="text-[0.58rem] font-semibold uppercase tracking-[0.1em] text-mute">{r.area}</p>
                    </div>
                  </div>
                  <span className="badge shrink-0" data-tone={r.badgeTone} data-testid={`ops-seat-${r.role.toLowerCase()}-state`}>
                    {r.stateWord}
                  </span>
                </div>
                <p
                  className={`mt-1.5 flex items-center gap-1.5 text-[0.62rem] font-semibold uppercase tracking-[0.08em] ${
                    r.seat === 'held' ? 'text-jade' : r.seat === 'free' ? 'text-mute' : 'text-ember'
                  }`}
                  data-testid={`ops-seat-${r.role.toLowerCase()}-seat`}
                >
                  <SeatIcon className="h-3.5 w-3.5 shrink-0" />
                  {OPS_SEAT_WORD[r.seat]}
                </p>
                {r.issue !== null ? (
                  <p className="mt-1 text-[0.68rem] leading-snug text-blood" data-testid={`ops-seat-${r.role.toLowerCase()}-issue`}>
                    {r.issue}
                  </p>
                ) : r.duty !== null ? (
                  <p className="mt-1 text-[0.68rem] leading-snug text-mute" data-testid={`ops-seat-${r.role.toLowerCase()}-duty`}>
                    {r.duty}
                  </p>
                ) : null}
                {r.lastText !== null && (
                  <p className="mt-1 text-[0.6rem] leading-snug text-mute/80">
                    {r.lastText}
                    {r.lastAt !== null ? ` · ${formatWallTime(r.lastAt)}` : ''}
                  </p>
                )}
              </div>
            );
          })}
        </div>
        {resetBoard.rows.length > 0 && (
          <div
            className="mt-2 flex flex-col gap-1"
            data-testid="ops-reset-tasks"
            data-done={resetBoard.done}
            data-total={resetBoard.total}
          >
            {resetBoard.rows.map((row) => (
              <Row
                key={row.key}
                k={`${row.label} · ${row.owner}`}
                v={
                  row.state === 'done' && row.confirmedAt !== null
                    ? `${ROLE_SHORT[row.confirmedByRole as Role] ?? ''} ${formatWallTime(row.confirmedAt)}${row.layout ? ` · kiểu ${row.layout}` : ''}`
                    : row.status
                }
                tone={row.state === 'done' ? 'text-jade' : row.state === 'failed' ? 'text-blood' : 'text-ember'}
              />
            ))}
          </div>
        )}
      </Section>

      <Section title="Bố trí vật ẩn" testid="section-ops-layout">
        <div data-testid="ops-layout">
          <Row k="Kiểu hiện hành" v={`Kiểu ${layout.current}`} />
          <Row k="Chịu trách nhiệm" v={`${layout.ownerPerson} · ${layout.ownerArea}`} />
          {layout.liveRoundLayout !== null && (
            <Row k="Lượt đang chơi dùng" v={`Kiểu ${layout.liveRoundLayout}`} tone="text-ember" />
          )}
          {layout.canAct && layout.phaseAllowsEdit ? (
            <div className="mt-2 flex gap-2">
              {LAYOUTS.map((l) => (
                <button
                  key={l}
                  type="button"
                  disabled={l === layout.current || store.getSnapshot().pending === 'SET_LAYOUT'}
                  onClick={() => void store.act('SET_LAYOUT', { layout: l })}
                  className={`flex-1 rounded border px-2 py-2.5 text-[0.72rem] disabled:opacity-50 ${
                    l === layout.current ? 'border-jade text-jade' : 'border-hair text-snow'
                  }`}
                  data-testid={`layout-${l}`}
                >
                  {l}
                </button>
              ))}
            </div>
          ) : (
            <p className="mt-2 flex items-start gap-1.5 text-[0.66rem] leading-snug text-mute" data-testid="ops-layout-locked">
              <LockIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{layout.lockedReason ?? `Chỉ ${layout.ownerPerson} đổi được bố trí.`}</span>
            </p>
          )}
        </div>
      </Section>

      <Section title="Kết nối" testid="section-ops-sync">
        <div data-testid="ops-sync">
          <div className="flex items-center justify-between gap-2">
            <span className="conn-chip" data-status={state.status} data-testid="ops-sync-state">
              {state.status === 'CONNECTED' ? <SignalIcon className="h-3.5 w-3.5" /> : <SignalOffIcon className="h-3.5 w-3.5" />}
              {sync.label}
            </span>
            <span className="digital text-[0.62rem] text-mute">bản {state.revision}</span>
          </div>
          <HelpDetails label="Về kết nối"><p className="mt-1.5 text-[0.66rem] leading-snug text-mute" data-testid="ops-sync-note">
            {sync.key === 'connected' || sync.key === 'current'
              ? null
              : 'Số liệu có thể đang cũ. Kiểm tra mạng và đọc lại; điểm chính thức luôn lấy từ máy chủ.'}
          </p></HelpDetails>
          {sync.showRetry && (
            <button
              type="button"
              onClick={() => {
                alarms.unlock();
                void store.recover();
              }}
              className="btn-quiet mt-2 w-full text-[0.72rem]"
              data-testid="ops-retry"
            >
              THỬ ĐỌC LẠI
            </button>
          )}
          <details className="mt-2 rounded-panel border border-hair bg-ink/40" data-testid="ops-tech-details">
            <summary className="flex cursor-pointer items-center gap-1.5 px-3 py-2.5 text-[0.66rem] font-semibold uppercase tracking-[0.1em] text-mute marker:hidden">
              <ChevronDownIcon className="h-3.5 w-3.5 shrink-0" />
              <GearIcon className="h-3.5 w-3.5 shrink-0" />
              Chẩn đoán kỹ thuật
            </summary>
            <div className="px-3 pb-3">
              <Connectivity store={store} now={now} />
            </div>
          </details>
        </div>
      </Section>
    </div>
  );
}

/* ------------------------------------------------------- admin priority 1-2 */

/**
 * QUẢN TRỊ §1 — the event's real state, before anything else on the tab.
 *
 * Every word here comes from the same selectors the crew's operations tab uses,
 * so an organiser and a station can never read two different versions of the
 * night. `reset_block_reason` is printed because it is the server's own answer
 * about the floor, and the seat-release controls downstream obey exactly that
 * answer — the operator sees the reason the buttons are grey before trying to
 * press one.
 */
function AdminEventStatus({ snap, now }: { snap: NonNullable<ReturnType<LiveStore['getSnapshot']>['snapshot']>; now: number }) {
  const cmd = resolveOpsCommand(snap, now, { isSupervisor: true });
  const ended = snap.event.event_ended_at !== null;
  return (
    <section className="admin-status" data-testid="admin-event-status" data-state={cmd.state}>
      <p className="admin-status-eyebrow">TRẠNG THÁI SỰ KIỆN HIỆN TẠI</p>
      {/* V3.4 final integration §3A: the headline used to be the event verdict,
          which the sheet header already prints in the same size two rows above —
          the same duplication removed from the command card in UI-08. The large
          type now carries what the header does not say, the workflow stage, and
          the verdict stays stated explicitly as a labelled row so nothing an
          organiser needed got dropped. */}
      <p className="admin-status-word" data-testid="admin-event-stage-word">{cmd.stageWord}</p>
      {/* V3.4.1: the event name sat here in the same weight the sheet header prints it
          in, one row below. The header is the one place that names the night. */}
      <div className="admin-status-rows">
        {/* V3.4.1: the two rows that used to open this block printed the event's name
            and its verdict — the exact words the sheet header carries, outside the
            scroll box, at the same size. What the header does not say is the
            schedule, so the rows that remain are the timestamps. */}
        <Row k="Bắt đầu sự kiện" v={snap.event.event_started_at !== null ? formatWallTime(snap.event.event_started_at) : 'chưa mở'} />
        <Row k="Kết thúc sự kiện" v={ended ? formatWallTime(snap.event.event_ended_at ?? now) : 'đang mở'} tone={ended ? 'text-mute' : 'text-jade'} />
        {/* The row that used to sit here printed `#${team} · ${stageWord}` — the
            stage word again, one line under the headline that now carries it.
            The team and its position are stated once, in the row below. */}
        <Row k="Lượt" v={cmd.counts.sentence} />
        {cmd.whereText !== null ? <Row k="Đội đang ở" v={`${cmd.teamText} · ${cmd.whereText}`} tone="text-ember" /> : null}
      </div>
    </section>
  );
}

/**
 * QUẢN TRỊ §2 — the issue that needs an organiser right now, and what happens
 * next. `attention` is the same list the station phones see, built from
 * server-stalled rounds, unheld seats and unresolved reviews; an empty list is
 * reported as such rather than left blank, because silence and "nothing wrong"
 * are different statements.
 */
function AdminNextAction({ snap, now }: { snap: NonNullable<ReturnType<LiveStore['getSnapshot']>['snapshot']>; now: number }) {
  const cmd = resolveOpsCommand(snap, now, { isSupervisor: true });
  return (
    <section className="admin-next" data-testid="admin-next-action" data-attention={cmd.attention.length > 0 ? '1' : '0'}>
      <p className="admin-status-eyebrow">VIỆC CẦN QUAN TÂM</p>
      {cmd.attention.length === 0 ? (
        <p className="admin-next-clear" data-testid="admin-attention-clear">
          Không có việc chờ xử lý.
        </p>
      ) : (
        <ul className="admin-next-issues" data-testid="admin-attention">
          {cmd.attention.map((line) => <li key={line}>{line}</li>)}
        </ul>
      )}
      <p className="admin-next-next" data-testid="admin-next-next">
        <span className="admin-next-label">TIẾP THEO</span>
        {cmd.next ? `${cmd.next.who} · ${cmd.next.what}` : 'Chờ mở sự kiện.'}
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ sections */

function Section({ title, testid, children }: { title: string; testid: string; children: React.ReactNode }) {
  return (
    <section className="rounded-panel border border-hair bg-ink/40" data-testid={testid}>
      <h3 className="px-3 pt-3 text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-mute">{title}</h3>
      <div className="px-3 py-3">{children}</div>
    </section>
  );
}

function Row({ k, v, tone = 'text-snow', testid }: { k: string; v: string; tone?: string; testid?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-hair/40 py-1.5 last:border-0">
      <span className="text-[0.72rem] text-mute">{k}</span>
      <span className={`digital text-[0.75rem] ${tone}`} data-testid={testid}>{v}</span>
    </div>
  );
}

/**
 * BÁO CÁO §4 — one card per team, folded by default.
 *
 * V3.4 §9: the full row list is eleven lines per round, and a night with a
 * dozen teams turned the report into a wall of timestamps. Each round now opens
 * as a single scannable line — who, how it ended, the official instant, and any
 * flag that changes how the number should be read — with the detail behind one
 * deliberate tap. Nothing is dropped: every row that was here is still here.
 */
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
        // V3.4 §9 — this row is the round's SCHEDULED expiry instant, not its
        // outcome. Labelling it `Hết giờ` put the outcome word next to a
        // timestamp on a round that finished successfully minutes earlier, which
        // read as "this team ran out of time". The word now says what the field
        // is, and the relation to the finished round is stated explicitly.
        //
        // The completion instant is derived from the two stored fields the score
        // itself is made of (`game_started_at` + the official duration), because
        // `game_stopped_at` is only written when a clock is stopped by expiry or
        // cancellation and stays null on a winning round.
        const finishedAt = m.result === 'WON' && r.game_started_at !== null && m.game_ms !== null
          ? r.game_started_at + m.game_ms
          : r.game_stopped_at;
        const deadlineText = r.deadline_at === null || finishedAt === null
          ? (r.deadline_at === null ? '—' : formatWallTime(r.deadline_at))
          : `${formatWallTime(r.deadline_at)} · ${m.result === 'WON'
            ? (finishedAt < r.deadline_at ? 'đội hoàn thành trước mốc' : 'đội hoàn thành sau mốc')
            : (finishedAt <= r.deadline_at ? 'đồng hồ dừng trước mốc' : 'đồng hồ dừng sau mốc')}`;
        return (
          <details key={r.id} className="round-card" data-testid={`round-detail-${r.team_number}`}>
            <summary className="round-card-head" data-testid={`round-detail-toggle-${r.team_number}`}>
              <span className="round-card-title">
                ĐỘI #{pad(r.team_number)}{' '}
                <span className="text-mute">· {STATUS_LABEL[r.status] ?? PHASE_LABEL[flowStatus(r) ?? ''] ?? 'Không rõ'}</span>
              </span>
              <span className="round-card-score digital" data-testid={`round-score-${r.team_number}`}>
                {m.game_ms === null ? '—' : formatClockMs(m.game_ms)}
                <span className={`round-card-result${m.result === 'WON' ? ' is-won' : m.result === 'TIME_UP' || m.result === 'ABORTED' ? ' is-bad' : ''}`}>
                  {OUTCOME_LABEL[m.result] ?? 'Không rõ'}
                </span>
              </span>
              {r.needs_review ? (
                <span className="round-card-flag" data-testid={`round-flag-${r.team_number}`}>CHỜ XÉT</span>
              ) : r.decertified ? (
                <span className="round-card-flag is-out" data-testid={`round-flag-${r.team_number}`}>ĐÃ LOẠI KHỎI BẢNG</span>
              ) : null}
              <ChevronDownIcon className="round-card-chevron" />
            </summary>
            <div className="round-card-body" data-testid={`round-detail-rows-${r.team_number}`}>
              <Row k="Nhận đội" v={r.called_at ? formatWallTime(r.called_at) : '—'} />
              <Row
                k="Tầng 2"
                v={r.floor2_confirmed_at ? formatWallTime(r.floor2_confirmed_at) : r.floor2_bypassed_at ? 'BỎ QUA (NPC 1)' : '—'}
                tone={r.floor2_bypassed_at !== null ? 'text-ember' : 'text-snow'}
              />
              <Row k="Bắt đầu lượt chơi" v={r.game_started_at ? formatWallTime(r.game_started_at) : '—'} />
              <Row k="Thời lượng lượt" v={r.game_started_at !== null ? formatClockSec(limit) : '—'} />
              <Row k="Mốc hết giờ theo lịch" v={deadlineText} />
              <Row k="Chuẩn bị" v={formatSeconds(m.prep_ms)} />
              <Row k="Rời tầng 3" v={r.exit_confirmed_at ? formatWallTime(r.exit_confirmed_at) : '—'} />
              <Row k="Hủy lượt" v={r.aborted_at ? `${formatWallTime(r.aborted_at)} · ${abortKindWord(r.abort_kind)}` : '—'} tone={r.aborted_at !== null ? 'text-blood' : 'text-snow'} />
              {/* V3.4 §9 — the reason the operator typed is a stored field, and it
                  belongs next to the classification rather than only in the audit
                  line. The authority assigns the kind from the PATH that stopped
                  the round (a gate-side early exit is classified `safety`
                  whatever was written in the reason box — engine.ts line 965), and
                  the two paths keep their words in different columns:
                  `abort_reason` for ABORT_ROUND, `exit_reason` for EARLY_EXIT.
                  Showing whichever one is set makes the pair visible as two facts
                  in one place instead of a contradiction spread across two tabs.
                  Neither word is rewritten and no rule is changed. */}
              {r.aborted_at !== null && (r.abort_reason ?? r.exit_reason) ? (
                <Row k="Lý do ghi nhận" v={String(r.abort_reason ?? r.exit_reason)} tone="text-blood" />
              ) : null}
              <Row k="Reset tổng" v={formatSeconds(m.reset_total_ms)} tone={isSlowReset(m.reset_total_ms, snap.event.config.reset_target_ms) ? 'text-ember' : 'text-snow'} />
              <Row k="NPC 1 chốt khu vực" v={formatSeconds(m.gate_clear_ms)} />
              {/* V3.4.1: the official score and the outcome word are the round card's
                  own headline, visible without opening it. Repeating them as rows
                  inside the body was the same two facts twice per team, and eleven
                  rows per team made the report a wall. */}
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
          </details>
        );
      })}
    </div>
  );
}

function isSlowReset(value: number | null, target: number | null): boolean {
  return value !== null && target !== null && value > target * 1.5;
}

/** Rounds + full audit trail as CSV. Lives in the report tab: export is a
 * reading action, not a control. */
function exportCsv(snap: NonNullable<ReturnType<LiveStore['getSnapshot']>['snapshot']>) {
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
      {/* V3.4 §9 — two populations, two rows. One row called "Kết quả chờ xét"
          counted only the withheld SCORES (a round with an official time), while
          every round card printed `CHỜ XÉT` from `needs_review`, which a
          cancellation also sets. A night with one cancelled round therefore read
          "0" beside a card that said "awaiting review". Each count now names the
          set it measures, and both come straight from the stored flags.
          V3.4.1 kept both here and dropped the duplicate from the summary block:
          this is the section that explains what is being withheld. */}
      <Row
        k="Vòng chờ quyết định"
        v={String(stats.reviewPending)}
        tone={stats.reviewPending > 0 ? 'text-ember' : 'text-snow'}
      />
      <Row
        k="Điểm chờ xét"
        v={String(stats.disputed)}
        tone={stats.disputed > 0 ? 'text-ember' : 'text-snow'}
      />
      <Row k="Quá giờ" v={String(stats.timeouts)} tone={stats.timeouts > 0 ? 'text-blood' : 'text-snow'} />
      {/* `aborted` was already computed and never printed, so a night with
          cancellations reported them nowhere in the summary — the one number
          that tells an organiser a round was stopped rather than run out. */}
      <Row k="Lượt bị hủy" v={String(stats.aborted)} tone={stats.aborted > 0 ? 'text-blood' : 'text-snow'} />
      <Row k="TB hoàn thành" v={formatSeconds(stats.avg_game_ms, 2)} />
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
        Sai số hiển thị ước tính {state.maxDisplayErrorMs === null ? 'chưa đồng bộ' : `${state.maxDisplayErrorMs} ms`} · now = {formatWallTime(now)}
      </div>
    </div>
  );
}

/**
 * BÁO CÁO §6 — the audit trail, searchable and folded by default.
 *
 * V3.4 §9: the log is the longest thing on the tab and the least often read
 * end to end, so it now opens as its last eight entries with the count in the
 * heading, and the three filters do the scrolling. Filtering is pure
 * presentation over `snap.log`: the rows themselves are the server's, and no
 * filter, search or fold can hide one from the export or change one.
 */
function History({ snap }: { snap: NonNullable<ReturnType<LiveStore['getSnapshot']>['snapshot']> }) {
  const [query, setQuery] = useState('');
  const [role, setRole] = useState('');
  const [action, setAction] = useState('');
  const [open, setOpen] = useState(false);
  const entries = [...snap.log].reverse();
  const lineText = (l: Snapshot['log'][number]) => [
    l.metadata?.detail_text ? String(l.metadata.detail_text) : ACTION_LABEL[l.action] ?? '',
    l.action,
    ROLE_SHORT[l.actor_role as Role] ?? l.actor_role ?? '',
    l.actor_role ?? '',
    l.team_number !== null ? `#${pad(l.team_number)}` : '',
    l.metadata?.reason ? String(l.metadata.reason) : '',
  ].join(' ').toLowerCase();
  const needle = query.trim().toLowerCase();
  const filtered = entries.filter((l) => {
    if (role !== '' && l.actor_role !== role) return false;
    if (action !== '' && l.action !== action) return false;
    return needle === '' || lineText(l).includes(needle);
  });
  const filtering = needle !== '' || role !== '' || action !== '';
  const shown = filtering || open ? filtered : filtered.slice(0, 8);
  const roles = Array.from(new Set(entries.map((l) => l.actor_role))).sort();
  const actions = Array.from(new Set(entries.map((l) => l.action))).sort();
  return (
    <div className="flex flex-col gap-2">
      <div className="audit-filters" data-testid="audit-filters">
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          placeholder="Tìm trong nhật ký…"
          aria-label="Tìm trong nhật ký"
          className="min-w-0 flex-1 rounded border border-hair bg-ink px-2 py-2 text-[0.72rem] text-snow"
          data-testid="audit-search"
        />
        <select
          value={role}
          onChange={(e) => { setRole(e.target.value); setOpen(true); }}
          aria-label="Lọc theo vị trí"
          className="rounded border border-hair bg-ink px-2 py-2 text-[0.7rem] text-snow"
          data-testid="audit-filter-role"
        >
          <option value="">Mọi vị trí</option>
          {roles.map((r) => <option key={r} value={r}>{ROLE_SHORT[r as Role] ?? r}</option>)}
        </select>
        <select
          value={action}
          onChange={(e) => { setAction(e.target.value); setOpen(true); }}
          aria-label="Lọc theo thao tác"
          className="min-w-0 flex-1 rounded border border-hair bg-ink px-2 py-2 text-[0.7rem] text-snow"
          data-testid="audit-filter-action"
        >
          <option value="">Mọi thao tác</option>
          {actions.map((a) => <option key={a} value={a}>{ACTION_LABEL[a] ?? a}</option>)}
        </select>
      </div>
      <p className="text-[0.66rem] text-mute" data-testid="audit-count">
        {filtered.length === entries.length
          ? `${entries.length} mục nhật ký`
          : `${filtered.length}/${entries.length} mục khớp bộ lọc`}
        {filtering ? ' · bỏ lọc để xem toàn bộ' : ''}
      </p>
      {filtered.length === 0 ? (
        <p className="text-[0.7rem] text-mute" data-testid="audit-empty">Không có mục nào khớp bộ lọc.</p>
      ) : (
        <ul className="flex flex-col gap-1.5" data-testid="history">
          {shown.map((l) => (
            <li key={l.seq} className="border-b border-hair/40 pb-1.5 text-[0.7rem] last:border-0" data-testid={`audit-${l.seq}`}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="digital text-mute">{formatWallTime(l.at_ms)}</span>
                <span className="text-[0.62rem] tracking-[0.08em] text-mute">bản {l.revision}</span>
              </div>
              <p className="text-snow">
                {/* The engine already writes a Vietnamese sentence for every press; the
                    action type is only a fallback for rows older than that habit.
                    V3.4.1: that sentence names the team itself (“Đội #001 đã đến tầng
                    2”), so the trailing “· #001” was the same team introduced twice
                    in one line. It stays only on the old rows, where the fallback
                    label names no team at all. The search index still reads both. */}
                {l.metadata?.detail_text ? String(l.metadata.detail_text) : ACTION_LABEL[l.action] ?? 'Thao tác không rõ'}
                {l.metadata?.detail_text || l.team_number === null ? null : (
                  <span className="text-mute"> · #{pad(l.team_number)}</span>
                )}
              </p>
              <p className="text-[0.62rem] text-mute">
                {ROLE_SHORT[l.actor_role as Role] ?? l.actor_role}
                {l.actor_id === 'system.clock' ? ' (tự động)' : ''}
                {/* V3.4.1: a press that left the workflow where it was printed its
                    own state twice as a move — “Đội sắp bắt đầu → Đội sắp bắt đầu”
                    reads as a transition that happened when the server recorded
                    none. Only a real change of state is worth an arrow. */}
                {l.from_state && l.to_state && STATUS_LABEL[l.from_state] !== STATUS_LABEL[l.to_state]
                  ? ` · ${STATUS_LABEL[l.from_state] ?? l.from_state} → ${STATUS_LABEL[l.to_state] ?? l.to_state}`
                  : ''}
                {l.metadata?.reason ? ` · lý do: ${String(l.metadata.reason)}` : ''}
              </p>
            </li>
          ))}
          {!filtering && filtered.length > shown.length ? (
            <li>
              <button
                type="button"
                onClick={() => setOpen(true)}
                className="w-full rounded-panel border border-hair px-3 py-2 text-[0.7rem] text-snow"
                data-testid="audit-expand"
              >
                XEM ĐỦ {filtered.length} MỤC
              </button>
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- report tab */

/**
 * V3.4 §9 (UI-07) — BÁO CÁO in the order an organiser reads it: what happened
 * overall, what the best official result was, who is ranked, how each team got
 * there, how the floor performed, the audit trail, and only then the technical
 * diagnostics and the export.
 *
 * The numbers are the same ones the engine stored; this component only chooses
 * the order and the words. Nothing here recalculates a score: the summary reads
 * `roundCounts`, the best result and the leaderboard read `leaderboard(snap)`,
 * which already excludes decertified and undecided rounds — so the headline and
 * the table can never disagree about who won.
 */
function ReportTab({ store, snap, now, rows, stats }: {
  store: LiveStore;
  snap: NonNullable<ReturnType<LiveStore['getSnapshot']>['snapshot']>;
  now: number;
  rows: ReturnType<typeof leaderboard>;
  stats: ReturnType<typeof analytics>;
}) {
  const best = rows.length > 0 ? rows[0] : null;
  const counts = roundCounts(snap);
  return (
    <div className="flex flex-col gap-2">
      {/* ------------------------------------------------------- 1. summary */}
      <Section title="Tổng quan sự kiện" testid="section-summary">
        <div data-testid="report-summary">
          {/* V3.4.1: the event's name and its verdict are the sheet header, which is
              pinned above the tabs and never scrolls away. What the header does not
              answer is how many rounds and how many results, so that is what this
              block now starts with. */}
          <Row k="Lượt" v={counts.sentence} tone={counts.aborted > 0 ? 'text-ember' : 'text-snow'} />
          <Row k="Đội có kết quả chính thức" v={String(stats.teams_successful)} tone="text-jade" />
        </div>
      </Section>

      {/* ------------------------------------------ 2. the best official result */}
      <Section title="Kết quả chính thức tốt nhất" testid="section-best">
        {best === null ? (
          <p className="py-3 text-[0.75rem] text-mute" data-testid="report-best-empty">
            Chưa có kết quả chính thức nào được xếp hạng.
          </p>
        ) : (
          <div className="report-best" data-testid="report-best">
            <p className="report-best-time digital">{formatClockMs(best.duration_ms)}</p>
            <p className="report-best-team" data-testid="report-best-team">
              ĐỘI #{pad(best.team_number)}{best.team_name ? ` · ${best.team_name}` : ''}
            </p>
            <p className="report-best-rule">
              Chỉ tính đội được NPC 2 chốt trong thời lượng lượt chơi.
            </p>
          </div>
        )}
      </Section>

      {/* ---------------------------------------------------- 3. leaderboard */}
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

      {/* ------------------------------------------- 4. per-team result cards */}
      <Section title="Từng đội" testid="section-rounds">
        <RoundDetails snap={snap} now={now} />
      </Section>

      {/* ------------------------------------------ 5. operational performance */}
      <Section title="Hiệu suất vận hành" testid="section-performance">
        <Performance stats={stats} store={store} now={now} />
      </Section>

      {/* ------------------------------------------------------- 6. the audit */}
      <Section title="Nhật ký vận hành" testid="section-history">
        <History snap={snap} />
      </Section>

      {/* ------------------------------------------------- 7. technical read */}
      <details className="report-diagnostics" data-testid="report-diagnostics">
        <summary className="report-diagnostics-head">CHẨN ĐOÁN KỸ THUẬT</summary>
        <Connectivity store={store} now={now} />
      </details>

      {/* --------------------------------------------------------- 8. export */}
      <button type="button" onClick={() => exportCsv(snap)} className="rounded-panel border border-hair px-3 py-3 text-[0.75rem] text-snow" data-testid="export-csv">
        XUẤT CSV
      </button>
    </div>
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
  // V3.3: the per-seat rescue surface lives in <SeatManagement />, which owns
  // its own armed/busy/result state and its own read of who holds each seat
  // (migration 0021), so this component stays about the event itself.
  const [reason, setReason] = useState('');
  const [reopen, setReopen] = useState<{ round_id: string; task_key: string; reason: string }>({
    round_id: '',
    task_key: 'hidden_objects',
    reason: '',
  });
  const [review, setReview] = useState<{ round_id: string; reason: string }>({ round_id: '', reason: '' });
  const [closeReason, setCloseReason] = useState('');
  // V3.2+: the fresh event name is optional; blank means "keep the closed event's
  // name", so an identical night can be reopened without re-typing the title.
  const [newEventName, setNewEventName] = useState('');
  const [correction, setCorrection] = useState<{ round_id: string; field: string; value: string }>({
    round_id: '',
    field: 'exit_confirmed_at',
    value: '',
  });
  const started = snap.event.event_started_at !== null;
  const ended = snap.event.event_ended_at !== null;
  const round: Round | null = snap.active_round;
  // V3.4 §9 — the review control used to list `disputedRounds`, which requires an
  // official duration. A misconduct cancellation with no validated claim sets
  // `needs_review` and no duration, and the engine's own rule
  // (`attemptsJudgable`: a misconduct round reopens only through REVIEW_RESOLVE)
  // means nothing else can ever close it — so the one round that most needed a
  // supervisor's decision was invisible to the control that makes it. The list is
  // the awaiting-decision population now, and each row says which kind of wait it
  // is. The prize-relevant subset keeps its own count in the heading.
  const reviewable = reviewPendingRounds(snap.rounds);
  const withheld = disputedRounds(snap.rounds).length;
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

  /**
   * V3.3 per-seat release moved to <SeatManagement />: it needs its own read of
   * who holds each seat (migration 0021) and its own busy/armed state.
   */

  /**
   * V3.4 §9 — the admin tab is ordered by what the organiser has to decide, not
   * by the order the controls were written. One event state, then the one thing
   * that needs action, then the seats, then the event itself, then settings, and
   * only last the operations that can damage a night. Every confirmation,
   * permission check and audit entry below is the one that was already there:
   * nothing in this restructure adds, removes or softens a guard.
   */
  return (
    <div className="flex flex-col gap-4" data-testid="management">
      {/* ---------------------------------------------- 1. current event status */}
      <AdminEventStatus snap={snap} now={snap.server_now_ms} />

      {/* ----------------------------------- 2. the issue and the next action */}
      {/* Same selector the crew's own operations tab reads, so an organiser and a
          station can never be shown two different versions of what happens next. */}
      <AdminNextAction snap={snap} now={snap.server_now_ms} />

      {/* --------------------------------------------------- 3. QUẢN LÝ VỊ TRÍ */}
      <section className="admin-group" data-testid="admin-group-seats" aria-label="Quản lý vị trí">
        <h4 className="admin-group-title">QUẢN LÝ VỊ TRÍ</h4>
        <SeatManagement store={store} now={snap.server_now_ms} />
        {/* V3.4.1: the “VỊ TRÍ ĐANG BIND” list under the table was the same five rows
            the table above already prints — role, holder, last action — with less
            detail and a different vocabulary. One list now says who holds what. */}
      </section>

      {/* ------------------------------- 4. release the whole board (bulk, risky) */}
      {USING_SUPABASE && (
        <div className="flex flex-col gap-2" data-testid="release-panel">
          <p className="text-[0.7rem] tracking-[0.1em] text-mute">GIẢI PHÓNG BẢNG VỊ TRÍ</p>
          <HelpDetails label="Giải phóng bảng là gì?"><p className="text-[0.66rem] leading-snug text-mute">
            Thu hồi mọi máy đang giữ chỗ trực để ca mới chọn lại vị trí. Đồng hồ, kết quả và lịch sử giữ nguyên.
          </p></HelpDetails>
          {/* Normal path: two taps, and PostgreSQL still refuses if the floor is busy. */}
          <button
            type="button"
            disabled={releasing}
            onClick={() => { if (!armed) { setArmed(true); return; } void releaseBoard(false); }}
            className="rounded-panel border border-hair bg-panel px-3 py-3.5 text-[0.78rem] font-semibold text-snow disabled:opacity-50"
            data-testid="release-confirm"
          >
            {releasing ? 'ĐANG GIẢI PHÓNG…' : armed ? 'XÁC NHẬN GIẢI PHÓNG BẢNG' : 'GIẢI PHÓNG BẢNG'}
          </button>
          {armed ? (
            <p className="text-[0.64rem] leading-snug text-ember" data-testid="release-armed">
              Nhấn tiếp để thu hồi mọi vị trí trực. Chỉ thực hiện khi khu vực trống.
            </p>
          ) : null}
          {released !== null && (
            <p role="status" className="text-[0.68rem] leading-snug text-snow" data-testid="release-result">{released}</p>
          )}
        </div>
      )}

      {/* ------------------------------------------------ 5. event lifecycle */}
      <section className="admin-group" data-testid="admin-group-lifecycle" aria-label="Vòng đời sự kiện">
        <h4 className="admin-group-title">VÒNG ĐỜI SỰ KIỆN</h4>
        {ended ? (
          /* The event is closed. The only move that hands the room to the next shift
             is OPEN_NEW_EVENT: it points sc.state at a fresh sc.events row that
             inherits this event's configuration, and writes a new audit entry —
             nothing on the closed event is deleted or rewritten. */
          <div className="flex flex-col gap-2">
            <p className="rounded-panel border border-hair bg-ink px-3 py-3 text-[0.7rem] leading-snug text-mute" data-testid="admin-open-hint">
              Mở ca mới để nhận đội. Lịch sử được giữ lại.
            </p>
            <input
              value={newEventName}
              onChange={(e) => setNewEventName(e.target.value)}
              placeholder="Tên ca mới (tuỳ chọn)"
              className="rounded border border-hair bg-ink px-2 py-2 text-[0.75rem] text-snow"
              data-testid="new-event-name"
            />
            <button
              type="button"
              disabled={store.getSnapshot().pending === 'OPEN_NEW_EVENT'}
              onClick={() => {
                const name = newEventName.trim().replace(/\s+/g, ' ');
                void store.act('OPEN_NEW_EVENT', name ? { event_name: name } : {});
                setNewEventName('');
              }}
              className="rounded-panel border border-jade/60 bg-jade/10 px-3 py-4 text-[0.8rem] font-bold text-jade disabled:opacity-50"
              data-testid="admin-open-new"
            >
              MỞ SỰ KIỆN MỚI
            </button>
          </div>
        ) : !started ? (
          <p className="rounded-panel border border-hair bg-ink px-3 py-3 text-[0.7rem] leading-snug text-mute" data-testid="admin-start-hint">
            Chờ Nhân sự 01 nhận đội, NPC 1 bắt đầu lượt.
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
              ĐÓNG SỰ KIỆN
            </button>
          </div>
        )}
      </section>

      {/* --------------------------------------------------- 6. configuration */}
      <section className="admin-group" data-testid="admin-group-config" aria-label="Cấu hình">
        <h4 className="admin-group-title">CẤU HÌNH LƯỢT CHƠI</h4>
        <div className="flex flex-col gap-2">
        <p className="text-[0.7rem] text-mute" data-testid="cfg-duration-current">
          Thời lượng: <span className="text-snow">{formatClockSec(snap.event.config.game_limit_ms)}</span>.
          {round && round.game_started_at !== null ? ' Đổi từ lượt sau.' : ''}
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
      </section>

      {/* ------------------------------------------- 7. high-risk recovery */}
      {/* Everything that can damage a night is in one place, behind its own
          heading, and it is the LAST group on the tab. Each control keeps the
          confirmation it already had — the two-tap release, the mandatory reason
          fields, the server-side permission check — and none of them deletes a
          score, a claim or a history row. */}
      <details className="admin-risk-group" data-testid="admin-group-risk" aria-label="Khôi phục rủi ro cao">
        <summary className="admin-risk-title">CAN THIỆP & KHÔI PHỤC</summary>
        <p className="admin-risk-note">
          Can thiệp có ghi nhật ký.
        </p>

        {/* Emergency board release, moved out of the release panel because it is the
            one control here that closes a live round as a side effect. */}
        {USING_SUPABASE && (
          <details className="rounded-panel border border-blood/40 bg-blood/5" data-testid="release-emergency-details">
            <summary className="cursor-pointer px-3 py-2 text-[0.68rem] font-semibold text-blood marker:hidden">
              Giải phóng khẩn cấp
            </summary>
            <p className="px-3 pb-2 text-[0.64rem] leading-snug text-mute">
              Lượt đang mở sẽ bị HỦY có ghi nhật ký và toàn bộ máy bị thu hồi. Điểm và lịch sử không mất.
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
        )}

        {round && (
          <>
            <p className="text-[0.7rem] tracking-[0.1em] text-mute">KIỂM SOÁT KHẨN CẤP</p>
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
          placeholder="epoch ms"
          inputMode="numeric"
          className="rounded border border-hair bg-ink px-2 py-2 text-[0.7rem] text-snow"
          data-testid="corr-value"
        />
        </div>
        {/* The explanation used to live in the placeholder, where the narrow
            column of the two-up grid cut it to "epoch ms · để trống = hc" at
            390px. A rule the operator has to guess is not a hint. */}
        <p className="text-[0.62rem] leading-snug text-mute" data-testid="corr-value-hint">
          Giá trị tính bằng epoch ms. Để trống để hoàn tác mốc đã ghi.
        </p>
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

      {reviewable.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-[0.7rem] tracking-[0.1em] text-ember" data-testid="review-count">
            VÒNG CHỜ QUẢN TRỊ VIÊN QUYẾT ({reviewable.length})
            {withheld > 0 ? ` · ${withheld} có điểm chính thức đang bị tạm xếp hạng` : ''}
          </p>
          <select
            value={review.round_id}
            onChange={(e) => setReview({ ...review, round_id: e.target.value })}
            className="rounded border border-hair bg-ink px-2 py-2 text-[0.75rem] text-snow"
            data-testid="review-round"
          >
            <option value="">Chọn đội chờ xét…</option>
            {reviewable.map((r) => (
              <option key={r.id} value={r.id}>
                #{pad(r.team_number)} · {r.official_duration_ms !== null ? formatClockCs(r.official_duration_ms) : 'không có điểm chính thức'} ·{' '}
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
            MỞ LẠI RESET · XÁC NHẬN LẠI 3 BƯỚC
          </button>
        </div>
      )}
      </details>
    </div>
  );
}
