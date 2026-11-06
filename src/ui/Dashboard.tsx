import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import type { LiveStore, StoreState } from '../client/liveStore';
import type { StoredSession } from './session';
import {
  awaitingVerification,
  isLockedPhase,
  pad,
  phaseOf,
  resolveAlerts,
  resolveAttempts,
  resolveCountdown,
  resolveEmergency,
  resolveHandoff,
  resolveJourney,
  resolveNpc2Stage,
  resolveNextTeamReadiness,
  resolvePrimary,
  resolveResetBoard,
  resolveResultSummary,
  resolveSyncState,
  resolveTeamLine,
  teamLabel,
  type AlertInfo,
  type AttemptRow,
  type HandoffInfo,
  type JourneyInfo,
  type Npc2Stage,
  type PrimaryAction,
  type TeamLine,
} from '../client/selectors';
import { useNow, useWakeLock } from './hooks';
import { alarms } from './sound';
import {
  PHASE_LABEL,
  ROLE_AREA,
  ROLE_DUTY,
  ROLE_LABEL,
  ROLE_PERSON,
  ROLE_SHORT,
  TEAM_NAME_MAX,
  type Role,
} from '../shared/constants';
import { roundLimitMs } from '../shared/machine';
import { formatClockCs, formatClockSec, formatWallTime, leaderboard } from '../shared/metrics';
import type { ActionType, CommandMeta, Round, SystemPhase } from '../shared/types';
import { DetailsSheet } from './DetailsSheet';
import { BigScreen } from './BigScreen';
import { JourneyBoard, JourneyStepper } from './JourneyMap';
import { ACCENT_HEX, ROLE_ACCENT, TEAM_TONE_HEX } from './accents';
import { countdownStage, countdownStageOf, countdownToneHex } from './countdown';
import { TimeDigits } from './TimeView';
import { Npc2Panel } from './Npc2Panel';
import { Npc1ResetStage } from './Npc1ResetStage';
import {
  AlertIcon,
  ArrowUpIcon,
  BarsIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  GearIcon,
  PencilIcon,
  PlayIcon,
  RunnerIcon,
  SignalIcon,
  SignalOffIcon,
  StopIcon,
  UsersIcon,
} from './icons';

/** Matches the engine and the database: collapse blanks, then compare. */
const cleanTeamName = (value: string) => value.trim().replace(/\s+/g, ' ');

/** Colour of the big button, taken from the action's meaning (not the station). */
const CTA_LOOK: Partial<Record<ActionType, 'red' | 'green' | 'amber' | 'ember' | 'neutral'>> = {
  CALL_TEAM: 'red',
  // V3.4 Role 02: the ember confirm — the shared SCREAM Night action colour for
  // "press when the physical fact is true". The old corporate green left the
  // horror palette at exactly the moment the floor needs it most.
  CONFIRM_FLOOR2: 'ember',
  FLOOR2_BYPASS: 'amber',
  // V3.4 NPC1 §2: START is the one press that opens the official clock. It
  // wears the ember CTA — the poster's lantern into blood — never the old
  // corporate go-green that sat outside the event identity.
  START_GAME: 'ember',
  CLAIM_COMPLETE: 'amber',
  VERIFY_ATTEMPT: 'green',
  CONFIRM_EXIT: 'green',
  EARLY_EXIT: 'red',
  RESET_DONE: 'amber',
  GATE_FINALIZE: 'green',
};

function CtaIcon({ action }: { action: ActionType | null }) {
  if (action === 'CALL_TEAM') return <UsersIcon className="h-5 w-5" />;
  if (action === 'START_GAME') return <PlayIcon className="h-5 w-5" />;
  if (action === 'CONFIRM_EXIT' || action === 'EARLY_EXIT') return <StopIcon className="h-5 w-5" />;
  if (action === 'FLOOR2_BYPASS') return <ArrowUpIcon className="h-5 w-5" />;
  return <CheckIcon className="h-5 w-5" />;
}

/**
 * V3.4 §6 — the two beats of a long command.
 *
 * "NHẬN ĐỘI & CHO LÊN TẦNG 2" is one sentence carrying two jobs: receive, then
 * send up. Held at arm's length in a dark room, that reads faster as a verb over
 * a consequence than as one long line competing for a single row of a phone.
 *
 * The split is presentation only and is deliberately lossless: the separator is
 * rendered as the first characters of the second line, so the button's text
 * content stays byte-identical to the label the state machine produced. The
 * command is never renamed — the accessible name, the words on the screen and
 * the words in the audit all stay the one sentence.
 */
const LABEL_BREAKS = [' & ', ' — '] as const;

function splitActionLabel(label: string): { head: string; tail: string } | null {
  for (const sep of LABEL_BREAKS) {
    const at = label.indexOf(sep);
    // Only break a sentence long enough to need two lines, and only when both
    // halves can stand on their own. Anything else stays exactly as written.
    if (at > 3 && label.length > 20 && label.slice(at + sep.length).trim().length > 2) {
      return { head: label.slice(0, at), tail: sep + label.slice(at + sep.length) };
    }
  }
  return null;
}

function CtaLabel({ label }: { label: string }) {
  const split = splitActionLabel(label);
  if (!split) return <span className="cta-label-main">{label}</span>;
  return (
    <span className="cta-label">
      <span className="cta-label-main">{split.head}</span>
      <span className="cta-label-sub">{split.tail}</span>
    </span>
  );
}

interface Props {
  store: LiveStore;
  account: StoredSession['account'];
  onLogout(): Promise<void>;
}

/**
 * The one operator screen. It renders whichever of the two modes the authoritative
 * phase implies: the flow screen (waiting, pre-start, exit and reset work) or the
 * locked countdown (the game itself). Both read the same selectors, so no phone can
 * show a control another phone does not.
 */
