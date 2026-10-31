import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { LiveStore } from '../client/liveStore';
import type { StoredSession } from './session';
import {
  phaseOf,
  resolveAlerts,
  resolveHero,
  resolveJourney,
  resolvePrimary,
  resolveTeamLine,
} from '../client/selectors';
import { isGamePaused, isGameRunning } from '../shared/machine';
import { useNow, useWakeLock } from './hooks';
import { alarms } from './sound';
import { ROLE_SHORT, TEAM_NAME_MAX } from '../shared/constants';
import { formatClockCs, formatClockSec, leaderboard } from '../shared/metrics';
import type { ActionType, Round } from '../shared/types';
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
  GearIcon,
  PencilIcon,
  PlayIcon,
  StopIcon,
  TrophyIcon,
  UsersIcon,
} from './icons';
import { pad } from '../client/selectors';

/** Matches the engine and the database: collapse blanks, then compare. */
const cleanTeamName = (value: string) => value.trim().replace(/\s+/g, ' ');

/** Colour of the big button, taken from the action's meaning (not the station). */
const CTA_LOOK: Partial<Record<ActionType, 'red' | 'green' | 'amber' | 'neutral'>> = {
  CALL_TEAM: 'red',
  TEAM_UPSTAIRS: 'red',
  START_GAME: 'green',
  HALLWAY_PROGRESS: 'amber',
  ROOM_REACHED: 'green',
  PUZZLE_COMPLETE: 'green',
  RETURN_START: 'green',
  GAME_STOP: 'red',
  RESET_DONE: 'amber',
  GATE_FINALIZE: 'green',
};

function CtaIcon({ action }: { action: ActionType }) {
  if (action === 'CALL_TEAM' || action === 'TEAM_UPSTAIRS') return <UsersIcon className="h-5 w-5" />;
  if (action === 'START_GAME') return <PlayIcon className="h-5 w-5" />;
  if (action === 'GAME_STOP') return <StopIcon className="h-5 w-5" />;
  return <CheckIcon className="h-5 w-5" />;
}

interface Props {
  store: LiveStore;
  account: StoredSession['account'];
  onLogout(): Promise<void>;
}

