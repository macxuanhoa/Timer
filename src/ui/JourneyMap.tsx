import { useEffect } from 'react';
import type { ReactElement } from 'react';
import type { JourneyInfo, JourneyStop } from '../client/selectors';
import { pad } from '../client/selectors';
import { ROLE_SHORT, STOP_STATE_LABEL } from '../shared/constants';
import { formatWallTime } from '../shared/metrics';
import {
  AlertIcon,
  CheckIcon,
  DoorIcon,
  FlagIcon,
  LockIcon,
  RoomIcon,
  RunnerIcon,
  UsersIcon,
} from './icons';

interface StripProps {
  journey: JourneyInfo;
  /** Tapping the rail opens the floor-by-floor map — it is the only entry on the dashboard. */
  onOpen?(): void;
  /**
   * V3.5 — the sentence under the rail is the machine's summary of the route. On a
   * station screen the team card above already carries that sentence (the badge and
   * the status line are the same fact in the server's own words), so those screens
   * pass `caption={false}` and keep the rail as pure shape plus one tap affordance.
   * Screens without a team card — the reset checkpoint, the viewer — keep it.
   */
  caption?: boolean;
}

const STOP_ICON: Record<JourneyStop['key'], (props: { className?: string }) => ReactElement> = {
  lobby: UsersIcon,
  floor2: RunnerIcon,
  gate: DoorIcon,
  room: RoomIcon,
  end: FlagIcon,
};

/**
 * The four states the machine reports, widened to the six an operator has to tell
 * apart — all of them still derived from `resolveJourney`, never from a second
 * workflow kept in the view:
 *
 *   done      the team has been here and the press is on the record
 *   lead      the area the team is walking into right now
 *   here      the area the team is standing in
 *   waiting   a later stage, reachable once the stage before it is pressed
 *   locked    a later stage with nothing in play to reach it — no team received
 *   attention a stage the route passed through by logged exception, not by press
 *
 * Each one is a different silhouette as well as a different colour, so the state
 * survives a screen that is read in poor light or in forced-colours mode.
 */
function viewState(stop: JourneyStop, hasRound: boolean): string {
  if (stop.attention) return 'attention';
  if (stop.state === 'todo') return hasRound ? 'todo' : 'locked';
  return stop.state;
}

function StateIcon({ state, Icon }: { state: string; Icon: (props: { className?: string }) => ReactElement }) {
  if (state === 'done') return <CheckIcon />;
  if (state === 'locked') return <LockIcon />;
  if (state === 'attention') return <AlertIcon />;
  return <Icon />;
}

/**
 * The five-stop route every phone shows: sảnh tầng 1 → tầng 2 → cửa vào tầng 3 →
 * phòng 305 → kết thúc. Passing `onOpen` makes the rail a button that reveals the
 * floor map; without it the rail is pure status, which is all an observer may have.
 *
 * V3.4 rebuilt it as a readable route rather than five small circles: the rail
 * fills to the stage the team has actually reached, the active stage carries its
 * state as a word, and the caption underneath is the machine's own one-line
 * summary — the same sentence on every device.
 */
