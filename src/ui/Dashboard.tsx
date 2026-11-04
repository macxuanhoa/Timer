import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { LiveStore } from '../client/liveStore';
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
  resolveJourney,
  resolvePrimary,
  resolveTeamLine,
  teamLabel,
  type AttemptRow,
  type PrimaryAction,
} from '../client/selectors';
import { useNow, useWakeLock } from './hooks';
import { alarms } from './sound';
import { ROLE_SHORT, ROLE_LABEL, TEAM_NAME_MAX, TRANSPORT_LABEL, type Role } from '../shared/constants';
import { roundLimitMs } from '../shared/machine';
import { formatClockCs, formatClockSec, formatWallTime, leaderboard } from '../shared/metrics';
import type { ActionType, CommandMeta, Round } from '../shared/types';
import { DetailsSheet } from './DetailsSheet';
import { BigScreen } from './BigScreen';
import { JourneyBoard, JourneyStepper } from './JourneyMap';
import { ACCENT_HEX, ROLE_ACCENT, TEAM_TONE_HEX } from './accents';
import {
  ArrowUpIcon,
  BarsIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  CrossIcon,
  GearIcon,
  PencilIcon,
  PlayIcon,
  StopIcon,
  TrophyIcon,
  UsersIcon,
} from './icons';

/** Matches the engine and the database: collapse blanks, then compare. */
const cleanTeamName = (value: string) => value.trim().replace(/\s+/g, ' ');