export function Dashboard({ store, account, onLogout }: Props) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const snap = state.snapshot;
  const activeRoundId = snap?.active_round?.id ?? null;
  const now = useNow(store, snap && isLockedPhase(phaseOf(snap, store.serverNow())) ? 'raf' : 'slow');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [teamName, setTeamName] = useState('');
  const [nameOpen, setNameOpen] = useState(false);
  const [bigOpen, setBigOpen] = useState(false);
  const [bigAuto, setBigAuto] = useState(false);
  const [journeyOpen, setJourneyOpen] = useState(false);
  const [sheetTab, setSheetTab] = useState<'ops' | 'admin' | 'report'>('ops');

  const phase = snap ? phaseOf(snap, now) : 'PRE_EVENT';
  const countdown = useMemo(() => (snap ? resolveCountdown(snap, now) : null), [snap, now]);
  const primary = useMemo(() => (snap ? resolvePrimary(account.role, snap, now) : null), [snap, account.role, now]);
  const journey = useMemo(() => (snap ? resolveJourney(snap, now, account.role) : null), [snap, now, account.role]);
  const teamLine = useMemo(() => (snap ? resolveTeamLine(snap, now) : null), [snap, now]);
  const handoff = useMemo(() => (snap ? resolveHandoff(snap, now) : null), [snap, now]);
  const attempts = useMemo(() => (snap ? resolveAttempts(snap, now) : []), [snap, now]);
  // V3.4 §8 (UI-05): NPC 1's post-round screen reads the stored checklist rows,
  // the round's recorded result and the same next-team predicate the lobby's own
  // press is checked against. All three are pure derivations of persisted facts,
  // so the reset screen can neither claim an area the server has not recorded nor
  // show a running clock for a round that has ended.
  const resetBoard = useMemo(() => (snap ? resolveResetBoard(snap, account.role) : null), [snap, account.role]);
  const resultSummary = useMemo(() => (snap ? resolveResultSummary(snap, now) : null), [snap, now]);
  const readiness = useMemo(
    () => (snap && resetBoard ? resolveNextTeamReadiness(snap, now, resetBoard) : null),
    [snap, now, resetBoard],
  );
  // V3.4 §2: NPC2's eligibility answer comes from the same authorize() table
  // the RPC enforces, so the phone can never offer what the server refuses.
  const npc2Stage = useMemo(() => (snap ? resolveNpc2Stage(snap, now) : null), [snap, now]);
  // The ranking reads persisted results only, so it is rebuilt when the snapshot
  // changes — not on every frame of the running game clock.
  const rows = useMemo(() => (snap ? leaderboard(snap) : []), [snap]);

  const locked = isLockedPhase(phase) || phase === 'WAITING_FOR_EXIT';
  useWakeLock(phase !== 'ENDED' && phase !== 'PRE_EVENT');

  useEffect(() => {
    setNameOpen(false);
    setTeamName('');
  }, [activeRoundId]);

  useEffect(() => {
    // A station with nothing to press during the game becomes the wall display.
    if (locked && (account.role === 'LOBBY' || account.role === 'CORRIDOR')) {
      setBigAuto(true);
      setBigOpen(true);
    }
    if (!locked) setBigOpen(false);
  }, [locked, account.role]);

  useEffect(() => {
    if (!snap || bigOpen) return;
    alarms.setPattern(locked && countdown && countdown.expired ? 'critical' : 'none');
  }, [snap, locked, countdown, bigOpen]);

  if (!snap || !countdown || !primary || !journey || !teamLine || !handoff || !npc2Stage) {
    // V3.3 P0: the boot screen must never be a dead end. Every gateway call now
    // carries a hard timeout, so if no authoritative snapshot has landed the
    // phone is genuinely offline or the read failed — say so in Vietnamese, name
    // what it is doing about it, and give the operator a manual retry next to
    // the automatic one (liveStore.verifyTick keeps polling on its own).
    const syncAge = store.dataAgeMs();
    const syncStalled = syncAge === null && state.status === 'SYNCING';
    const failed = state.status === 'OFFLINE' || state.status === 'DEGRADED' || syncStalled;
    return (
      <div className="flex h-[100dvh] items-center justify-center bg-ink text-mute" data-testid="booting">
        <div className="w-full max-w-[19rem] px-6 text-center">
          <p className="text-lg font-extrabold tracking-[0.18em] text-blood">SCREAM CONTROL</p>
          <p className="mt-3 text-sm" data-testid="booting-state">
            {failed ? 'KHÔNG ĐỌC ĐƯỢC TRẠNG THÁI MÁY CHỦ' : 'ĐANG ĐỒNG BỘ TRẠNG THÁI…'}
          </p>
          <p className="mt-1.5 text-[0.72rem] leading-snug text-mute" data-testid="booting-cause">
            {failed
              ? 'Máy chưa lấy được dữ liệu sự kiện. Kiểm tra Wi-Fi, hoặc bấm thử lại.'
              : 'Đang tải dữ liệu trực tiếp từ máy chủ…'}
          </p>
          {failed ? (
            <button
              type="button"
              onClick={() => void store.recover()}
              className="mt-4 w-full rounded-panel border border-ember/60 bg-ember/10 px-4 py-3 text-[0.82rem] font-bold text-ember active:bg-ember/20"
              data-testid="booting-retry"
            >
              THỬ LẠI NGAY
            </button>
          ) : null}
          <ReturnHome onLogout={onLogout} />
        </div>
      </div>
    );
  }

  const round = snap.active_round;
  const staleData = state.status === 'DEGRADED' || (store.dataAgeMs() ?? 0) > 22_000;
  const alerts = resolveAlerts(snap, now, staleData);
  if (alarms.status() !== 'READY' && alarms.pattern !== 'none') {
    alerts.push({ id: 'AUDIO', tone: 'danger', text: 'Chưa bật được âm thanh — chạm để kích hoạt cảnh báo' });
  }
  const accent = ACCENT_HEX[ROLE_ACCENT[account.role]];
  // V3.4 §10 — five honest states from one shared selector. Connection and
  // synchronisation stay separate claims: a transient refresh over still-
  // current data reads as `current` (never a permanent "ĐANG ĐỒNG BỘ" once
  // the server has answered), a long-quiet read reads as `reconnecting`, and
  // only a real transport failure is named MẤT KẾT NỐI. No frontend timer
  // ever fakes a healthy state, and the retry only appears when a retry is
  // the honest answer.
  const sync = resolveSyncState(state.status, { dataAgeMs: store.dataAgeMs() });
  const syncBroken = sync.key === 'failed' || sync.key === 'reconnecting';

  return (
    <div
      className="sc-shell flex h-[100dvh] flex-col"
      data-testid="dashboard"
      data-revision={snap.revision}
      data-phase={phase}
      data-locked={locked ? '1' : '0'}
      onPointerDown={() => alarms.unlock()}
    >
      {/* ------------------------------------------------------------ header.
           During the lock it keeps only what an operator needs to trust the number:
           the live connection and which station this phone is. */}
      <header className="safe-top flex items-start justify-between gap-2 px-3 pb-2.5">
        <div className="min-w-0">
          <p className="sc-wordmark">SCREAM CONTROL</p>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[8.5px] font-semibold tracking-[0.1em] text-mute">
            <span className="text-snow/55">ROOM 305</span>
            <span className="text-hair">•</span>
            {/* V3.4 §10: the dot must agree with the word beside it. A blood-red
                indicator next to "ĐÃ KẾT NỐI" read as a failure on every phone in
                the venue. Live is bone-amber and steady; only a broken read burns,
                and it changes silhouette as well as colour. */}
            {syncBroken
              ? <SignalOffIcon className="h-3 w-3 text-blood" />
              : <SignalIcon className="h-3 w-3 text-jade" />}
            <span data-testid="connection" data-status={state.status} data-sync={sync.key} className={syncBroken ? 'text-blood' : 'text-jade'}>
              {sync.label}
            </span>
            {syncBroken ? (
              <button
                type="button"
                onClick={() => void store.recover()}
                className="rounded-full border border-ember/50 bg-ember/10 px-2 py-0.5 text-[8.5px] font-bold text-ember active:bg-ember/20"
                data-testid="sync-retry"
              >
                THỬ LẠI
              </button>
            ) : null}
          </p>
        </div>

        <div className="flex shrink-0 items-start gap-1.5">
          <div className="flex flex-col items-end gap-0.5">
            <div className="flex h-[30px] items-center gap-1.5 rounded-[10px] border border-hair bg-panel px-2.5">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: accent }} aria-hidden />
              <span className="text-[11px] font-bold leading-none text-snow" data-testid="role-tag">
                {ROLE_SHORT[account.role]}
              </span>
            </div>
            {/* The pill is a readout, not a menu — it no longer wears a chevron it
                cannot act on. The caption under it is dropped on the phone that
                already states its identity in full one row below. */}
            {locked || account.role !== 'LOBBY' ? (
              <span className="pr-0.5 text-[8px] font-semibold tracking-[0.08em] text-mute">{ROLE_LABEL[account.role]}</span>
            ) : null}
          </div>
          {/* V3.3 P0: for the organiser, "where are the seats" is a first-class
              destination, not the fourth thing inside a menu. One tap lands on
              the QUẢN TRỊ group with QUẢN LÝ VỊ TRÍ at the top of it.
              Unlike the station-settings gear, this stays available while a
              countdown is locked: a live round is exactly when the supervisor
              needs to read why a seat cannot be freed. */}
          {account.role === 'SUPERVISOR' && (
            <button
              type="button"
              onClick={() => { setSheetTab('admin'); setSheetOpen(true); }}
              className="shrink-0 rounded-[10px] border border-ember/50 bg-ember/10 px-2.5 py-1.5 text-[9px] font-bold tracking-[0.06em] text-ember active:bg-ember/20"
              data-testid="open-seat-management"
            >
              VỊ TRÍ
            </button>
          )}
          {/* V3.4 §1 (UI-08): the station settings entry stays available for the
              organiser while a countdown is locked. The lock exists to stop a
              station phone reading its way into the game — it has no such purpose
              for the supervisor, and hiding it meant ĐIỀU HÀNH, the one screen
              that answers "what is happening right now", could not be opened
              while the clock was running. The VỊ TRÍ button above is unchanged:
              a stuck seat is still one tap away, on its own tab. */}
          {!locked || account.role === 'SUPERVISOR' ? (
            <button
              type="button"
              onClick={() => setSheetOpen(true)}
              aria-label="Cài đặt trạm"
              className="flex h-[30px] w-[30px] items-center justify-center rounded-[10px] border border-hair bg-panel text-snow active:bg-panel2"
              data-testid="open-settings"
            >
              <GearIcon className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </header>

      {locked ? (
        <CountdownScreen
          store={store}
          role={account.role}
          primary={primary}
          countdown={countdown}
          attempts={attempts}
          npc2Stage={npc2Stage}
          alerts={alerts.map((a) => a.text)}
          pending={state.pending}
          verifying={state.verifying}
          error={state.error}
          notice={state.notice}
          status={state.status}
          syncBroken={syncBroken}
          onRetry={() => void store.recover()}
          onOpenBigScreen={() => {
            setBigAuto(false);
            setBigOpen(true);
          }}
        />
      ) : (
        <main className="flex min-h-0 flex-1 flex-col justify-evenly gap-2.5 overflow-y-auto px-3 pb-2">
          {phase === 'ENDED' ? (
            /* The clock and relay are over: the finished state itself is the most
               important fact on screen, so it replaces the idle 05:00 hero entirely.
               The picker stays reachable — the board is open again for the next shift. */
            <EventEndedCard
              rounds={snap.rounds.length}
              successful={snap.rounds.filter((r) => r.result === 'WON').length}
              endedAt={snap.event.event_ended_at ?? snap.server_now_ms}
              onOpenReport={() => { setSheetTab('report'); setSheetOpen(true); }}
              isSupervisor={account.role === 'SUPERVISOR'}
              onOpenNewEvent={() => { setSheetTab('admin'); setSheetOpen(true); }}
            />
          ) : account.role === 'CORRIDOR' ? (
            /* V3.4 Role 02 — the floor-2 station gets its own information
               hierarchy inside the same design system: identity, the incoming
               handoff, one instruction, the shared stepper, the one dominant
               action, and a deliberately compact timer it does not control. */
            <CorridorStage
              store={store}
              snap={snap}
              primary={primary}
              journey={journey}
              teamLine={teamLine}
              handoff={handoff}
              alerts={alerts}
              state={state}
              syncBroken={syncBroken}
              onOpenJourney={() => setJourneyOpen(true)}
            />
          ) : account.role === 'LOBBY' ? (
            /* V3.4 Role 01 — the ground-floor reception screen rebuilt on the
               shared token system: identity, the team in front of you, the timer
               you are waiting for, the route, then the one press. */
            <LobbyStage
              store={store}
              snap={snap}
              phase={phase}
              primary={primary}
              journey={journey}
              teamLine={teamLine}
              attempts={attempts}
              alerts={alerts}
              state={state}
              syncBroken={syncBroken}
              teamName={teamName}
              nameOpen={nameOpen}
              onTeamName={setTeamName}
              onNameOpen={() => {
                setTeamName(round?.team_name ?? '');
                setNameOpen(true);
              }}
              onNameClose={() => {
                setNameOpen(false);
                if (!round) setTeamName('');
              }}
              onOpenJourney={() => setJourneyOpen(true)}
            />
          ) : account.role === 'GATE' && phase === 'EXIT_CONFIRMED' && resetBoard !== null && resultSummary !== null && readiness !== null ? (
            /* V3.4 §8 — NPC 1, Screen B: the post-round physical reset. It replaces
               the generic flow layout for this one phase because the questions on
               this phone are different: which round just ended, what the server
               recorded for it, which of the three areas this station owns, and
               whether the next team may be received yet. No running clock, no
               control the RPC would refuse. */
            <Npc1ResetStage
              store={store}
              snap={snap}
              phase={phase}
              role={account.role}
              primary={primary}
              journey={journey}
              alerts={alerts}
              state={state}
              syncBroken={syncBroken}
              board={resetBoard}
              summary={resultSummary}
              readiness={readiness}
              attempts={attempts}
              teamNumber={round?.team_number ?? null}
              onOpenJourney={() => setJourneyOpen(true)}
              onOpenReport={() => { setSheetTab('report'); setSheetOpen(true); }}
            />
          ) : account.role === 'GATE' && phase === 'READY_AT_FLOOR3' ? (
            /* V3.4 NPC1 §2 — Screen A. The gate operator's pre-start hierarchy:
               identity, the team in front of them, one focused preparation card
               with the configured duration, the shared route, then the single
               dominant START. The old screen repeated the team across three
               panels and floated an oversized block in the middle. */
            <GateStage
              store={store}
              snap={snap}
              phase={phase}
              primary={primary}
              journey={journey}
              teamLine={teamLine}
              alerts={alerts}
              state={state}
              syncBroken={syncBroken}
              onOpenJourney={() => setJourneyOpen(true)}
            />
          ) : (
            <>
          {/* ------------------------------------------------------- team card */}
          <section className="card tm-card" data-testid="active-team">
            <div className="flex items-center justify-between gap-2">
              <h1 className="digital team-digits font-bold text-snow">
                ĐỘI #{pad(round?.team_number ?? snap.event.next_team_number)}
              </h1>
              <TeamNameEditor
                store={store}
                role={account.role}
                round={round}
                // OPERATOR_01's own draft-and-correct rule moved with its screen
                // into LobbyStage; this branch now serves the floor-3 positions and
                // the retained admin, whose permission is unchanged: correct a label
                // only while the team is still being handed over. Once the countdown
                // runs, session data is frozen.
                canRename={
                  round !== null &&
                  account.role === 'SUPERVISOR' &&
                  (phase === 'WAITING_FLOOR2_CONFIRMATION' || phase === 'READY_AT_FLOOR3')
                }
                value={teamName}
                onChange={setTeamName}
                open={nameOpen}
                onOpen={() => {
                  setTeamName(round?.team_name ?? '');
                  setNameOpen(true);
                }}
                onClose={() => {
                  setNameOpen(false);
                  if (!round) setTeamName('');
                }}
                saving={state.pending === 'SET_TEAM_NAME'}
              />
            </div>
            <p
              className="mt-2 flex items-center gap-1.5 text-[13px] font-semibold leading-none"
              data-testid="team-status"
              style={{ color: TEAM_TONE_HEX[teamLine.tone] }}
            >
              <UsersIcon className="h-4 w-4" />
              {teamLine.text}
              {round?.team_name ? <span className="text-mute"> · {round.team_name}</span> : null}
            </p>
            {nameOpen ? null : (
              <p className="mt-1 text-[9.5px] leading-snug text-mute" data-testid="team-identity">
                {teamLabel(round, snap.event.next_team_number)}
              </p>
            )}
          </section>

          {/* ------------------------------------------------- central status block
              Pre-start gets its own illuminated treatment: it is the one waiting
              state where the whole room must know the game is about to begin. */}
          {phase === 'READY_AT_FLOOR3' ? (
            <PreStartAlert
              round={round}
              isNpc1={account.role === 'GATE'}
              label={teamLabel(round, snap.event.next_team_number)}
              durationLabel={formatClockSec(roundLimitMs(round, snap.event.config.game_limit_ms))}
            />
          ) : (
            <section className="hero-block relative isolate flex flex-1 flex-col items-center justify-center py-2" data-testid="hero">
              <span
                className="hero-aura -z-10"
                aria-hidden
                style={{ background: `radial-gradient(ellipse 46% 26% at 50% 50%, ${ACCENT_HEX.slate}18 0%, transparent 70%)` }}
              />
              <p className="flex items-center gap-1.5 text-[9px] font-semibold tracking-[0.16em] text-mute" data-testid="hero-label">
                <ClockIcon className="h-3.5 w-3.5" />
                {phase === 'WAITING_FLOOR2_CONFIRMATION' ? 'CHƯA TÍNH GIỜ — ĐỘI ĐANG LÊN TẦNG 2' : 'CHƯA TÍNH GIỜ'}
              </p>
              <p className="digital hero-digits mt-1 font-bold text-snow/70" data-testid="hero-clock" data-mode="IDLE">
                {formatClockSec(snap.event.config.game_limit_ms)}
              </p>
              <p className="mt-1 text-[10px] leading-snug text-mute" data-testid="hero-note">
                Đồng hồ {formatClockSec(snap.event.config.game_limit_ms)} chỉ chạy khi NPC 1 bấm BẮT ĐẦU
              </p>
            </section>
          )}

          <JourneyStepper journey={journey} onOpen={() => setJourneyOpen(true)} />

          {/* Safety and prize warnings stay on the main screen, never only in the sheet. */}
          {alerts.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => alarms.unlock()}
              className={`rounded-[10px] border px-3 py-1.5 text-left text-[10px] leading-snug ${
                a.tone === 'danger' ? 'border-blood/50 bg-blood/10 text-blood' : 'border-ember/40 bg-ember/10 text-ember'
              }`}
              data-testid={`alert-${a.id}`}
            >
              {a.text}
            </button>
          ))}

          {state.error && (
            <p
              role="status"
              className="rounded-[10px] border border-blood/50 bg-blood/10 px-3 py-2 text-[11px] leading-snug text-blood"
              data-testid="message"
            >
              {state.error}
            </p>
          )}

          <PrimaryZone store={store} primary={primary} pending={state.pending} verifying={state.verifying} draftName={teamName} />

          {phase === 'EXIT_CONFIRMED' ? <AttemptHistory attempts={attempts} /> : null}
            </>
          )}
        </main>
      )}

      {/* ------------------------------------------------------------- footer */}
      {!locked && (
        <footer className="safe-bottom nav-row">
          {account.role === 'CORRIDOR' ? (
            /* V3.4 §9: the floor-2 station has no record to watch mid-handoff —
               ranking and history live in the sheet's BÁO CÁO group now. The two
               secondary destinations are named by what they open, and neither
               competes with the confirmation button above. */
            <>
              <button
                type="button"
                onClick={() => setJourneyOpen(true)}
                className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-[10px] border border-hair bg-panel px-2 text-[10px] font-semibold text-snow active:bg-panel2"
                data-testid="r02-open-map"
              >
                <RunnerIcon className="h-3.5 w-3.5 text-mute" />
                SƠ ĐỒ HÀNH TRÌNH
              </button>
              <button
                type="button"
                onClick={() => { setSheetTab('report'); setSheetOpen(true); }}
                className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-[10px] border border-hair bg-panel px-2 text-[10px] font-semibold text-snow active:bg-panel2"
                data-testid="open-details"
              >
                <BarsIcon className="h-3.5 w-3.5" />
                BÁO CÁO & LỊCH SỬ
                <ChevronRightIcon className="h-3 w-3 text-mute" />
              </button>
            </>
          ) : (
            <>
              {/* V3.4 §7: the footer is navigation, not a second dashboard. The
                  record, the ranking and the round history live in the sheet's
                  BÁO CÁO group now, so the strip names where it goes instead of
                  saying "Xem thêm" about nothing. */}
              <p className="r01-progress" data-testid="summary-line">
                LƯỢT #{pad(snap.event.next_team_number)} · ĐÃ CHƠI {rows.length}
              </p>
              <button
                type="button"
                onClick={() => { setSheetTab('ops'); setSheetOpen(true); }}
                className="btn-quiet shrink-0"
                data-testid="open-details"
              >
                <BarsIcon className="h-3.5 w-3.5" />
                CHI TIẾT & BÁO CÁO
                <ChevronRightIcon className="h-3 w-3" />
              </button>
            </>
          )}
        </footer>
      )}
      {/* Every screen keeps one explicit way back to the picker: a station that walks
          off duty must be able to release its seat without hunting through the sheet. */}
      <ReturnHome onLogout={onLogout} />

      <DetailsSheet
        open={sheetOpen}
        initialTab={sheetTab}
        onClose={() => setSheetOpen(false)}
        store={store}
        account={account}
        now={now}
        onOpenBigScreen={() => {
          setSheetOpen(false);
          setBigAuto(false);
          setBigOpen(true);
        }}
      />
      {journeyOpen && <JourneyBoard journey={journey} onClose={() => setJourneyOpen(false)} />}
      {bigOpen && (
        <BigScreen
          store={store}
          role={account.role}
          autoOpened={bigAuto}
          onClose={() => {
            setBigOpen(false);
            setBigAuto(false);
          }}
        />
      )}
    </div>
  );
}