export function JourneyStepper({ journey, onOpen, caption = true }: StripProps) {
  const { stops, focus } = journey;
  const hasRound = journey.team_number !== null;
  const reached = Math.max(0, Math.min(stops.length - 1, focus));
  const railPct = (reached / Math.max(1, stops.length - 1)) * 100;
  return (
    <div className="stepper-wrap">
      <div
        className="stepper"
        data-testid="journey-strip"
        data-position={journey.position}
        data-focus={focus}
        data-movement={journey.movement}
        role={onOpen ? 'button' : undefined}
        tabIndex={onOpen ? 0 : undefined}
        aria-label={onOpen ? `Hành trình: ${journey.caption}. Mở sơ đồ từng tầng` : undefined}
        onClick={onOpen}
        onKeyDown={
          onOpen
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpen();
                }
              }
            : undefined
        }
      >
        <span className="stepper-rail" aria-hidden>
          <span style={{ width: `${railPct}%` }} />
        </span>
        {stops.map((stop, i) => {
          const state = viewState(stop, hasRound);
          const Icon = STOP_ICON[stop.key];
          return (
            <div key={stop.key} className="stepper-item" data-testid={`journey-step-${stop.key}`}>
              <span
                className={`step-node${state === 'lead' ? ' step-lead' : ''}`}
                data-state={state}
                data-testid={`journey-node-${stop.key}`}
                data-lead={stop.state === 'lead' ? '1' : '0'}
                aria-hidden
              >
                <StateIcon state={state} Icon={Icon} />
              </span>
              <p className="step-label" data-state={state}>
                {stop.label.map((line) => (
                  <span key={line} className="block">
                    {line}
                  </span>
                ))}
              </p>
              {i === focus || state === 'attention' ? (
                <span className="step-state" data-state={state} data-testid={`journey-state-${stop.key}`}>
                  {STOP_STATE_LABEL[state]}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
      {/* The machine's own one-line summary of the route, where nothing else on the
          screen carries it. The tap affordance is the same on every phone: three
          words in the corner of the rail, never a second sentence. */}
      {(caption || onOpen) && (
        <p className={`stepper-caption${caption ? '' : ' is-affordance'}`} data-testid={caption ? 'journey-caption' : undefined}>
          {caption ? journey.caption : null}
          {onOpen ? <span className="stepper-more">SƠ ĐỒ ›</span> : null}
        </p>
      )}
    </div>
  );
}

interface BoardProps {
  journey: JourneyInfo;
  onClose(): void;
}

/** The same route, floor by floor, with the real server time of every press. */
export function JourneyBoard({ journey, onClose }: BoardProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const rows = [...journey.stops].reverse();
  const turn = journey.turn;

  return (
    <div
      className="safe-top safe-bottom fixed inset-0 z-50 flex flex-col bg-ink"
      role="dialog"
      aria-modal="true"
      aria-label="Sơ đồ hành trình"
      data-testid="journey-board"
      data-movement={journey.movement}
      data-position={journey.position}
      data-focus={journey.focus}
    >
      <header className="flex items-start justify-between gap-3 border-b border-hair px-4 py-3">
        <div className="min-w-0">
          <p className="text-[0.6rem] tracking-[0.22em] text-blood">SƠ ĐỒ HÀNH TRÌNH</p>
          <p className="truncate text-[0.95rem] font-semibold text-snow">
            {journey.team_number === null ? `ĐỘI #${pad(journey.next_team_number)} · ĐỘI KẾ TIẾP` : `ĐỘI #${pad(journey.team_number)}`}
            {journey.team_name ? <span className="text-mute"> · {journey.team_name}</span> : null}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          autoFocus
          className="shrink-0 rounded-[10px] border border-hair bg-panel px-3 py-2 text-[0.72rem] text-snow active:bg-panel2"
          data-testid="journey-close"
        >
          ĐÓNG
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mb-3">
          <p className="text-[0.72rem] tracking-[0.16em] text-mute" data-testid="journey-where">
            {journey.where}
          </p>
        </div>

        <ol className="relative">
          <span className="absolute bottom-4 left-[14px] top-4 w-px bg-hair" aria-hidden />
          {rows.map((stop) => {
            const state = viewState(stop, journey.team_number !== null);
            return (
              <li
                key={stop.key}
                className="relative flex items-start gap-3 pb-3"
                data-testid={`journey-stop-${stop.key}`}
                data-state={state}
              >
                <span className="step-node relative z-10 mt-0.5 shrink-0" data-state={state} aria-hidden>
                  <StateIcon state={state} Icon={STOP_ICON[stop.key]} />
                </span>
                <div className="min-w-0 flex-1 border-b border-hair/60 pb-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="truncate text-[0.86rem] font-semibold text-snow">{stop.name}</p>
                    <span className="shrink-0 text-[0.58rem] tracking-[0.1em] text-mute">
                      {stop.floor}
                      {stop.station ? ` · ${ROLE_SHORT[stop.station]}` : ''}
                    </span>
                  </div>
                  <p className="text-[0.66rem] leading-relaxed text-mute">{describeStop(stop, state)}</p>
                  {stop.note ? <p className="text-[0.64rem] leading-relaxed text-snow/70">{stop.note}</p> : null}
                </div>
              </li>
            );
          })}
        </ol>

        <div className="mt-2 rounded-[12px] border border-hair bg-panel px-3 py-3" data-testid="journey-turn" data-mine={turn?.mine ? '1' : '0'}>
          <p className="text-[0.55rem] tracking-[0.2em] text-mute">NHỊP KẾ TIẾP</p>
          <p className="text-[0.9rem] font-bold text-snow">
            {turn
              ? `${turn.mine ? 'ĐẾN LƯỢT BẠN' : `ĐẾN LƯỢT ${turn.roles.map((r) => ROLE_SHORT[r]).join(' · ')}`} · ${turn.label}`
              : 'KHÔNG CẦN BẤM'}
          </p>
        </div>

        {journey.tasks.length > 0 && (
          <div className="mt-3 rounded-[12px] border border-hair bg-panel px-3 py-2" data-testid="journey-tasks">
            <p className="mb-1 text-[0.55rem] tracking-[0.2em] text-mute">RESET KHU VỰC</p>
            {journey.tasks.map((task) => (
              <div key={task.key} className="flex items-baseline justify-between gap-2 border-b border-hair/50 py-1 last:border-0">
                <span className="text-[0.68rem] text-snow/85">{task.label}</span>
                <span className={`text-[0.62rem] font-semibold ${task.done ? 'text-jade' : 'text-ember'}`}>
                  {task.done ? '✓ XONG' : `chờ ${ROLE_SHORT[task.role]}`}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function describeStop(stop: JourneyStop, state: string): string {
  if (state === 'attention') return 'Bỏ qua có ghi nhật ký — không phải xác nhận tại tầng 2';
  if (stop.state === 'lead') return 'Khu vực đội đang tới';
  if (stop.state === 'here') return 'Đội đang ở đây';
  if (stop.state === 'done') return stop.at_ms !== null ? `Đã qua lúc ${formatWallTime(stop.at_ms)}` : 'Đã qua';
  return state === 'locked' ? 'Chưa mở — chưa có đội nào trên sàn' : 'Chưa tới';
}