export function Dashboard({ store, account, onLogout }: Props) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const snap = state.snapshot;
  const activeRoundId = snap?.active_round?.id ?? null;
  const running = !!snap && isGameRunning(snap.active_round);
  const now = useNow(store, running ? 'raf' : 'slow');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [teamName, setTeamName] = useState('');
  const [nameOpen, setNameOpen] = useState(false);
  const [bigOpen, setBigOpen] = useState(false);
  const [bigAuto, setBigAuto] = useState(false);
  const [journeyOpen, setJourneyOpen] = useState(false);

  const hero = useMemo(() => (snap ? resolveHero(snap, now) : null), [snap, now]);
  const primary = useMemo(() => (snap ? resolvePrimary(account.role, snap, now) : null), [snap, account.role, now]);
  const journey = useMemo(() => (snap ? resolveJourney(snap, now, account.role) : null), [snap, now, account.role]);
  const teamLine = useMemo(() => (snap ? resolveTeamLine(snap, now) : null), [snap, now]);
  const phase = snap ? phaseOf(snap, now) : 'PRE_EVENT';

  useWakeLock(phase !== 'ENDED' && phase !== 'PRE_EVENT');

  /* The wall display follows the authoritative game clock. */
  const counting = hero?.mode === 'GAME' || hero?.mode === 'GAME_OVERTIME' || hero?.mode === 'GAME_PAUSED';

  useEffect(() => {
    // A station with no button to press during a game becomes the display by itself.
    if (counting && account.role === 'LOBBY') {
      setBigAuto(true);
      setBigOpen(true);
    }
    // GATE stopped the clock (or the round ended): every phone drops back to the dashboard.
    if (!counting) setBigOpen(false);
  }, [counting, account.role]);

  useEffect(() => {
    // A new team on the floor always starts with a clean, closed name editor.
    setNameOpen(false);
    setTeamName('');
  }, [activeRoundId]);

  // Audible + visual alerting where supported (§1 individual game, §7 closing).
  useEffect(() => {
    if (!snap || bigOpen) return;
    const gameOver = phase === 'GAME_OVERTIME';
    alarms.setPattern(gameOver ? 'critical' : 'none');
  }, [snap, phase, bigOpen]);

  // Re-render when the browser finally lets the alarm sound play.
  const [, bumpAudio] = useState(0);
  useEffect(() => {
    const id = setInterval(() => bumpAudio((n) => n + 1), 2000);
    return () => clearInterval(id);
  }, []);

  if (!snap || !hero || !primary || !journey || !teamLine) {
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

  const rows = leaderboard(snap);
  const fastest = rows[0];
  const round = snap.active_round;
  const staleData = state.status === 'DEGRADED' || (store.dataAgeMs() ?? 0) > 22_000;
  const alerts = resolveAlerts(snap, now, staleData);
  if (alarms.status() !== 'READY' && alarms.pattern !== 'none') {
    alerts.push({ id: 'AUDIO', tone: 'danger', text: 'Chưa bật được âm thanh — chạm để kích hoạt cảnh báo' });
  }

  const gameLimit = snap.event.config.game_limit_ms;
  const heroMs = hero.valueMs;
  const heroPct = heroMs !== null ? Math.max(0, Math.min(100, (heroMs / gameLimit) * 100)) : 0;
  const heroHue =
    hero.mode === 'GAME' ? ACCENT_HEX.green : hero.mode === 'GAME_OVERTIME' ? ACCENT_HEX.red : hero.mode === 'GAME_PAUSED' ? ACCENT_HEX.amber : '#9a9aa3';
  const heroText =
    heroMs === null
      ? formatClockSec(gameLimit)
      : hero.mode === 'GAME_OVERTIME'
        ? `+${formatClockCs(-heroMs)}`
        : formatClockCs(heroMs);
  const walkUp = account.role === 'LOBBY' && round?.status === 'LOBBY_CALL';
  // The label can be changed on the team on the floor (SET_TEAM_NAME), or drafted
  // by LOBBY for the team about to be called — then it travels with CALL_TEAM.
  const canRename =
    (account.role === 'LOBBY' || account.role === 'SUPERVISOR') &&
    (round !== null || (account.role === 'LOBBY' && primary.action === 'CALL_TEAM'));
  const nameSaving = state.pending === 'SET_TEAM_NAME';
  const nameDirty = cleanTeamName(teamName) !== (round?.team_name ?? '');
  const accent = ACCENT_HEX[ROLE_ACCENT[account.role]];

  const ok = state.status === 'CONNECTED';
  const online = `${snap.operators.length}/${snap.operators.length} ONLINE`;

  const cancelNameEdit = () => {
    setNameOpen(false);
    // Pre-dispatch naming is only a draft on this phone; cancelling discards it.
    if (!round) setTeamName('');
  };

  const openNameEditor = () => {
    if (!canRename) return;
    if (nameOpen) {
      cancelNameEdit();
      return;
    }
    setTeamName(round?.team_name ?? '');
    setNameOpen(true);
  };

  const saveName = async () => {
    if (!canRename || nameSaving) return;
    if (!round) {
      // No round exists yet: CALL_TEAM carries the name into the database.
      setNameOpen(false);
      return;
    }
    const result = await store.act('SET_TEAM_NAME', { team_name: cleanTeamName(teamName) });
    if (result?.ok) {
      setTeamName(cleanTeamName(teamName));
      setNameOpen(false);
    }
  };

  return (
    <div
      className="flex h-[100dvh] flex-col bg-ink"
      data-testid="dashboard"
      data-revision={snap.revision}
      data-phase={phase}
      onPointerDown={() => alarms.unlock()}
    >
      {/* ------------------------------------------------------------ header */}
      <header className="safe-top flex items-start justify-between gap-2 px-3 pt-3 pb-2.5">
        <div className="min-w-0">
          <p className="text-[15px] font-extrabold leading-none tracking-[0.01em] text-blood">SCREAM CONTROL</p>
          <p className="mt-1.5 flex items-center gap-1.5 text-[8.5px] font-semibold tracking-[0.1em] text-mute">
            <span className="text-snow/55">EVENT 305</span>
            <span className="text-hair">•</span>
            <span className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-blood' : 'bg-ember breathe'}`} aria-hidden />
            <span data-testid="connection" data-status={state.status} className={ok ? 'text-snow/70' : 'text-ember'}>
              {ok ? 'TRỰC TIẾP' : state.status === 'OFFLINE' ? 'MẤT KẾT NỐI' : 'ĐANG ĐỒNG BỘ'}
            </span>
          </p>
        </div>

        <div className="flex shrink-0 items-start gap-1.5">
          <div className="flex flex-col items-end gap-0.5">
            <div className="flex h-[30px] items-center gap-1.5 rounded-[10px] border border-hair bg-panel px-2.5">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: accent }} aria-hidden />
              <span className="text-[11px] font-bold leading-none text-snow" data-testid="role-tag">
                {ROLE_SHORT[account.role]}
              </span>
              <ChevronDownIcon className="h-3 w-3 text-mute" />
            </div>
            <span className="pr-0.5 text-[8px] font-semibold tracking-[0.08em] text-mute">{online}</span>
          </div>
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            aria-label="Cài đặt trạm"
            className="flex h-[30px] w-[30px] items-center justify-center rounded-[10px] border border-hair bg-panel text-snow active:bg-panel2"
            data-testid="open-settings"
          >
            <GearIcon className="h-4 w-4" />
          </button>
        </div>
      </header>

      <ReturnHome onLogout={onLogout} />

      <main className="flex min-h-0 flex-1 flex-col justify-evenly gap-2.5 overflow-y-auto px-3 pb-2">
        {/* --------------------------------------------------------- team card */}
        <section className="card tm-card" data-testid="active-team">
          <div className="flex items-center justify-between gap-2">
            <h1 className="digital team-digits font-bold text-snow">TEAM #{pad(round?.team_number ?? snap.event.next_team_number)}</h1>
            <button
              type="button"
              onClick={openNameEditor}
              disabled={!canRename}
              aria-label="Đặt tên đội"
              aria-expanded={nameOpen}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] border border-hair bg-panel2 text-mute active:text-snow disabled:opacity-40"
              data-testid="team-edit"
            >
              <PencilIcon className="h-3.5 w-3.5" />
            </button>
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
          {nameOpen && canRename && (
            <div className="mt-2">
              <div className="flex items-center gap-2">
                <input
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void saveName();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelNameEdit();
                    }
                  }}
                  placeholder="Tên đội (tuỳ chọn)"
                  maxLength={TEAM_NAME_MAX}
                  autoFocus
                  disabled={nameSaving}
                  className="h-8 min-w-0 flex-1 rounded-[8px] border border-hair bg-panel2 px-2.5 text-[12px] text-snow outline-none focus:border-blood disabled:opacity-60"
                  data-testid="team-name"
                />
                <button
                  type="button"
                  onClick={() => void saveName()}
                  disabled={nameSaving || (round !== null && !nameDirty)}
                  className="flex h-8 shrink-0 items-center justify-center rounded-[8px] border border-blood/60 bg-blood/10 px-2.5 text-[10px] font-bold text-blood disabled:opacity-40"
                  data-testid="team-name-save"
                >
                  {nameSaving ? 'ĐANG LƯU' : round ? 'LƯU' : 'XONG'}
                </button>
                <button
                  type="button"
                  onClick={cancelNameEdit}
                  disabled={nameSaving}
                  className="flex h-8 shrink-0 items-center justify-center rounded-[8px] border border-hair px-2.5 text-[10px] font-semibold text-mute disabled:opacity-40"
                  data-testid="team-name-cancel"
                >
                  HỦY
                </button>
              </div>
              {!round ? (
                <p className="mt-1 text-[9px] leading-snug text-mute">Tên sẽ được lưu cùng lượt gọi đội tiếp theo.</p>
              ) : null}
            </div>
          )}
        </section>

        {/* --------------------------------------------------------------- hero */}
        {/* The clock grows into the spare height, but only up to its cap: the rest
            is shared by every gap, so no band turns into a dead hole around it. */}
        <section className="hero-block relative isolate flex flex-1 flex-col items-center justify-center py-2" data-testid="hero">
          <span
            className="hero-aura -z-10"
            aria-hidden
            style={{ background: `radial-gradient(ellipse 46% 26% at 50% 50%, ${heroHue}20 0%, transparent 70%)` }}
          />
          {walkUp ? (
            <>
              <ArrowUpIcon className="h-10 w-10 text-ember" />
              <p className="mt-1 text-[12px] font-bold tracking-[0.16em] text-ember">ĐỘI ĐANG LÊN TẦNG 3</p>
            </>
          ) : (
            <>
              <p className="flex items-center gap-1.5 text-[9px] font-semibold tracking-[0.16em] text-mute" data-testid="hero-label">
                <ClockIcon className="h-3.5 w-3.5" />
                {hero.label}
              </p>
              <p
                className="digital hero-digits mt-1 font-bold"
                data-testid="hero-clock"
                data-mode={hero.mode}
                style={{ color: heroHue }}
              >
                {heroText}
              </p>
              <div className="track mt-2.5 w-full">
                <span style={{ width: `${heroPct}%`, background: heroHue }} />
              </div>
            </>
          )}
        </section>

        {/* ------------------------------------------------------------ journey */}
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

        {/* Only failures need a box: a successful press is visible above. */}
        {state.error && (
          <p
            role="status"
            className="rounded-[10px] border border-blood/50 bg-blood/10 px-3 py-2 text-[11px] leading-snug text-blood"
            data-testid="message"
          >
            {state.error}
          </p>
        )}

        <div className="flex flex-col gap-2.5">
          <PrimaryZone
            store={store}
            account={account}
            primary={primary}
            pending={state.pending}
            verifying={state.verifying}
            draftName={teamName}
          />

          {round && round.game_started_at !== null && round.game_stopped_at === null && (account.role === 'GATE' || account.role === 'SUPERVISOR') && (
            <ClockControls store={store} round={round} pending={state.pending} />
          )}
        </div>
      </main>

      {/* -------------------------------------------------------------- footer */}
      <footer className="safe-bottom flex items-center justify-between gap-2 border-t border-hair px-3 pt-2">
        <div className="flex min-w-0 items-center gap-2">
          <TrophyIcon className="h-4 w-4 shrink-0 text-ember" />
          <div className="min-w-0">
            <p className="text-[8px] font-semibold tracking-[0.12em] text-mute">KỶ LỤC HIỆN TẠI</p>
            <p className="truncate text-[11px] font-bold leading-tight text-snow" data-testid="summary-line">
              {fastest ? `Team #${pad(fastest.team_number)} • ${formatClockCs(fastest.duration_ms)}` : 'Chưa có kỷ lục'}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          className="flex shrink-0 items-center gap-1.5 rounded-[10px] border border-hair bg-panel px-2.5 py-2 text-[10px] font-semibold text-snow active:bg-panel2"
          data-testid="open-details"
        >
          <BarsIcon className="h-3.5 w-3.5" />
          Xem thêm
          <ChevronRightIcon className="h-3 w-3 text-mute" />
        </button>
      </footer>

      <DetailsSheet
        open={sheetOpen}
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