/* --------------------------------------------------------------- flow screens */

/** Whole-event summary shown in place of the idle clock once the event ended. */
function EventEndedCard({ rounds, successful, endedAt, onOpenReport, isSupervisor, onOpenNewEvent }: {
  rounds: number; successful: number; endedAt: number; onOpenReport(): void;
  /** SUPERVISOR only: hands the room to the next shift by pointing sc.state at a
      fresh sc.events row. Opens the sheet's Quản trị group where the confirm
      input and the actual OPEN_NEW_EVENT press live. */
  isSupervisor?: boolean;
  onOpenNewEvent?(): void;
}) {
  return (
    <section className="ended-card flex w-full flex-col items-center gap-3 px-4 py-8 text-center" data-testid="event-ended-card">
      <span className="flex h-12 w-12 items-center justify-center rounded-full border border-jade/50 bg-jade/10">
        <CheckIcon className="h-6 w-6 text-jade" />
      </span>
      <p className="text-[1.05rem] font-extrabold tracking-[0.06em] text-snow">SỰ KIỆN ĐÃ KẾT THÚC</p>
      <p className="text-[0.72rem] leading-snug text-mute" data-testid="event-ended-summary">
        {rounds} lượt · {successful} đội thành công · đóng lúc {formatWallTime(endedAt)}
      </p>
      {isSupervisor && onOpenNewEvent ? (
        <button
          type="button"
          onClick={onOpenNewEvent}
          className="w-full rounded-panel border border-jade/60 bg-jade/10 px-4 py-3.5 text-[0.82rem] font-bold text-jade active:bg-jade/20"
          data-testid="open-new-event"
        >
          MỞ SỰ KIỆN MỚI
        </button>
      ) : null}
      <button
        type="button"
        onClick={onOpenReport}
        className="w-full rounded-panel border border-hair bg-panel px-4 py-3.5 text-[0.78rem] font-semibold text-snow active:bg-panel2"
        data-testid="open-report"
      >
        XEM BÁO CÁO & LỊCH SỬ
      </button>
      <p className="text-[0.66rem] leading-snug text-mute" data-testid="ended-board-note">
        {isSupervisor
          ? 'Bấm MỞ SỰ KIỆN MỚI để bàn giao phòng cho ca tiếp theo. Lịch sử sự kiện vừa rồi được giữ nguyên.'
          : 'Bảng vị trí vẫn mở. Chờ Quản trị viên mở sự kiện mới để ca tiếp theo bắt đầu.'}
      </p>
    </section>
  );
}

