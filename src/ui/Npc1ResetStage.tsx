import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';
import type { LiveStore, StoreState } from '../client/liveStore';
import type {
  AlertInfo,
  AttemptRow,
  JourneyInfo,
  PrimaryAction,
  ReadinessView,
  ResetBoard,
  ResultSummary,
} from '../client/selectors';
import { PHASE_LABEL, ROLE_AREA, ROLE_DUTY, ROLE_PERSON, type Role } from '../shared/constants';
import { formatClockSec } from '../shared/metrics';
import type { CommandResult, Snapshot, SystemPhase } from '../shared/types';
import { ACCENT_HEX, ROLE_ACCENT } from './accents';
import { JourneyStepper } from './JourneyMap';
import { AttemptLedger, NextTeamStatus, ResetActionNote, ResetChecklist, RoundResultCard } from './ResetStatus';
import { AlertIcon, BarsIcon, CheckIcon, ChevronRightIcon, RunnerIcon } from './icons';
import { alarms } from './sound';

interface Props {
  store: LiveStore;
  snap: Snapshot;
  phase: SystemPhase;
  role: Role;
  /** NPC 1's control, derived by the same selector every phone reads. */
  primary: PrimaryAction;
  journey: JourneyInfo;
  alerts: AlertInfo[];
  state: StoreState;
  syncBroken: boolean;
  /** The three physical responsibilities, read from the stored checklist rows. */
  board: ResetBoard;
  /** The completed round's authoritative result — echoed, never recalculated. */
  summary: ResultSummary;
  /** Whether the next team may be received yet, from the lobby's own predicate. */
  readiness: ReadinessView;
  attempts: AttemptRow[];
  teamNumber: number | null;
  onOpenJourney(): void;
  onOpenReport(): void;
}

/**
 * NPC 1 — SCREEN B: the post-round reset checkpoint (V3.4).
 *
 * What this phone has to be certain of, in the order it has to be read:
 *
 *   1. which team just finished, and that its round is over
 *   2. the official result the server recorded for it
 *   3. that the floor is now being prepared — not counted down
 *   4. the three physical reset areas and their real status
 *   5. the one confirmation this station is permitted to make
 *   6. whether the next team may be received yet, and who is holding it back
 *   7. the secondary destinations, under all of it
 *
 * The screen shows no running clock, because there is none: the next round's
 * window is offered as labelled secondary information about a team that has not
 * been received. Nothing here releases a seat, closes or opens an event, touches
 * the previous round's timestamps or starts a countdown — those stay the separate
 * operations they are, and the only write this screen can make is the station's
 * own `RESET_DONE` on the rows assigned to it.
 */