function ReturnHome({ onLogout }: { onLogout(): Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const leave = async () => {
    if (busy) return;
    setBusy(true); setError(false);
    try { await onLogout(); }
    catch { setError(true); }
    finally { setBusy(false); }
  };
  return <div className="px-3 pb-1.5 text-center">
    <button type="button" onClick={() => void leave()} disabled={busy}
      className="min-h-9 w-full rounded-[9px] border border-hair bg-panel px-3 py-1.5 text-[10.5px] font-semibold tracking-[0.02em] text-snow/90 disabled:opacity-50"
      data-testid="return-home">{busy ? 'ĐANG NHẢ VỊ TRÍ…' : 'VỀ HOME SCREAM ROOM'}</button>
    {error ? <p role="alert" className="mt-1 text-[11px] text-ember" data-testid="release-error">
      Chưa nhả được vị trí. Kiểm tra kết nối và bấm lại.
    </p> : null}
  </div>;
}

/* ---------------------------------------------------------------- primitives */

interface ZoneProps {
  store: LiveStore;
  account: StoredSession['account'];
  primary: ReturnType<typeof resolvePrimary>;
  pending: string | null;
  verifying: string | null;
  /** LOBBY's draft label for the next call; ignored by every other action. */
  draftName: string;
}

/** One context-sensitive control. No action → the same shape, greyed out. */
function PrimaryZone({ store, account, primary, pending, verifying, draftName }: ZoneProps) {
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [reason, setReason] = useState('');
  const busy = pending !== null || verifying !== null;
  const canOverride = primary.overrideOnly && account.role === 'SUPERVISOR';

  useEffect(() => setOverrideOpen(false), [primary.action, primary.label]);

  const press = async () => {
    // Double-tap protection: the button is disabled while a write is
    // unacknowledged, the store locks the action, and the server deduplicates by
    // idempotency key. A time-based guard would only swallow deliberate presses.
    if (busy || !primary.action) return;
    alarms.unlock();
    const name = cleanTeamName(draftName);
    await store.act(primary.action, primary.action === 'CALL_TEAM' && name ? { team_name: name } : {});
  };

  const sendOverride = async () => {
    if (!reason.trim() || busy) return;
    alarms.unlock();
    // Exceptional admission: explicit confirmation + mandatory audit reason.
    if (account.role === 'SUPERVISOR' && primary.overrideOnly) {
      await store.act('CALL_TEAM', { override: true, reason: reason.trim() });
    }
    setReason('');
    setOverrideOpen(false);
  };

  if (primary.action === null && !primary.overrideOnly) {
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
        {primary.hint ? (
          <p className="px-1 text-center text-[0.62rem] leading-snug text-mute">{primary.hint}</p>
        ) : null}
      </div>
    );
  }

  if (primary.overrideOnly) {
    return (
      <div className="flex flex-col gap-2" data-testid="override-zone">
        <div className="rounded-[12px] border border-ember/40 bg-ember/10 px-3 py-3 text-center">
          <p className="text-[12px] font-bold tracking-[0.06em] text-ember">{primary.label}</p>
          {primary.hint ? <p className="mt-1 text-[10px] text-ember/80">{primary.hint}</p> : null}
        </div>
        {canOverride &&
          (overrideOpen ? (
            <div className="flex flex-col gap-2">
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Lý do ngoại lệ (bắt buộc, sẽ vào nhật ký)"
                className="rounded-[10px] border border-hair bg-panel2 px-3 py-3 text-[12px] text-snow outline-none focus:border-ember"
                data-testid="override-reason"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setOverrideOpen(false)}
                  className="flex-1 rounded-[10px] border border-hair px-3 py-3 text-[11px] text-mute"
                >
                  HỦY
                </button>
                <button
                  type="button"
                  onClick={sendOverride}
                  disabled={!reason.trim() || busy}
                  className="cta cta-red flex-[2]"
                  data-testid="override-confirm"
                >
                  XÁC NHẬN NGOẠI LỆ
                </button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => setOverrideOpen(true)} className="cta cta-neutral" data-testid="override-open">
              SUPERVISOR: VÀO ĐỘI NGOẠI LỆ
            </button>
          ))}
      </div>
    );
  }

  const look = primary.action ? CTA_LOOK[primary.action] ?? 'neutral' : 'neutral';
  const action = primary.action;
  if (!action) return null;
  return (
    <button
      type="button"
      onClick={press}
      disabled={busy}
      className={`cta cta-${look}`}
      data-testid="primary-action"
      data-action={action}
    >
      {busy ? verifying !== null ? 'ĐANG XÁC MINH…' : 'ĐANG GHI…' : (
        <>
          <CtaIcon action={action} />
          {primary.label}
        </>
      )}
    </button>
  );
}