/**
 * PHASE 01 — the ground-floor reception screen (V3.4 Role 01 redesign).
 *
 * The order is the order of the decision an operator has to make, and nothing
 * in it is decorative:
 *
 *   1. who this phone is, and whether the phone can be trusted right now
 *   2. which team is standing in front of them — received, or only queued
 *   3. the round duration they are waiting for, kept small while it is idle
 *   4. the five-stage route, so the hand is visible without asking
 *   5. the one press that moves the team
 *   6. named secondary destinations, never competing with the press
 *
 * Every value is read from the authoritative snapshot through the same selectors
 * the other phones use: the screen never advances a team locally, never invents a
 * countdown and never shows a control the server would refuse. A placeholder team
 * number is drawn as a queue position, not as a received team.
 */
function LobbyStage({ store, snap, phase, primary, journey, teamLine, attempts, alerts, state, syncBroken, teamName, nameOpen, onTeamName, onNameOpen, onNameClose, onOpenJourney }: {
  store: LiveStore;
  snap: NonNullable<ReturnType<LiveStore['getSnapshot']>['snapshot']>;
  phase: SystemPhase;
  primary: PrimaryAction;
  journey: JourneyInfo;
  teamLine: TeamLine;
  attempts: AttemptRow[];
  alerts: AlertInfo[];
  state: StoreState;
  syncBroken: boolean;
  teamName: string;
  nameOpen: boolean;
  onTeamName(value: string): void;
  onNameOpen(): void;
  onNameClose(): void;
  onOpenJourney(): void;
}) {
  const round = snap.active_round;
  const received = round !== null;
  const limitLabel = formatClockSec(roundLimitMs(round, snap.event.config.game_limit_ms));
  const accent = ACCENT_HEX[ROLE_ACCENT.LOBBY];
  // OPERATOR_01 may draft a label before the team exists — it then travels with
  // the reception press — and may correct it while the team is still being handed
  // over. Once the countdown runs, session data is frozen. Same permission, same
  // phases as before the redesign; only the placement changed.
  const canRename = received
    ? phase === 'WAITING_FLOOR2_CONFIRMATION' || phase === 'READY_AT_FLOOR3'
    : primary.action === 'CALL_TEAM';
  const turn = journey.turn;
  const badge = syncBroken
    ? { text: 'KHÔNG ĐỌC ĐƯỢC MÁY CHỦ', tone: 'danger' as const }
    : received
      ? { text: 'ĐÃ NHẬN ĐỘI', tone: 'confirmed' as const }
      : { text: 'CHỜ NHẬN ĐỘI', tone: 'queued' as const };
  // The card's headline has to state which of the three things is actually true:
  // a team nobody has received yet, a team this phone received and handed up, and
  // a team whose clock is really running. Calling a received-but-unstarted team
  // “ĐANG CHƠI” told the operator the round had begun when the machine says it has
  // not, and the badge underneath then contradicted the headline.
  const stageWord = !received
    ? 'ĐỘI KẾ TIẾP'
    : round.game_started_at !== null
      ? 'ĐỘI ĐANG CHƠI'
      : 'ĐỘI VỪA NHẬN';
  // The idle clock never repeats what the card already says: one short label,
  // one duration, and one sentence about why the number is not moving.
  const idleCaption = syncBroken
    ? 'Không đọc được máy chủ — kiểm tra Wi-Fi rồi bấm THỬ LẠI ở đầu màn hình.'
    : phase === 'WAITING_FLOOR2_CONFIRMATION'
      ? 'Đội đang lên tầng 2 · đồng hồ chỉ chạy khi NPC 1 bấm BẮT ĐẦU'
      : `Đồng hồ ${limitLabel} chỉ chạy khi NPC 1 bấm BẮT ĐẦU`;
  // In pre-start the illuminated card under the team IS the phase statement, so
  // neither the card's own state line nor the warning banner repeats it — the
  // same rule NPC 1's screen applies, and the reason this screen previously read
  // the same sentence five times inside one viewport.
  const preStartShown = phase === 'READY_AT_FLOOR3';
  const shownAlerts = alerts.filter((a) => !(a.id === 'PRESTART' && preStartShown));

  return (
    // Spare height is spread across the column gaps instead of pooled into one
    // empty band, which is the recorded layout decision for this dashboard: a
    // single flex-1 spacer pushed the press to the very bottom and left a void
    // between the route and the action. The press keeps its own group so
    // justification can never separate a button from its hint or its warnings.
    // `min-height` is deliberately NOT zeroed here: with a content floor removed,
    // flex squeezes the cards below their own height whenever the column is taller
    // than the viewport — measured at 320×640, the team card collapsed to 26 px
    // while holding 164 px of text, so `.tm-card { overflow: hidden }` cut the
    // Vietnamese lines off. The floor keeps every card readable and lets <main>
    // scroll instead.
    <div className="mx-auto flex w-full max-w-[560px] flex-1 flex-col justify-evenly gap-3">
      {/* -------------------------------------------------------- identity */}
      <section
        className="role-band"
        style={{ '--role-accent': accent } as CSSProperties}
        data-testid="r01-identity"
        data-sync={syncBroken ? 'broken' : 'live'}
      >
        <div className="min-w-0 flex-1">
          <p className="role-band-name" data-testid="r01-role">{ROLE_PERSON.LOBBY}</p>
          <p className="role-band-area">{ROLE_AREA.LOBBY}</p>
          <p className="mt-0.5 text-[9.5px] leading-snug text-mute">{ROLE_DUTY.LOBBY}</p>
        </div>
        {/* The band answers "am I holding this seat" — the one of the four states
            the rest of the screen never states. What the event and the team are
            doing is read from the card and the route, where it belongs. */}
        {/* The binding badge states one fact and one only: this phone holds the
            seat. A read failure does not release it, so the tone must not turn
            blood-red under words that are still true — the transport truth is
            already said in words by the header chip and the workflow badge. */}
        <span className="badge" data-tone="confirmed" data-testid="binding-state">
          <CheckIcon />
          ĐÃ GẮN VỊ TRÍ
        </span>
      </section>

      {/* ------------------------------------------------------- team card */}
      <section
        className={`card tm-card ${received ? 'is-received' : 'is-upcoming'}`}
        data-testid="active-team"
        data-received={received ? '1' : '0'}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="team-eyebrow" data-testid="r01-team-stage">{stageWord}</p>
            <h1 className="digital team-digits mt-1 font-bold text-snow">
              #{pad(round?.team_number ?? snap.event.next_team_number)}
            </h1>
          </div>
          <span className="badge" data-tone={badge.tone} data-testid="r01-team-badge">
            {received ? <CheckIcon /> : <ClockIcon />}
            {badge.text}
          </span>
          <TeamNameEditor
            store={store}
            role="LOBBY"
            round={round}
            canRename={canRename}
            value={teamName}
            onChange={onTeamName}
            open={nameOpen}
            onOpen={onNameOpen}
            onClose={onNameClose}
            saving={state.pending === 'SET_TEAM_NAME'}
          />
        </div>

        <p
          className="team-status mt-2"
          data-testid="team-status"
          style={{ color: TEAM_TONE_HEX[syncBroken ? 'red' : teamLine.tone] }}
        >
          <UsersIcon className="h-4 w-4 shrink-0" />
          <span className="min-w-0">
            {teamLine.text}
            {round?.team_name ? <span className="text-mute"> · {round.team_name}</span> : null}
          </span>
        </p>

        {nameOpen ? null : (
          <p className="hero-caption mt-1.5" data-testid="team-identity">
            {received
              ? `${teamLabel(round, snap.event.next_team_number)} · đã nhận lúc ${formatWallTime(round.called_at)}`
              : `Chưa tiếp nhận — đội kế tiếp sẽ là ${teamLabel(null, snap.event.next_team_number)}`}
          </p>
        )}

        {/* Where the round stands, in the machine's own words, and whose hand it
            is in. One line — the button underneath already says what to do. */}
        <p className="r01-hand" data-testid="event-state">
          {!preStartShown && <span className="r01-hand-state">{PHASE_LABEL[phase] ?? 'CHỜ ĐỒNG BỘ'}</span>}
          {turn ? (
            <span className="r01-hand-who" data-testid="r01-hand" data-mine={turn.mine ? '1' : '0'}>
              {turn.mine ? 'ĐẾN LƯỢT BẠN' : `CHỜ ${turn.roles.map((r) => ROLE_SHORT[r]).join(' · ')}`}
            </span>
          ) : null}
        </p>
      </section>

      {/* ------------------------------------------------- context timer */}
      {phase === 'READY_AT_FLOOR3' ? (
        <PreStartAlert
          round={round}
          isNpc1={false}
          label={teamLabel(round, snap.event.next_team_number)}
          durationLabel={limitLabel}
        />
      ) : (
        <section className="hero-block" data-testid="hero">
          <div className="flex w-full items-baseline justify-between gap-2">
            <p className="team-eyebrow flex items-center gap-1.5" data-testid="hero-label">
              <ClockIcon className="h-3.5 w-3.5" />
              CHƯA TÍNH GIỜ
            </p>
            <p className="digital hero-digits font-bold" data-testid="hero-clock" data-mode="IDLE">
              {limitLabel}
            </p>
          </div>
          <p className="hero-caption mt-1" data-testid="hero-note">
            {idleCaption}
          </p>
        </section>
      )}

      {/* --------------------------------------------------------- route */}
      <JourneyStepper journey={journey} onOpen={onOpenJourney} />

      {/* One group, so the distribution above can never drive a wedge between the
          press and the warnings, the acknowledgement or the hint that explain it. */}
      <div className="flex flex-col gap-2.5" data-testid="r01-action-group">
        {/* Safety and prize warnings stay on the main screen, never only in the sheet. */}
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
            <span>{state.notice}</span>
          </p>
        ) : null}

        {/* ------------------------------------------------- the one press */}
        <PrimaryZone store={store} primary={primary} pending={state.pending} verifying={state.verifying} draftName={teamName} />

        {phase === 'EXIT_CONFIRMED' ? <AttemptHistory attempts={attempts} /> : null}
      </div>
    </div>
  );
}