/** Colour of the big button, taken from the action's meaning (not the station). */
const CTA_LOOK: Partial<Record<ActionType, 'red' | 'green' | 'amber' | 'neutral'>> = {
  CALL_TEAM: 'red',
  CONFIRM_FLOOR2: 'green',
  FLOOR2_BYPASS: 'amber',
  START_GAME: 'green',
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
  const attempts = useMemo(() => (snap ? resolveAttempts(snap, now) : []), [snap, now]);
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

  if (!snap || !countdown || !primary || !journey || !teamLine) {
    return (
      <div className="flex h-[100dvh] items-center justify-center bg-ink text-mute" data-testid="booting">
        <div className="text-center">
          <p className="text-lg font-extrabold tracking-[0.18em] text-blood">SCREAM CONTROL</p>
          <p className="mt-3 text-sm">{state.status === 'OFFLINE' ? 'ĐANG THỬ LẠI KẾT NỐI…' : 'ĐANG ĐỒNG BỘ TRẠNG THÁI…'}</p>
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
  const ok = state.status === 'CONNECTED';

  return (
    <div
      className="flex h-[100dvh] flex-col bg-ink"
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
          <p className="text-[15px] font-extrabold leading-none tracking-[0.01em] text-blood">SCREAM CONTROL</p>
          <p className="mt-1.5 flex items-center gap-1.5 text-[8.5px] font-semibold tracking-[0.1em] text-mute">
            <span className="text-snow/55">ROOM 305</span>
            <span className="text-hair">•</span>
            <span className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-blood' : 'bg-ember breathe'}`} aria-hidden />
            <span data-testid="connection" data-status={state.status} className={ok ? 'text-snow/70' : 'text-ember'}>
              {TRANSPORT_LABEL[state.status] ?? state.status}
            </span>
            {staleData ? <span className="text-ember" data-testid="data-age">· DỮ LIỆU CÓ THỂ CŨ</span> : null}
          </p>
        </div>

        <div className="flex shrink-0 items-start gap-1.5">
          <div className="flex flex-col items-end gap-0.5">
            <div className="flex h-[30px] items-center gap-1.5 rounded-[10px] border border-hair bg-panel px-2.5">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: accent }} aria-hidden />
              <span className="text-[11px] font-bold leading-none text-snow" data-testid="role-tag">
                {ROLE_SHORT[account.role]}
              </span>
              {!locked ? <ChevronDownIcon className="h-3 w-3 text-mute" /> : null}
            </div>
            <span className="pr-0.5 text-[8px] font-semibold tracking-[0.08em] text-mute">{ROLE_LABEL[account.role]}</span>
          </div>
          {!locked && (
            <button
              type="button"
              onClick={() => setSheetOpen(true)}
              aria-label="Cài đặt trạm"
              className="flex h-[30px] w-[30px] items-center justify-center rounded-[10px] border border-hair bg-panel text-snow active:bg-panel2"
              data-testid="open-settings"
            >
              <GearIcon className="h-4 w-4" />
            </button>
          )}
        </div>
      </header>

      {locked ? (
        <CountdownScreen
          store={store}
          role={account.role}
          primary={primary}
          countdown={countdown}
          attempts={attempts}
          alerts={alerts.map((a) => a.text)}
          pending={state.pending}
          verifying={state.verifying}
          error={state.error}
          notice={state.notice}
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
                // OPERATOR_01 may draft a label before the team exists — it then travels
                // with the reception press — and either position may correct it while the
                // team is still being handed over. Once the countdown runs, session data
                // is frozen.
                canRename={
                  round !== null
                    ? (account.role === 'LOBBY' || account.role === 'SUPERVISOR') &&
                      (phase === 'WAITING_FLOOR2_CONFIRMATION' || phase === 'READY_AT_FLOOR3')
                    : account.role === 'LOBBY' && primary.action === 'CALL_TEAM'
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
        <footer className="safe-bottom flex items-center justify-between gap-2 border-t border-hair px-3 pt-2">
          <div className="flex min-w-0 items-center gap-2">
            <TrophyIcon className="h-4 w-4 shrink-0 text-ember" />
            <div className="min-w-0">
              <p className="text-[8px] font-semibold tracking-[0.12em] text-mute">KỶ LỤC HIỆN TẠI</p>
              <p className="truncate text-[11px] font-bold leading-tight text-snow" data-testid="summary-line">
                {rows[0] ? `Đội #${pad(rows[0].team_number)} • ${formatClockCs(rows[0].duration_ms)}` : 'Chưa có kỷ lục'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => { setSheetTab('ops'); setSheetOpen(true); }}
            className="flex shrink-0 items-center gap-1.5 rounded-[10px] border border-hair bg-panel px-2.5 py-2 text-[10px] font-semibold text-snow active:bg-panel2"
            data-testid="open-details"
          >
            <BarsIcon className="h-3.5 w-3.5" />
            Xem thêm
            <ChevronRightIcon className="h-3 w-3 text-mute" />
          </button>
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
function EventEndedCard({ rounds, successful, endedAt, onOpenReport }: {
  rounds: number; successful: number; endedAt: number; onOpenReport(): void;
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
      <button
        type="button"
        onClick={onOpenReport}
        className="w-full rounded-panel border border-hair bg-panel px-4 py-3.5 text-[0.78rem] font-semibold text-snow active:bg-panel2"
        data-testid="open-report"
      >
        XEM BÁO CÁO & LỊCH SỬ
      </button>
      <p className="text-[0.66rem] leading-snug text-mute" data-testid="ended-board-note">
        Bảng vị trí vẫn mở cho ca tiếp theo — chọn lại vị trí ở màn hình đầu tiên.
      </p>
    </section>
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
      <button
        type="button"
        onClick={() => void leave()}
        disabled={busy}
        className="min-h-9 w-full rounded-[9px] border border-hair bg-panel px-3 py-1.5 text-[10.5px] font-semibold tracking-[0.02em] text-snow/90 disabled:opacity-50"
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
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] border border-hair bg-panel2 text-mute active:text-snow disabled:opacity-40"
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
 * amber/gold accents, an illuminated border and a slow breathing glow, so every floor
 * knows the countdown is one press away without anything flashing in their face.
 */
function PreStartAlert({ round, isNpc1, label, durationLabel }: { round: Round | null; isNpc1: boolean; label: string; durationLabel: string }) {
  return (
    <section className="prestart-block flex flex-1 flex-col items-center justify-center gap-2 px-3 py-5" data-testid="prestart-alert">
      <p className="text-[9px] font-semibold tracking-[0.2em] text-ember/90">ĐỘI CHƠI SẮP BẮT ĐẦU</p>
      <p className="digital text-[clamp(1.4rem,7vw,2.6rem)] font-bold leading-none text-ember" data-testid="prestart-team">
        {label.toUpperCase()}
      </p>
      <p className="text-center text-[11px] leading-snug text-snow/80" data-testid="prestart-hint">
        {isNpc1 ? 'Kiểm tra đội có mặt, phổ biến luật và đưa gợi ý' : 'NPC 1 đang phổ biến luật ở cửa vào tầng 3'}
      </p>
      <p className="mt-1 text-[10px] font-semibold tracking-[0.14em] text-ember" data-testid="prestart-duration">
        THỜI LƯỢNG TRÒ CHƠI: {durationLabel}
      </p>
      <p className="flex items-center justify-center gap-2 text-[10px] font-semibold tracking-[0.14em] text-ember/80">
        <ClockIcon className="h-3.5 w-3.5" />
        {durationLabel} CHỜ BẮT ĐẦU
      </p>
      {round?.floor2_bypassed_at !== null && round?.floor2_bypassed_at !== undefined ? (
        <p className="text-[9.5px] text-mute" data-testid="prestart-bypassed">
          Tầng 2 đã được bỏ qua có ghi nhật ký
        </p>
      ) : null}
    </section>
  );
}

/* ----------------------------------------------------------- locked countdown */

interface CountdownProps {
  store: LiveStore;
  role: Role;
  primary: PrimaryAction;
  countdown: ReturnType<typeof resolveCountdown>;
  attempts: AttemptRow[];
  alerts: string[];
  pending: string | null;
  verifying: string | null;
  error: string | null;
  notice: string | null;
  onOpenBigScreen(): void;
}

/**
 * PHASE 04 — the countdown-focused screen every role is switched to when NPC1
 * presses START. It is a functional lock, not an overlay: the navigation, the
 * journey editor, the previous phase buttons and the ranking are simply not
 * rendered, and only the explicitly allowed in-game controls are.
 */
function CountdownScreen({ store, role, primary, countdown, attempts, alerts, pending, verifying, error, notice, onOpenBigScreen }: CountdownProps) {
  const snap = store.getSnapshot().snapshot;
  // The emergency path is derived from the same authoritative snapshot the parent
  // renders from, so it can never offer a control the server would refuse.
  const emergency = snap ? resolveEmergency(role, snap, store.serverNow()) : null;
  const busy = pending !== null || verifying !== null;
  const tone = countdown.tone === 'danger' ? ACCENT_HEX.red : countdown.tone === 'warn' ? ACCENT_HEX.amber : ACCENT_HEX.green;
  const showAttempts = role === 'ROOM305' || attempts.some((a) => a.status !== 'PENDING');

  return (
    <main className="flex min-h-0 flex-1 flex-col items-center justify-between gap-2 overflow-y-auto px-3 pb-2" data-testid="countdown-screen" data-tone={countdown.tone}>
      <div className="flex w-full items-center justify-between px-1 pt-1">
        <p className="text-[9px] font-semibold tracking-[0.16em] text-mute" data-testid="countdown-label">
          {countdown.heroLabel}
        </p>
        <button
          type="button"
          onClick={onOpenBigScreen}
          className="rounded-[8px] border border-hair bg-panel px-2 py-1 text-[9px] font-semibold text-mute active:text-snow"
          data-testid="countdown-big"
        >
          MÀN HÌNH LỚN
        </button>
      </div>

      {/* MM:SS owns the screen; the fraction is a separate, much smaller field. */}
      <div className="flex flex-1 flex-col items-center justify-center" data-testid="countdown-hero">
        <p className="digital countdown-main font-bold leading-none" style={{ color: tone }}>
          <span data-testid="hero-clock" data-mode={countdown.running ? 'GAME' : 'FROZEN'}>
            {countdown.mm}:{countdown.ss}
          </span>
          <span className="countdown-fraction" data-testid="hero-fraction" aria-hidden>
            {countdown.cs}
          </span>
        </p>
        <p className="mt-2 text-[13px] font-bold tracking-[0.08em] text-snow" data-testid="countdown-team">
          {countdown.teamText.toUpperCase()}
        </p>
        <p
          className="mt-1 flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.14em]"
          style={{ color: tone }}
          data-testid="countdown-status"
        >
          {countdown.statusLine}
        </p>
        {countdown.officialMs !== null && countdown.result === 'WON' ? (
          <p className="mt-2 text-[11px] font-bold text-jade" data-testid="countdown-official">
            KẾT QUẢ CHÍNH THỨC · {formatClockCs(countdown.officialMs)}
          </p>
        ) : null}
      </div>

      {alerts.length > 0 && (
        <div className="flex w-full flex-col gap-1.5">
          {alerts.map((text) => (
            <p key={text} className="rounded-[10px] border border-ember/40 bg-ember/10 px-3 py-1.5 text-[10px] leading-snug text-ember" data-testid="countdown-alert">
              {text}
            </p>
          ))}
        </div>
      )}

      {error ? (
        <p role="status" className="w-full rounded-[10px] border border-blood/50 bg-blood/10 px-3 py-2 text-[11px] leading-snug text-blood" data-testid="message">
          {error}
        </p>
      ) : notice ? (
        <p role="status" className="w-full rounded-[10px] border border-hair bg-panel px-3 py-2 text-[10.5px] leading-snug text-mute" data-testid="notice">
          {notice}
        </p>
      ) : null}

      {/* The only controls that survive the lock, in one compact band. */}
      <div className="flex w-full flex-col gap-2">
        {role === 'ROOM305' && (
          <Npc2Panel store={store} attempts={attempts} pending={pending} verifying={verifying} countdown={countdown} />
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

interface Npc2Props {
  store: LiveStore;
  attempts: AttemptRow[];
  pending: string | null;
  verifying: string | null;
  countdown: ReturnType<typeof resolveCountdown>;
}

/**
 * The claim/verify panel. Recording a claim and deciding a claim are two presses at
 * two instants on purpose: the timestamp that becomes official is the claim's own,
 * so the time NPC2 spends checking never penalises the players.
 */
function Npc2Panel({ store, attempts, pending, verifying }: Npc2Props) {
  const busy = pending !== null || verifying !== null;
  const open = attempts.filter((a) => a.open);
  const press = (action: ActionType, meta: CommandMeta = {}) => void store.act(action, meta);
  return (
    <div className="flex w-full flex-col gap-2" data-testid="npc2-panel">
      <button
        type="button"
        onClick={() => press('CLAIM_COMPLETE')}
        disabled={busy}
        className="cta cta-amber"
        data-testid="record-claim"
        data-action="CLAIM_COMPLETE"
      >
        <UsersIcon className="h-5 w-5" />
        GHI NHẬN BÁO HOÀN THÀNH
      </button>
      {attempts.length > 0 && (
        <ul className="flex w-full flex-col gap-1.5" data-testid="attempt-list">
          {attempts.map((a) => (
            <li
              key={a.id}
              className="rounded-[10px] border border-hair bg-panel px-2.5 py-2"
              data-testid={`attempt-${a.seq}`}
              data-status={a.status}
            >
              <p className="text-[10.5px] font-semibold text-snow" data-testid="attempt-label">
                {a.label}
              </p>
              {a.open ? (
                <div className="mt-1.5 flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => press('VERIFY_ATTEMPT', { attempt_id: a.id, decision: 'INVALID' })}
                    disabled={busy}
                    className="flex flex-1 items-center justify-center gap-1 rounded-[8px] border border-hair bg-panel2 px-2 py-2 text-[10px] font-bold text-mute active:text-snow disabled:opacity-50"
                    data-testid={`attempt-invalid-${a.seq}`}
                  >
                    <CrossIcon className="h-3.5 w-3.5" />
                    CHƯA ĐÚNG — TIẾP TỤC
                  </button>
                  <button
                    type="button"
                    onClick={() => press('VERIFY_ATTEMPT', { attempt_id: a.id, decision: 'VALID' })}
                    disabled={busy || !a.inTime}
                    className="flex flex-1 items-center justify-center gap-1 rounded-[8px] border border-jade/60 bg-jade/10 px-2 py-2 text-[10px] font-bold text-jade disabled:opacity-50"
                    data-testid={`attempt-valid-${a.seq}`}
                  >
                    <CheckIcon className="h-3.5 w-3.5" />
                    CHÍNH XÁC — CHỐT THỜI GIAN
                  </button>
                </div>
              ) : (
                <p className="mt-1 text-[9.5px] text-mute" data-testid="attempt-closed">
                  {a.status === 'LATE'
                    ? 'Ghi nhận sau hết giờ — không tạo kết quả thắng'
                    : a.status === 'VALID'
                      ? `Đã chốt · ${a.inTime ? 'thời gian tính theo mốc báo' : 'ngoài giờ'}`
                      : `Đã từ chối · ${a.verifiedAt ? 'giữ nguyên mốc báo' : ''}`}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {open.length > 0 && (
        <p className="text-center text-[9.5px] leading-snug text-ember" data-testid="attempt-hint">
          Đang chờ quyết định cho {open.length} lần báo — đồng hồ vẫn chạy
        </p>
      )}
    </div>
  );
}

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
              {a.status === 'PENDING' ? 'chờ kiểm tra' : a.status === 'LATE' ? 'đến muộn' : a.status === 'VALID' ? 'chính xác' : 'chưa đúng'}
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
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={busy}
        className="w-full rounded-[10px] border border-hair bg-panel px-3 py-2 text-[10px] font-semibold tracking-[0.02em] text-ember active:bg-panel2 disabled:opacity-50"
        data-testid="emergency-open"
      >
        {spec.label}
      </button>
    );
  }
  return (
    <div className="flex w-full flex-col gap-2" data-testid="emergency-panel">
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={spec.reasonPrompt ?? 'Lý do (bắt buộc)'}
        autoFocus
        className="rounded-[10px] border border-blood/50 bg-panel2 px-3 py-2.5 text-[12px] text-snow outline-none focus:border-blood"
        data-testid="emergency-reason"
      />
      <div className="flex gap-2">
        <button type="button" onClick={() => { setOpen(false); setReason(''); }} className="flex-1 rounded-[10px] border border-hair px-3 py-2 text-[10px] text-mute">
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
        >
          {primary.label}
        </button>
        {primary.hint ? <p className="px-1 text-center text-[0.62rem] leading-snug text-mute">{primary.hint}</p> : null}
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
        className={`cta cta-${CTA_LOOK[primary.action] ?? 'neutral'}`}
        data-testid="primary-action"
        data-action={primary.action}
      >
        {busy ? (verifying !== null ? 'ĐANG XÁC MINH…' : 'ĐANG GHI…') : (
          <>
            <CtaIcon action={primary.action} />
            {armed && primary.confirmLabel ? primary.confirmLabel : primary.label}
          </>
        )}
      </button>
      {primary.hint ? <p className="px-1 text-center text-[0.62rem] leading-snug text-mute">{primary.hint}</p> : null}
    </div>
  );
}