/**
 * GATE's flexible controls for the 5-minute window. They are authoritative
 * commands, so a pause or a restart is visible on every phone at once — and the
 * score excludes paused gaps and records resets for review.
 */
function ClockControls({ store, round, pending }: { store: LiveStore; round: Round; pending: string | null }) {
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => setConfirmReset(false), [round.game_reset_count, round.id]);
  const paused = isGamePaused(round);
  return (
    <div className="flex gap-2" data-testid="clock-controls">
      <button
        type="button"
        disabled={pending !== null}
        onClick={() => void store.act(paused ? 'GAME_RESUME' : 'GAME_PAUSE')}
        className="flex-1 rounded-[10px] border border-hair bg-panel px-2 py-2.5 text-[10px] font-semibold text-snow active:bg-panel2 disabled:opacity-50"
        data-testid="clock-pause"
      >
        {paused ? 'CHẠY LẠI 5:00' : 'TẠM DỪNG 5:00'}
      </button>
      {confirmReset ? (
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => {
            void store.act('GAME_RESET');
            setConfirmReset(false);
          }}
          className="flex-1 rounded-[10px] border border-blood/60 bg-blood/10 px-2 py-2.5 text-[10px] font-bold text-blood disabled:opacity-50"
          data-testid="clock-reset-confirm"
        >
          XÁC NHẬN RESET 5:00
        </button>
      ) : (
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => setConfirmReset(true)}
          className="flex-1 rounded-[10px] border border-hair bg-panel px-2 py-2.5 text-[10px] font-semibold text-ember active:bg-panel2 disabled:opacity-50"
          data-testid="clock-reset"
        >
          RESET 5:00
        </button>
      )}
    </div>
  );
}