/**
 * PHASE 02 — the floor-2 station screen (V3.4 Role 02 redesign).
 *
 * The same design system as NHÂN SỰ 01 — role band, team card, badges, notice
 * bands, the shared five-stop tracker, one dominant press — in the floor-2
 * order of decisions: who this phone is, which team is arriving, what the
 * operator must do, where the route stands, the one confirmation. The 05:00
 * this role never starts is demoted to the compact idle row the lobby uses.
 * Every state comes from `resolveHandoff` (server timestamps only): the screen
 * never implies an arrival the database has not recorded, and a real sync
 * failure always outranks the workflow badge so no press is offered into an
 * unread state.
 */
function CorridorStage({ store, snap, primary, journey, teamLine, handoff, alerts, state, syncBroken, onOpenJourney }: {
  store: LiveStore;
  snap: NonNullable<ReturnType<LiveStore['getSnapshot']>['snapshot']>;
  primary: PrimaryAction;
  journey: JourneyInfo;
  teamLine: TeamLine;
  handoff: HandoffInfo;
  alerts: AlertInfo[];
  state: StoreState;
  syncBroken: boolean;
  onOpenJourney(): void;
}) {
  const round = snap.active_round;
  const limitLabel = formatClockSec(roundLimitMs(round, snap.event.config.game_limit_ms));
  const accent = ACCENT_HEX[ROLE_ACCENT.CORRIDOR];
  const turn = journey.turn;
  // The words come from the server-derived handoff state; the tone and the
  // silhouette are the shared badge vocabulary — five honest states, and an
  // unread machine outranks every one of them.
  const badge = syncBroken
    ? { tone: 'danger' as const, Icon: AlertIcon, text: 'KHÔNG ĐỌC ĐƯỢC MÁY CHỦ' }
    : handoff.key === 'confirmed'
      ? { tone: 'confirmed' as const, Icon: CheckIcon, text: handoff.badge }
      : handoff.key === 'incoming'
        ? { tone: 'live' as const, Icon: ArrowUpIcon, text: handoff.badge }
        : handoff.key === 'bypassed'
          ? { tone: 'live' as const, Icon: AlertIcon, text: handoff.badge }
          : { tone: 'queued' as const, Icon: ClockIcon, text: handoff.badge };
  const BadgeIcon = badge.Icon;
  const instruction = syncBroken
    ? 'Không thể xác nhận khi máy chưa đọc được trạng thái mới — kiểm tra Wi-Fi rồi bấm THỬ LẠI ở đầu màn hình.'
    : handoff.key === 'incoming'
      ? 'Theo dõi lối lên tầng 2. Chỉ bấm xác nhận khi đội đã có mặt thật ở đây.'
      : handoff.key === 'confirmed'
        ? 'Đội đã được xác nhận — NPC 1 phổ biến luật và mở đồng hồ ở cửa tầng 3.'
        : handoff.key === 'bypassed'
          ? 'NPC 1 đã bỏ qua tầng 2 có ghi nhật ký. Không cần thao tác ở đây.'
          : handoff.key === 'waiting-next'
            ? 'Đang chờ bước tiếp theo từ máy chủ.'
            : 'Chưa có đội bàn giao. Khi Nhân sự 01 gửi đội lên, nút xác nhận sẽ hiển thị ở đây.';
  const timerEyebrow = 'CHƯA TÍNH GIỜ';
  // The bypass alert would repeat the bypass instruction one screen apart, and the
  // pre-start band would repeat the route caption under the tracker. This screen
  // states each fact once: the card says whose hand it is, the caption says where
  // the team is, the summary says what the server recorded.
  const confirmed = !syncBroken && handoff.key === 'confirmed' && round?.floor2_confirmed_at != null;
  const shownAlerts = alerts.filter((a) => !(a.id === 'BYPASS' && handoff.key === 'bypassed')
    && !(a.id === 'PRESTART' && handoff.key === 'confirmed'));
  // "Being handed over through floor 2" is only true until this phone's press
  // lands. After the stamp the team is on floor 3, and saying otherwise would
  // leave the headline contradicting the summary underneath it.
  const stageWord = !round
    ? 'ĐỘI KẾ TIẾP'
    : handoff.key === 'bypassed'
      ? 'ĐỘI ĐÃ LÊN TẦNG 3'
      : handoff.key === 'confirmed'
        ? 'ĐỘI ĐÃ GỬI LÊN TẦNG 3'
        : 'ĐỘI ĐANG BÀN GIAO QUA TẦNG 2';
  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-1 flex-col gap-2.5">
      {/* -------------------------------------------------------- identity */}
      <section
        className="role-band"
        style={{ '--role-accent': accent } as CSSProperties}
        data-testid="r02-identity"
        data-sync={syncBroken ? 'broken' : 'live'}
      >
        <div className="min-w-0 flex-1">
          <p className="role-band-name" data-testid="r02-role">{ROLE_PERSON.CORRIDOR}</p>
          <p className="role-band-area">{ROLE_AREA.CORRIDOR}</p>
          <p className="mt-0.5 text-[9.5px] leading-snug text-mute">{ROLE_DUTY.CORRIDOR}</p>
        </div>
        <span className="badge" data-tone="confirmed" data-testid="r02-binding-state">
          <CheckIcon />
          ĐÃ GẮN VỊ TRÍ
        </span>
      </section>

      {/* ------------------------------------------------------ handoff card */}
      <section
        className={`card tm-card ${round ? 'is-received' : 'is-upcoming'}`}
        data-testid="active-team"
        data-received={round ? '1' : '0'}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="team-eyebrow" data-testid="r02-team-stage">{stageWord}</p>
            <h1 className="digital team-digits mt-1 font-bold text-snow">
              #{pad(round?.team_number ?? snap.event.next_team_number)}
            </h1>
          </div>
          <span
            className="badge"
            data-tone={badge.tone}
            data-testid="r02-handoff-badge"
            data-state={syncBroken ? 'error' : handoff.key}
          >
            <BadgeIcon />
            {badge.text}
          </span>
        </div>

        <p
          className="team-status mt-2"
          data-testid="team-status"
          style={{ color: TEAM_TONE_HEX[syncBroken ? 'red' : teamLine.tone] }}
        >
          <UsersIcon className="h-4 w-4 shrink-0" />
          <span className="min-w-0">
            {teamLine.text}
            {round?.team_name ? <span className="text-mute"> · {round.team_name}</span> : null}
          </span>
        </p>

        {!confirmed && (
          <p className="hero-caption mt-1.5" data-testid="r02-requirement">
            {syncBroken
              ? 'Máy chưa đọc được trạng thái mới — kiểm tra kết nối rồi xác nhận bước tiếp theo.'
              : handoff.requirement}
          </p>
        )}

        {/* Whose hand the round is in — the next required action, from the same
            authoritative timestamps the buttons themselves are derived from. */}
        {turn ? (
          <p className="r01-hand" data-testid="r02-hand" data-mine={turn.mine ? '1' : '0'}>
            <span className="r01-hand-who">
              {turn.mine ? 'ĐẾN LƯỢT BẠN' : `CHỜ ${turn.roles.map((r) => ROLE_SHORT[r]).join(' · ')}`}
            </span>
            {!turn.mine ? <span className="r01-hand-what">{turn.label}</span> : null}
          </p>
        ) : null}

        {/* The arrival CTA is gone once the server has the stamp — replaced by the
            same fact as a read-only summary in the place the thumb already knows.
            The acknowledgement is keyed on `floor2_confirmed_at`, never on this
            phone's own press, so a write that is still on the wire reads pending. */}
      </section>

      {/* ----------------------------------------------------- instruction */}
      {!confirmed && (
        <section className="r02-instruct" data-testid="r02-instruction">
          <p>{instruction}</p>
        </section>
      )}

      {/* --------------------------------------------------------- route */}
      <JourneyStepper journey={journey} onOpen={onOpenJourney} />

      {/* Safety and prize warnings stay on the main screen, never only in the sheet. */}
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
          <span>{state.notice}</span>
        </p>
      ) : null}

      {/* ------------------------------------------------- the one press */}
      {confirmed ? (
        // Non-interactive, and in the slot the arrival button used to hold: the
        // operator looks at the same place and now reads what the server recorded
        // plus who owns the next step, instead of a control that can only refuse.
        <section className="state-block" data-tone="confirmed" role="status" data-testid="r02-handoff-summary">
          <span className="state-block-icon" aria-hidden><CheckIcon /></span>
          <p className="state-block-title" data-testid="r02-confirmed">ĐÃ XÁC NHẬN ĐỘI ĐẾN TẦNG 2</p>
          <p className="state-block-note" data-testid="r02-waiting-npc1">ĐANG CHỜ NPC 1 BẮT ĐẦU</p>
          <p className="text-[0.62rem] leading-snug text-mute" data-testid="r02-confirmed-at">
            Máy chủ ghi nhận lúc {formatWallTime(round?.floor2_confirmed_at ?? snap.server_now_ms)} · đội #{pad(round?.team_number ?? snap.event.next_team_number)}
            {round?.team_name ? ` · ${round.team_name}` : ''}
          </p>
        </section>
      ) : (
        <PrimaryZone store={store} primary={primary} pending={state.pending} verifying={state.verifying} draftName="" />
      )}

      {/* ------------------------------------- compact, view-only clock info */}
      <section className="hero-block" data-testid="r02-timer-info">
        <div className="flex w-full items-baseline justify-between gap-2">
          <p className="team-eyebrow flex items-center gap-1.5" data-testid="r02-timer-label">
            <ClockIcon className="h-3.5 w-3.5" />
            {timerEyebrow}
          </p>
          <p className="digital hero-digits font-bold" data-testid="r02-timer-value">{limitLabel}</p>
        </div>
        <p className="hero-caption mt-1" data-testid="r02-timer-note">
          {limitLabel} là thời lượng lượt chơi · NPC 1 bấm BẮT ĐẦU để mở đồng hồ
        </p>
      </section>

      <div className="sc-spacer" />
    </div>
  );
}

