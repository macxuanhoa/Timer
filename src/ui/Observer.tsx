import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { LiveStore } from '../client/liveStore';
import type { StoredSession } from './session';
import { isLockedPhase, pad, phaseOf, resolveBigScreen, resolveCountdown, resolveJourney, resolveTeamLine } from '../client/selectors';
import { PHASE_LABEL, OBSERVER_CAPACITY } from '../shared/constants';
import { formatClockSec, leaderboard } from '../shared/metrics';
import { useNow, useWakeLock } from './hooks';
import { watchPresence, observerLeave, type PresenceResult } from '../client/observerPresence';
import { JourneyStepper } from './JourneyMap';
import { countdownStageOf, countdownToneOf } from './countdown';
import { TimeDigits } from './TimeView';
import { RunnerIcon, TrophyIcon, UsersIcon } from './icons';

interface Props {
  store: LiveStore;
  account: StoredSession['account'];
  token: string;
  onLogout(): Promise<void>;
}

/**
 * The observer view: NPC scare actors, crew and organisers watching the floor.
 *
 * It is read-only by construction — this component renders no control that can
 * change state, and the server independently refuses every command from an
 * OBSERVER binding, so nothing here needs to be trusted to stay honest.
 */
export function Observer({ store, token, onLogout }: Props) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const snap = state.snapshot;
  const [presence, setPresence] = useState<PresenceResult | null>(null);
  const phase = snap ? phaseOf(snap, store.serverNow()) : 'PRE_EVENT';
  const now = useNow(store, isLockedPhase(phase) ? 'raf' : 'slow');
  const countdown = useMemo(() => (snap ? resolveCountdown(snap, now) : null), [snap, now]);
  const wall = useMemo(() => (snap ? resolveBigScreen(snap, now) : null), [snap, now]);
  const teamLine = useMemo(() => (snap ? resolveTeamLine(snap, now) : null), [snap, now]);
  const journey = useMemo(() => (snap ? resolveJourney(snap, now, 'OBSERVER') : null), [snap, now]);
  const rows = useMemo(() => (snap ? leaderboard(snap) : []), [snap]);
  const full = presence !== null && presence.ok === false && presence.code === 'OBSERVER_FULL';

  // A viewer's screen must stay lit too, but only while it is actually watching.
  useWakeLock(!full);

  useEffect(() => {
    if (full) return;
    return watchPresence(token, setPresence);
  }, [token, full]);

  if (full) {
    return (
      <div className="flex h-[100dvh] flex-col items-center justify-center gap-3 bg-ink px-6 text-center" data-testid="observer-full">
        <p className="text-[15px] font-extrabold tracking-[0.06em] text-blood">SCREAM CONTROL</p>
        <p className="text-[13px] font-semibold text-snow" data-testid="observer-full-message">
          Đã đủ {OBSERVER_CAPACITY} người xem.
        </p>
        <p className="text-[11px] leading-snug text-mute">
          Tự vào lại khi có chỗ trống.
        </p>
        <button
          type="button"
          onClick={() => setPresence(null)}
          className="mt-2 min-h-11 rounded-[10px] border border-hair bg-panel px-4 text-[11px] font-semibold text-snow active:bg-panel2"
          data-testid="observer-retry"
        >
          THỬ LẠI
        </button>
      </div>
    );
  }

  if (!snap || !countdown || !teamLine) {
    return (
      <div className="flex h-[100dvh] items-center justify-center bg-ink text-mute" data-testid="observer-booting">
        <div className="text-center">
          <p className="text-lg font-extrabold tracking-[0.18em] text-blood">SCREAM ROOM 305</p>
          <p className="mt-3 text-sm">{state.status === 'OFFLINE' ? 'ĐANG THỬ LẠI KẾT NỐI…' : 'ĐANG ĐỒNG BỘ…'}</p>
        </div>
      </div>
    );
  }

  const round = snap.active_round;
  const running = isLockedPhase(phase);
  // V3.4 §4: the viewer reads the same stage decision as the phone and the wall.
  // It used to keep a private colour table whose "running" entry was the V3.2
  // jade — one instant, three surfaces, two answers. There is now one answer.
  const stage = countdownStageOf(countdown);
  const tone = countdownToneOf(countdown);
  // V3.4.1 — the hero prints the round's own status line whenever there is a
  // round to time. The team card's phase word was that same sentence again, in
  // grey, one block above: “LƯỢT CHƠI ĐANG CHẠY” over “● ĐANG CHẠY 05:00”. The
  // card keeps it only for the waiting state, where the hero shows no status line
  // at all and the phase is the one fact the card carries.
  const heroCarriesClock = running || wall !== null;

  return (
    <div className="flex h-[100dvh] flex-col bg-ink" data-testid="observer" data-phase={phase}>
      <header className="safe-top flex items-start justify-between gap-2 px-3 pb-2.5">
        <div>
          <p className="text-[15px] font-extrabold leading-none tracking-[0.01em] text-blood">SCREAM ROOM 305</p>
          <p className="mt-1.5 flex items-center gap-1.5 text-[8.5px] font-semibold tracking-[0.1em] text-mute">
            <span>TRỰC TIẾP</span>
            <span className="text-hair">•</span>
            <span data-testid="observer-seats">{presence?.devices ?? 0}/{presence?.capacity ?? OBSERVER_CAPACITY} Đang xem</span>
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {/* The dot has to agree with the word beside it. It used to be blood-red
              for "Đang theo dõi" AND for "Mất kết nối" — one colour meaning two
              opposite things — and the operator screens already settled that
              argument: jade live, ember syncing, blood failed. */}
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              state.status === 'CONNECTED' ? 'bg-jade' : state.status === 'SYNCING' ? 'bg-ember breathe' : 'bg-blood'
            }`}
            aria-hidden
            data-testid="observer-dot"
            data-status={state.status}
          />
          <span data-testid="observer-connection" data-status={state.status} className="text-[9px] font-semibold tracking-[0.1em] text-mute">
            {state.status === 'CONNECTED' ? 'Đang theo dõi' : state.status === 'OFFLINE' ? 'Mất kết nối' : 'Đang đồng bộ'}
          </span>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col justify-evenly gap-3 overflow-y-auto px-3 pb-2">
        <section className="card tm-card" data-testid="observer-team">
          <h1 className="digital team-digits font-bold text-snow">ĐỘI #{pad(round?.team_number ?? snap.event.next_team_number)}</h1>
          {/* V3.4.1: the line under the number spelled the same team number out a
              second time (“Đội #001 · Ma Tro”). The viewer now reads the label, or
              nothing at all, and the phase word is said once — by the hero when it
              has a clock, by the card when it does not. */}
          {round?.team_name ? (
            <p className="mt-2 flex items-center gap-1.5 text-[13px] font-semibold leading-none text-snow/85">
              <UsersIcon className="h-4 w-4" />
              {round.team_name}
            </p>
          ) : null}
          {!heroCarriesClock ? (
            <p className="mt-1.5 text-[11px] leading-snug text-mute" data-testid="observer-phase">
              {PHASE_LABEL[phase] ?? phase}
            </p>
          ) : null}
        </section>

        <section className="flex flex-1 flex-col items-center justify-center" data-testid="observer-hero">
          {running || wall ? (
            <>
              <p className="text-[9px] font-semibold tracking-[0.16em] text-mute">{countdown.heroLabel}</p>
              <TimeDigits mm={countdown.mm} ss={countdown.ss} cs={countdown.cs} stage={stage} mode={countdown.mode} variant="observer" />
              <p className="mt-2 text-[10px] font-semibold tracking-[0.14em]" style={{ color: tone }} data-testid="observer-status">
                {countdown.statusLine}
              </p>
            </>
          ) : (
            <>
              <RunnerIcon className="h-10 w-10 text-ember" />
              <p className="mt-2 text-[13px] font-bold tracking-[0.1em] text-snow" data-testid="observer-waiting">
                {teamLine.text}
              </p>
              {/* V3.4.1: the phase word under it was the team card's third line. */}
            </>
          )}
        </section>

        <section className="flex flex-col gap-1" data-testid="observer-journey">
          {/* No onOpen: a viewer gets the status rail, never the interactive map.
              The card above already says which stage the floor is in. */}
          {journey && <JourneyStepper journey={journey} caption={false} />}
        </section>

        {/* V3.4.1: the result band and the “đã rời khu vực” line both restated what
            the hero's own status line says, in the same colour, on the same screen.
            The official number stays on the board below. */}
        {rows.length > 0 && (
          <section className="rounded-[12px] border border-hair bg-panel px-3 py-2" data-testid="observer-board">
            <p className="flex items-center gap-2 text-[8.5px] font-semibold tracking-[0.12em] text-mute">
              <TrophyIcon className="h-3.5 w-3.5 text-ember" />
              KỶ LỤC TỐI NAY
            </p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {rows.slice(0, 5).map((r) => (
                <li key={r.round_id} className="flex items-center justify-between text-[11px]" data-testid={`observer-board-${r.rank}`}>
                  <span className="text-mute">#{r.rank} · {r.team_name ? r.team_name : `Đội ${pad(r.team_number)}`}</span>
                  <span className="digital text-snow">{formatClockSec(r.duration_ms)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>

      <footer className="safe-bottom flex items-center justify-between gap-2 border-t border-hair px-3 pt-2 pb-2">
        <p className="text-[9px] font-semibold tracking-[0.1em] text-mute">CHỈ XEM</p>
        <button
          type="button"
          onClick={() => { void observerLeave(token); void onLogout(); }}
          className="min-h-9 rounded-[9px] border border-hair bg-panel px-3 text-[10.5px] font-semibold text-snow/90 active:bg-panel2"
          data-testid="observer-leave"
        >
          THOÁT XEM
        </button>
      </footer>
    </div>
  );
}