export function Npc1ResetStage({
  store,
  snap,
  phase,
  role,
  primary,
  journey,
  alerts,
  state,
  syncBroken,
  board,
  summary,
  readiness,
  attempts,
  teamNumber,
  onOpenJourney,
  onOpenReport,
}: Props) {
  const accent = ACCENT_HEX[ROLE_ACCENT.GATE];
  // This phone's own write, kept apart from the stored state: an unacknowledged or
  // refused confirmation is a fact about the network, never a checklist state.
  const [write, setWrite] = useState<{ failed: boolean; message: string } | null>(null);
  const submitting = state.pending === 'RESET_DONE' || state.verifying === 'RESET_DONE';

  useEffect(() => {
    // A new round, or a confirmation that has now landed, ends the old write's story.
    setWrite(null);
  }, [snap.active_round?.id, board.mineDone]);

  // The station's rows wear the write's outcome; the areas nobody else owns are
  // never touched by this phone's network.
  const shownBoard: ResetBoard = {
    ...board,
    rows: board.rows.map((row) => {
      if (!row.mine || row.state === 'done') return row;
      if (submitting) return { ...row, state: 'submitting' as const, status: 'Đang chờ xác nhận', note: 'Đã gửi máy chủ — chờ xác nhận ghi nhận.' };
      if (write?.failed) return { ...row, state: 'failed' as const, status: 'Lỗi xác nhận', note: write.message };
      return row;
    }),
  };
  // The pre-start alert belongs to a phase this screen has left behind; anything
  // else the machine raises (verification, review, a stale read) stays visible.
  const shownAlerts = alerts.filter((a) => a.id !== 'PRESTART');

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-[560px] flex-1 flex-col gap-2.5">
      {/* ------------------------------------------------------------ identity */}
      <section
        className="role-band"
        style={{ '--role-accent': accent } as CSSProperties}
        data-testid="npc1-reset-identity"
        data-sync={syncBroken ? 'broken' : 'live'}
      >
        <div className="min-w-0 flex-1">
          <p className="role-band-name" data-testid="npc1-role">{ROLE_PERSON.GATE}</p>
          <p className="role-band-area">{ROLE_AREA.GATE}</p>
          <p className="mt-0.5 text-[9.5px] leading-snug text-mute">{ROLE_DUTY.GATE}</p>
        </div>
        <p className="role-band-state" data-testid="event-state" data-broken={syncBroken ? '1' : '0'}>
          {syncBroken ? 'KHÔNG ĐỌC ĐƯỢC MÁY CHỦ' : PHASE_LABEL[phase] ?? 'CHỜ ĐỒNG BỘ'}
        </p>
      </section>

      {/* ------------------------------ 1-2. the finished round, stated once */}
      <RoundResultCard
        summary={summary}
        teamNumber={teamNumber}
        nextLimitLabel={formatClockSec(snap.event.config.game_limit_ms)}
      />

      {/* ------------------------------------ 3-4. the physical reset work */}
      <p className="reset-stage-head" data-testid="reset-stage-head">
        <span className="reset-stage-title">ĐANG RESET KHU VỰC</span>
        <span className="reset-stage-sub">Đang chuẩn bị khu vực cho đội tiếp theo</span>
      </p>
      <ResetChecklist board={shownBoard} role={role} />

      {/* ------------------------------------------ 5. the one press here */}
      {shownAlerts.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => alarms.unlock()}
          className="notice-band"
          data-tone={a.tone === 'danger' ? 'danger' : 'warn'}
          data-testid={`alert-${a.id}`}
        >
          <AlertIcon />
          <span>{a.text}</span>
        </button>
      ))}

      {state.error ? (
        <p role="status" className="notice-band" data-tone="danger" data-testid="message">
          <AlertIcon />
          <span>{state.error}</span>
        </p>
      ) : state.notice ? (
        <p role="status" className="notice-band" data-tone="info" data-testid="notice">
          <CheckIcon className="h-3.5 w-3.5" />
          <span>{state.notice}</span>
        </p>
      ) : null}

      <ResetAction
        store={store}
        primary={primary}
        pending={state.pending}
        verifying={state.verifying}
        board={shownBoard}
        onSettled={(result) => {
          if (result && result.ok) {
            setWrite(null);
            return;
          }
          setWrite({
            failed: true,
            message: result?.message
              ? String(result.message)
              : 'Chưa xác nhận được với máy chủ — kiểm tra kết nối rồi bấm lại.',
          });
        }}
      />
      <ResetActionNote board={shownBoard} />

      {/* ------------------------------------ 6. the next team's eligibility */}
      <NextTeamStatus readiness={readiness} />

      {/* ----------------------------------------- 7. secondary, out of the way */}
      <AttemptLedger attempts={attempts} />
      <JourneyStepper journey={journey} onOpen={onOpenJourney} />

      <div className="npc1-reset-nav">
        <button type="button" onClick={onOpenJourney} className="nav-link" data-testid="npc1-open-map">
          <RunnerIcon className="h-3.5 w-3.5" />
          SƠ ĐỒ HÀNH TRÌNH
        </button>
        <button type="button" onClick={onOpenReport} className="nav-link" data-testid="npc1-open-report">
          <BarsIcon className="h-3.5 w-3.5" />
          KẾT QUẢ & LỊCH SỬ
          <ChevronRightIcon className="h-3 w-3" />
        </button>
      </div>

      <div className="sc-spacer" />
    </div>
  );
}

/**
 * The station's own confirmation, with the guards the flow already relies on:
 * one write at a time (the store's in-flight lock plus the server's idempotency
 * key), a caption that changes while the write is unacknowledged, and no control
 * at all once the server has recorded the area — the read-only status in the
 * checklist takes its place, so a duplicate tap cannot even be offered.
 */
function ResetAction({ store, primary, pending, verifying, board, onSettled }: {
  store: LiveStore;
  primary: PrimaryAction;
  pending: string | null;
  verifying: string | null;
  board: ResetBoard;
  onSettled(result: CommandResult | null): void;
}) {
  const busy = pending !== null || verifying !== null;
  if (primary.action === null) {
    // Nothing to press: the same shape as the action, visibly off, with the one
    // line the authoritative state implies. The RPC still refuses a forced call.
    return (
      <div className="flex flex-col gap-1">
        <button
          type="button"
          disabled
          aria-disabled="true"
          title={primary.hint ?? undefined}
          className="cta cta-neutral opacity-45 saturate-50"
          data-testid="waiting-state"
          data-unavailable={primary.hint ? '1' : '0'}
        >
          <span className="cta-label-main">{primary.label}</span>
        </button>
        {primary.hint ? <p className="cta-reason" data-testid="waiting-reason">{primary.hint}</p> : null}
      </div>
    );
  }
  // A row this station owns and the server has already confirmed closes the door:
  // `board.mineDone` is the stored cycle, not a local memory of the tap.
  const pressed = primary.action === 'RESET_DONE' && board.mineDone;
  const disabled = busy || pressed;
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => {
          // The null check has to be a local binding: inside the async closure
          // below, TypeScript no longer remembers that `primary.action` was tested.
          const action = primary.action;
          if (disabled || action === null) return;
          alarms.unlock();
          void (async () => onSettled(await store.act(action, primary.meta)))();
        }}
        disabled={disabled}
        aria-busy={busy}
        className={`cta cta-${primary.action === 'RESET_DONE' ? 'amber' : 'green'}`}
        data-testid="primary-action"
        data-action={primary.action}
        data-pending={busy ? '1' : '0'}
      >
        {busy ? (
          <span className="cta-label-main" role="status">{verifying !== null ? 'ĐANG XÁC MINH…' : 'ĐANG GHI…'}</span>
        ) : (
          <>
            <CheckIcon className="h-5 w-5" />
            <span className="cta-label-main">{primary.label}</span>
          </>
        )}
      </button>
      {primary.hint ? <p className="cta-reason" data-testid="primary-hint">{primary.hint}</p> : null}
    </div>
  );
}