function ReturnHome({ onLogout }: { onLogout(): Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const leave = async () => {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      await onLogout();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="px-3 pb-1.5 text-center">
      {/* V3.4 §7: leaving a seat is a real destination, so it stays one tap away on
          every screen — but it is a text link now, not a second filled button
          competing with the action above it. The hit area is still 44 px. */}
      <button
        type="button"
        onClick={() => void leave()}
        disabled={busy}
        className="nav-link w-full"
        data-testid="return-home"
      >
        {busy ? 'ĐANG NHẢ VỊ TRÍ…' : 'VỀ MÀN HÌNH CHỌN VỊ TRÍ'}
      </button>
      {error ? (
        <p role="alert" className="mt-1 text-[11px] text-ember" data-testid="release-error">
          Chưa nhả được vị trí. Kiểm tra kết nối và bấm lại.
        </p>
      ) : null}
    </div>
  );
}

interface NameProps {
  store: LiveStore;
  role: Role;
  round: Round | null;
  canRename: boolean;
  value: string;
  onChange(value: string): void;
  open: boolean;
  onOpen(): void;
  onClose(): void;
  saving: boolean;
}

/** The optional label travels with the reception press, or edits the team on the floor. */
function TeamNameEditor({ store, round, canRename, value, onChange, open, onOpen, onClose, saving }: NameProps) {
  const dirty = cleanTeamName(value) !== (round?.team_name ?? '');
  const save = async () => {
    if (!canRename || saving) return;
    if (!round) {
      // No round yet: the draft stays on this phone and is sent with CALL_TEAM.
      onClose();
      return;
    }
    const result = await store.act('SET_TEAM_NAME', { team_name: cleanTeamName(value) });
    if (result?.ok) onClose();
  };
  return (
    <>
      <button
        type="button"
        onClick={open ? onClose : onOpen}
        disabled={!canRename}
        aria-label="Đặt tên đội"
        aria-expanded={open}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border border-hair bg-panel2 text-mute active:text-snow disabled:opacity-40"
        data-testid="team-edit"
      >
        <PencilIcon className="h-3.5 w-3.5" />
      </button>
      {open && canRename && (
        <div className="mt-2 w-full">
          <div className="flex items-center gap-2">
            <input
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void save();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  onClose();
                }
              }}
              placeholder="Tên đội (tuỳ chọn)"
              maxLength={TEAM_NAME_MAX}
              autoFocus
              disabled={saving}
              className="h-8 min-w-0 flex-1 rounded-[8px] border border-hair bg-panel2 px-2.5 text-[12px] text-snow outline-none focus:border-blood disabled:opacity-60"
              data-testid="team-name"
            />
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || (round !== null && !dirty)}
              className="flex h-8 shrink-0 items-center justify-center rounded-[8px] border border-blood/60 bg-blood/10 px-2.5 text-[10px] font-bold text-blood disabled:opacity-40"
              data-testid="team-name-save"
            >
              {saving ? 'ĐANG LƯU' : round ? 'LƯU' : 'XONG'}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="flex h-8 shrink-0 items-center justify-center rounded-[8px] border border-hair px-2.5 text-[10px] font-semibold text-mute disabled:opacity-40"
              data-testid="team-name-cancel"
            >
              HỦY
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * PHASE 03 — the pre-start alert. Deliberately the loudest waiting state in the app:
 * amber illumination and a slow breathing glow, so every floor knows the countdown is
 * one press away without anything flashing in their face.
 *
 * V3.4 §4: it no longer stretches to fill the viewport. The duration the round will
 * run is the fact, so it sits at the top of the band as a number; everything else is
 * one line each. The space below belongs to the route and the press.
 */
function PreStartAlert({ round, isNpc1, label, durationLabel }: { round: Round | null; isNpc1: boolean; label: string; durationLabel: string }) {
  return (
    <section className="prestart-block px-3 py-3" data-testid="prestart-alert">
      <div className="flex items-baseline justify-between gap-2">
        <p className="prestart-eyebrow">ĐỘI CHƠI SẮP BẮT ĐẦU</p>
        <p className="digital prestart-clock" data-testid="prestart-duration">
          {durationLabel}
        </p>
      </div>
      <p className="digital prestart-team" data-testid="prestart-team">
        {label.toUpperCase()}
      </p>
      <p className="prestart-hint" data-testid="prestart-hint">
        {isNpc1 ? 'Kiểm tra đội có mặt, phổ biến luật và đưa gợi ý' : 'NPC 1 đang phổ biến luật ở cửa vào tầng 3'}
      </p>
      <p className="prestart-meta">
        <ClockIcon className="h-3.5 w-3.5" />
        Đồng hồ {durationLabel} sẽ chạy khi NPC 1 bấm BẮT ĐẦU
      </p>
      {round?.floor2_bypassed_at !== null && round?.floor2_bypassed_at !== undefined ? (
        <p className="prestart-hint" data-testid="prestart-bypassed">
          Tầng 2 đã được bỏ qua có ghi nhật ký
        </p>
      ) : null}
    </section>
  );
}

/**
 * V3.4 §2 — the one focused preparation card (NPC 1's Screen A core).
 *
 * Team identity, the briefing steps the existing workflow already performs
 * (the words come from the current START hint and NPC 1's duty — nothing new
 * is mandated and no backend state is invented), and the duration this round
 * will snapshot at the press. It replaces the old pattern where the team
 * number, the preparation status and the duration each occupied their own
 * large panel. The card keeps the `prestart-alert` testid because it *is*
 * the alert now: the loudest fact on the screen is the one it always was.
 */
function PreStartCard({ round, isNpc1, label, durationLabel, teamLine }: {
  round: Round | null;
  isNpc1: boolean;
  label: string;
  durationLabel: string;
  teamLine: TeamLine;
}) {
  return (
    <section className="prestart-block px-4 py-3.5" data-testid="prestart-alert">
      <p className="prestart-eyebrow text-amber">CHUẨN BỊ BẮT ĐẦU · CỬA VÀO TẦNG 3</p>
      <div className="mt-1.5">
        <h1 className="digital team-digits font-bold text-snow" data-testid="prestart-team">
          {label.toUpperCase()}
        </h1>
        <p className="team-status mt-2" data-testid="team-status" style={{ color: TEAM_TONE_HEX[teamLine.tone] }}>
          <UsersIcon className="h-4 w-4 shrink-0" />
          <span className="min-w-0">
            {teamLine.text}
            {round?.team_name ? <span className="text-mute"> · {round.team_name}</span> : null}
          </span>
        </p>
      </div>
      {isNpc1 ? (
        <ul className="prestart-steps mt-3" data-testid="prestart-checklist">
          <li className="prestart-step">Xác nhận đội đã có mặt</li>
          <li className="prestart-step">Phổ biến luật chơi</li>
          <li className="prestart-step">Đưa gợi ý theo quy trình hiện hành</li>
        </ul>
      ) : (
        <p className="prestart-hint mt-3" data-testid="prestart-hint">
          NPC 1 đang phổ biến luật ở cửa vào tầng 3 — chỉ NPC 1 bấm BẮT ĐẦU
        </p>
      )}
      <p className="prestart-duration mt-3" data-testid="prestart-duration">
        <span className="prestart-eyebrow">THỜI LƯỢNG LƯỢT</span>
        <span className="digital text-[17px] font-bold text-amber">{durationLabel}</span>
      </p>
      {round?.floor2_bypassed_at !== null && round?.floor2_bypassed_at !== undefined ? (
        <p className="prestart-meta mt-1.5" data-testid="prestart-bypassed">
          Tầng 2 đã được bỏ qua có ghi nhật ký
        </p>
      ) : null}
    </section>
  );
}

/**
 * PHASE 03 — NPC 1's pre-start screen (V3.4 Screen A). Same design system as
 * NHÂN SỰ 01/02: identity band, the preparation card, the shared five-stop
 * tracker, then the single dominant START press. START keeps every existing
 * prerequisite — the action is offered only while the server says
 * READY_AT_FLOOR3, only to GATE, and the duration shown is the one the round
 * snapshots at the press.
 */
function GateStage({ store, snap, phase, primary, journey, teamLine, alerts, state, syncBroken, onOpenJourney }: {
  store: LiveStore;
  snap: NonNullable<ReturnType<LiveStore['getSnapshot']>['snapshot']>;
  phase: SystemPhase;
  primary: PrimaryAction;
  journey: JourneyInfo;
  teamLine: TeamLine;
  alerts: AlertInfo[];
  state: StoreState;
  syncBroken: boolean;
  onOpenJourney(): void;
}) {
  const round = snap.active_round;
  const limitLabel = formatClockSec(roundLimitMs(round, snap.event.config.game_limit_ms));
  // The preparation card is the pre-start alert; a banner repeating it under
  // the tracker would be the old screen's duplication again.
  const shownAlerts = alerts.filter((a) => a.id !== 'PRESTART');
  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-1 flex-col gap-2.5">
      {/* ------------------------------------------------------------ identity */}
      <section
        className="role-band"
        style={{ '--role-accent': ACCENT_HEX[ROLE_ACCENT.GATE] } as CSSProperties}
        data-testid="gate-identity"
        data-sync={syncBroken ? 'broken' : 'live'}
      >
        <div className="min-w-0 flex-1">
          <p className="role-band-name" data-testid="gate-role">{ROLE_PERSON.GATE}</p>
          <p className="role-band-area">{ROLE_AREA.GATE}</p>
          <p className="mt-0.5 text-[9.5px] leading-snug text-mute">{ROLE_DUTY.GATE}</p>
        </div>
        <p className="role-band-state" data-testid="event-state" data-broken={syncBroken ? '1' : '0'}>
          {syncBroken ? 'KHÔNG ĐỌC ĐƯỢC MÁY CHỦ' : PHASE_LABEL[phase] ?? 'CHỜ ĐỒNG BỘ'}
        </p>
      </section>

      {/* ------------------------------------------------- preparation, one card */}
      <PreStartCard
        round={round}
        isNpc1
        label={teamLabel(round, snap.event.next_team_number)}
        durationLabel={limitLabel}
        teamLine={teamLine}
      />

      {/* ---------------------------------------------------- operational route */}
      <JourneyStepper journey={journey} onOpen={onOpenJourney} />

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
          <span>{state.notice}</span>
        </p>
      ) : null}

      {/* --------------------------------------------------- the one START press */}
      <PrimaryZone store={store} primary={primary} pending={state.pending} verifying={state.verifying} draftName="" />

      <div className="sc-spacer" />
    </div>
  );
}

/* ----------------------------------------------------------- locked countdown */

interface CountdownProps {
  store: LiveStore;
  role: Role;
  primary: PrimaryAction;
  countdown: ReturnType<typeof resolveCountdown>;
  attempts: AttemptRow[];
  /** V3.4 §2: NPC2's eligibility, derived from the authoritative state. */
  npc2Stage: Npc2Stage;
  alerts: string[];
  pending: string | null;
  verifying: string | null;
  error: string | null;
  notice: string | null;
  /** Transport truth for the sync banner: a lost connection is never shown
      as a successfully synchronised clock (V3.4 §7). */
  status: StoreState['status'];
  syncBroken: boolean;
  onRetry(): void;
  onOpenBigScreen(): void;
}

/**
 * PHASE 04 — the countdown-focused screen every role is switched to when NPC1
 * presses START. It is a functional lock, not an overlay: the navigation, the
 * journey editor, the previous phase buttons and the ranking are simply not
 * rendered, and only the explicitly allowed in-game controls are.
 *
 * V3.4 §3 — a mission-critical event timer: the digits own the centre, the
 * tone comes from the shared countdown design system (the same decision the
 * wall display makes), the hundredths read as a fraction of the second, and
 * the meter under the clock is the authoritative remaining share of this
 * round's own duration. No card, ranking or secondary navigation competes.
 */
function CountdownScreen({ store, role, primary, countdown, attempts, npc2Stage, alerts, pending, verifying, error, notice, status, syncBroken, onRetry, onOpenBigScreen }: CountdownProps) {
  const snap = store.getSnapshot().snapshot;
  // The emergency path is derived from the same authoritative snapshot the parent
  // renders from, so it can never offer a control the server would refuse.
  const emergency = snap ? resolveEmergency(role, snap, store.serverNow()) : null;
  const busy = pending !== null || verifying !== null;
  // V3.4: one tone decision shared with the wall — ember while it runs, hot
  // amber inside the configured warning window, blood once the deadline has
  // passed, bone-amber when the server has frozen the result. Never green.
  const stageInput = countdownStageOf(countdown);
  const stage = countdownStage(stageInput);
  const tone = countdownToneHex(stage);
  // The meter is decoration derived from real data: the stored deadline's own
  // remaining share of the round's snapshotted duration. It never runs ahead
  // of, or behind, the authoritative clock.
  const live = countdown.mode === 'GAME' && !countdown.expired;
  const remainingShare = live ? Math.max(0, Math.min(1, countdown.remainingMs / countdown.durationMs)) : 0;
  const showAttempts = role === 'ROOM305' || attempts.some((a) => a.status !== 'PENDING');
  // V3.4 §9: the NPC2 verification surface and the NPC1 exit hand-off carry a
  // real bottom band, so the digits stop stretching to fill a whole empty
  // viewport between them — the clock stays dominant without the dead air.
  const dense = role === 'ROOM305' || (role === 'GATE' && primary.action === 'CONFIRM_EXIT');
  // V3.4 §6: on the phone that owns the decision, the milestone card IS the
  // statement — team, official time and who holds the next step, all from the
  // stored result. The hero keeps the frozen number itself (the contract the
  // workflow suite pins), but the screen stops repeating the same fact in three
  // more places under it.
  const npc2Sealed = role === 'ROOM305' && npc2Stage.finalized;

  return (
    <main
      className="relative flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto px-3 pb-2"
      data-testid="countdown-screen"
      data-tone={countdown.tone}
      data-stage={stage}
      data-layout={dense ? 'dense' : 'hero'}
      style={{ color: tone }}
    >
      {/* A soft radial behind the digits that reads as lantern light spilling
          across the room. currentColor is inherited from the parent's inline
          style, so the halo shifts with the tone. */}
      <div className="countdown-screen-stage" aria-hidden />
      <div className="flex w-full items-center justify-between gap-2 px-1 pt-1">
        <p className="countdown-eyebrow" data-testid="countdown-label">
          {countdown.heroLabel}
        </p>
        <button
          type="button"
          onClick={onOpenBigScreen}
          className="shrink-0 rounded-[8px] border border-hair bg-panel px-2.5 py-1.5 text-[9px] font-semibold text-mute active:text-snow"
          data-testid="countdown-big"
        >
          MÀN HÌNH LỚN
        </button>
      </div>

      {/* MM:SS owns the screen. The hundredths sit on the clock as its own
          smaller fraction — `.61`, decimal included — never as a stray
          number beside it. One component for phone, wall and result. */}
      <div className="countdown-hero flex flex-1 flex-col items-center justify-center gap-2 py-1" data-testid="countdown-hero">
        <TimeDigits mm={countdown.mm} ss={countdown.ss} cs={countdown.cs} stage={stageInput} mode={countdown.mode} variant="phone" />
        {/* The bar is the remaining share of a clock that is still running. Under
            a frozen official number it would read as "time ran out", which is a
            different fact — and for a win, a wrong one. */}
        {countdown.mode === 'GAME' && (
          <div className="clock-meter" data-testid="countdown-meter" aria-hidden>
            <span style={{ width: `${(remainingShare * 100).toFixed(2)}%` }} />
          </div>
        )}
        {!npc2Sealed && (
          <p className="countdown-team" data-testid="countdown-team">
            {countdown.teamText.toUpperCase()}
          </p>
        )}
        {!npc2Sealed && (
          <p
            className="countdown-status"
            style={{ color: tone }}
            data-testid="countdown-status"
          >
            {countdown.statusLine}
          </p>
        )}
        {countdown.officialMs !== null && countdown.result === 'WON' && !(role === 'ROOM305' && npc2Stage.finalized) ? (
          <p className="mt-1 text-[11px] font-bold text-jade" data-testid="countdown-official">
            KẾT QUẢ CHÍNH THỨC · {formatClockCs(countdown.officialMs)}
          </p>
        ) : null}
      </div>

      {/* §7: a broken read is named, not hidden — the digits keep running on
          the last authoritative deadline, and the banner says so. */}
      {syncBroken ? (
        <p role="status" className="notice-band w-full" data-tone="danger" data-testid="countdown-sync">
          <AlertIcon />
          <span className="min-w-0 flex-1">
            {status === 'OFFLINE' ? 'MẤT KẾT NỐI' : 'KHÔNG THỂ CẬP NHẬT'} — đồng hồ đang hiển thị theo mốc máy chủ đã lưu, chưa xác nhận được bản mới
          </span>
          <button
            type="button"
            onClick={onRetry}
            className="shrink-0 rounded-[8px] border border-ember/60 bg-ember/10 px-2 py-1 text-[9px] font-bold text-ember active:bg-ember/20"
            data-testid="countdown-sync-retry"
          >
            THỬ LẠI
          </button>
        </p>
      ) : null}

      {alerts.length > 0 && (
        <div className="flex w-full flex-col gap-1.5">
          {alerts.map((text) => (
            <p key={text} className="notice-band" data-tone="warn" data-testid="countdown-alert">
              <AlertIcon />
              <span>{text}</span>
            </p>
          ))}
        </div>
      )}

      {error ? (
        <p role="status" className="notice-band w-full" data-tone="danger" data-testid="message">
          <AlertIcon />
          <span>{error}</span>
        </p>
      ) : notice && !npc2Sealed ? (
        /* An error is never hidden. This is the success acknowledgement — and on
           the sealed NPC2 screen the card below already states the same server
           sentence, in larger type, with the timestamp that counts. */
        <p role="status" className="notice-band w-full" data-tone="info" data-testid="notice">
          <span>{notice}</span>
        </p>
      ) : null}

      {/* The only controls that survive the lock, in one compact band. */}
      <div className="mt-auto flex w-full flex-col gap-2">
        {role === 'ROOM305' && (
          <Npc2Panel store={store} stage={npc2Stage} attempts={attempts} countdown={countdown} pending={pending} verifying={verifying} />
        )}
        {role === 'GATE' && primary.action === 'CONFIRM_EXIT' && (
          /* V3.4 §7 — NPC1's hand-off (Screen B). The exit press stays the one
             authorised action, but the screen first states what is already
             server-confirmed: the team, the official time NPC2 locked, and the
             fact this press only records the physical departure. */
          <section className="npc1-handoff" data-testid="npc1-handoff">
            <p className="npc1-handoff-eyebrow" data-testid="npc1-handoff-state">
              {countdown.result === 'WON'
                ? 'NPC 2 ĐÃ CHỐT KẾT QUẢ — CÒN XÁC NHẬN ĐỘI RỜI TẦNG 3'
                : countdown.result === 'ABORTED'
                  ? 'LƯỢT CHƠI ĐÃ HỦY — CẦN XÁC NHẬN THỰC TẾ'
                  : 'HẾT GIỜ — CẦN XÁC NHẬN THỰC TẾ'}
            </p>
            <div className="npc1-handoff-rows">
              <p className="npc1-handoff-row">
                <span>Đội</span>
                <strong data-testid="npc1-handoff-team">{countdown.teamText.toUpperCase()}</strong>
              </p>
              {countdown.result === 'WON' && countdown.officialMs !== null ? (
                <p className="npc1-handoff-row">
                  <span>Thời gian chính thức</span>
                  <strong className="digital text-jade" data-testid="npc1-handoff-official">{formatClockCs(countdown.officialMs)}</strong>
                </p>
              ) : null}
            </div>
            <p className="npc1-handoff-note">
              Chỉ xác nhận khi bạn tận mắt thấy toàn bộ đội đã ra khỏi tầng 3. Thao tác không thay đổi thời gian hoàn thành và được ghi nhật ký.
            </p>
          </section>
        )}
        {role !== 'ROOM305' && primary.action !== null && (
          <PrimaryZone store={store} primary={primary} pending={pending} verifying={verifying} draftName="" />
        )}
        {emergency && <EmergencyControl store={store} spec={emergency} busy={busy} />}
        {showAttempts && role !== 'ROOM305' && <AttemptHistory attempts={attempts} compact />}
      </div>
    </main>
  );
}

/* -------------------------------------------------------------- NPC2 controls */

// V3.4: the claim/verify panel moved to ./Npc2Panel.tsx so the eligibility rule
// (resolveNpc2Stage → authorize) lives with the one component that renders it,
// and every role screen keeps the same shared primitives.

function AttemptHistory({ attempts, compact = false }: { attempts: AttemptRow[]; compact?: boolean }) {
  if (attempts.length === 0) return null;
  return (
    <div className={`w-full ${compact ? '' : 'rounded-[10px] border border-hair bg-panel px-3 py-2'}`} data-testid="attempt-history">
      {!compact && <p className="text-[8.5px] font-semibold tracking-[0.12em] text-mute">LẦN BÁO HOÀN THÀNH</p>}
      <ul className="flex flex-col gap-0.5">
        {attempts.map((a) => (
          <li key={a.id} className="flex items-center justify-between gap-2 text-[10px]" data-testid={`history-${a.seq}`}>
            <span className="text-snow/80">Lần {a.seq} · {formatClockCs(a.elapsedMs)}</span>
            <span
              className={a.status === 'VALID' ? 'text-jade' : a.status === 'INVALID' ? 'text-mute' : 'text-ember'}
            >
              {a.statusWord}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------------------------------------------------------- guarded exception */

/**
 * NPC1's emergency path. It is visually secondary, always asks for a reason and a
 * second confirmation, and can never produce a successful time: leaving the area is
 * never dependent on the software agreeing.
 *
 * V3.4 §6 — the semantics were verified before restyling: EARLY_EXIT is permitted
 * by the server only while RUNNING / pending-validation / waiting-for-exit, needs
 * a logged reason, and never yields a winning time. That procedure stays fully
 * available — it is now separated from the primary band by a hairline, wears the
 * blood danger accent, states its effect on the round up front, and still demands
 * the reason plus the explicit second press, so an accidental tap cannot fire it.
 */
function EmergencyControl({ store, spec, busy }: { store: LiveStore; spec: PrimaryAction; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  useEffect(() => setOpen(false), [spec.action]);
  if (!spec.action) return null;
  const send = () => {
    if (!reason.trim() || busy) return;
    void store.act(spec.action as ActionType, { ...spec.meta, reason: reason.trim() });
    setReason('');
    setOpen(false);
  };
  if (!open) {
    return (
      <div className="flex w-full flex-col gap-1 border-t border-hair pt-2" data-testid="emergency-zone">
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={busy}
          className="min-h-11 w-full rounded-[10px] border border-blood/45 bg-blood/[0.07] px-3 py-2 text-[10.5px] font-bold tracking-[0.02em] text-blood active:bg-blood/15 disabled:opacity-50"
          data-testid="emergency-open"
        >
          {spec.label}
        </button>
        {spec.hint ? (
          <p className="px-1 text-center text-[9.5px] leading-snug text-mute" data-testid="emergency-hint">{spec.hint}</p>
        ) : null}
      </div>
    );
  }
  return (
    <div className="flex w-full flex-col gap-2 border-t border-blood/30 pt-2" data-testid="emergency-panel">
      <p className="text-[9.5px] leading-snug text-blood" data-testid="emergency-effect">
        {spec.hint ?? 'Chỉ dùng khi đội buộc phải rời khu vực. Không tạo thời gian thắng.'} Lý do sẽ vào nhật ký.
      </p>
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={spec.reasonPrompt ?? 'Lý do (bắt buộc)'}
        autoFocus
        className="min-h-11 rounded-[10px] border border-blood/50 bg-panel2 px-3 py-2.5 text-[12px] text-snow outline-none focus:border-blood"
        data-testid="emergency-reason"
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => { setOpen(false); setReason(''); }}
          className="min-h-11 flex-1 rounded-[10px] border border-hair px-3 py-2 text-[10px] text-mute"
        >
          HỦY
        </button>
        <button
          type="button"
          onClick={send}
          disabled={!reason.trim() || busy}
          className="cta cta-red flex-[2] text-[11px]"
          data-testid="emergency-confirm"
        >
          {spec.confirmLabel ?? 'XÁC NHẬN'}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ primitives */

interface ZoneProps {
  store: LiveStore;
  primary: PrimaryAction;
  pending: string | null;
  verifying: string | null;
  /** OPERATOR_01's draft label for the team about to be received; it travels with the press. */
  draftName: string;
}

/** One context-sensitive control. No action → the same shape, greyed out. */
function PrimaryZone({ store, primary, pending, verifying, draftName }: ZoneProps) {
  const [armed, setArmed] = useState(false);
  const [reason, setReason] = useState('');
  const busy = pending !== null || verifying !== null;

  // Re-arm whenever the control becomes a different action. Deliberately not keyed on
  // the label: arming itself changes the caption, and re-running on that would cancel
  // the confirmation the operator just gave.
  useEffect(() => setArmed(false), [primary.action]);

  // Bypass and early exit are exceptions: a reason and an explicit second press.
  // The first press can never be blocked by the reason it is about to ask for, or the
  // control could not be armed at all; only the confirming press demands it.
  const needsReason = primary.reasonPrompt !== null;
  const needsArm = primary.confirmLabel !== null;
  const missingReason = needsReason && reason.trim().length === 0;
  // A control that needs no second press demands the reason up front; one that has a
  // second press can always be armed, and is blocked only on the confirming tap.
  const blocked = missingReason && (armed || !needsArm);
  const press = async () => {
    // Double-tap protection: the button is disabled while a write is unacknowledged,
    // the store locks the action, and the server deduplicates by idempotency key.
    if (busy || !primary.action) return;
    alarms.unlock();
    const meta: CommandMeta = { ...primary.meta };
    if (needsReason) meta.reason = reason.trim();
    if (primary.action === 'CALL_TEAM') {
      const name = cleanTeamName(draftName);
      if (name) meta.team_name = name;
    }
    await store.act(primary.action, meta);
    setArmed(false);
    setReason('');
  };

  if (primary.action === null) {
    // Not this phone's step: the same shape as the action, visibly off, with the
    // one-line reason the server state implies. Disabling here is courtesy — the
    // RPC refuses the same call outright if anyone forces it.
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
          <CtaLabel label={primary.label} />
        </button>
        {/* The reason is stated on screen, not only in a tooltip a phone held in
            the hand cannot show. */}
        {primary.hint ? <p className="cta-reason" data-testid="waiting-reason">{primary.hint}</p> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {needsReason && (
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={primary.reasonPrompt ?? undefined}
          className="rounded-[10px] border border-hair bg-panel2 px-3 py-2.5 text-[12px] text-snow outline-none focus:border-ember"
          data-testid="reason-input"
        />
      )}
      <button
        type="button"
        onClick={() => {
          if (needsArm && !armed) {
            alarms.unlock();
            setArmed(true);
            return;
          }
          void press();
        }}
        disabled={busy || blocked}
        aria-busy={busy}
        className={`cta cta-${CTA_LOOK[primary.action] ?? 'neutral'}`}
        data-testid="primary-action"
        data-action={primary.action}
        data-pending={busy ? '1' : '0'}
        data-armed={armed && needsArm ? '1' : '0'}
      >
        {busy ? (
          <span className="cta-label-main" role="status">{verifying !== null ? 'ĐANG XÁC MINH…' : 'ĐANG GHI…'}</span>
        ) : (
          <>
            <CtaIcon action={primary.action} />
            <CtaLabel label={armed && primary.confirmLabel ? primary.confirmLabel : primary.label} />
          </>
        )}
      </button>
      {/* Why the press is unavailable, or what it will do — never both at once,
          and never only inside a tooltip. */}
      {blocked ? (
        <p className="cta-reason cta-reason-warn" data-testid="primary-block">{primary.reasonPrompt ?? 'Cần nhập lý do trước khi bấm.'}</p>
      ) : primary.hint ? (
        <p className="cta-reason" data-testid="primary-hint">{primary.hint}</p>
      ) : null}
    </div>
  );
}
