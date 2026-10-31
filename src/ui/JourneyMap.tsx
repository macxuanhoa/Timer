import { useEffect } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import type { JourneyInfo, JourneyStop } from '../client/selectors';
import { pad } from '../client/selectors';
import { ROLE_SHORT } from '../shared/constants';
import { formatWallTime } from '../shared/metrics';
import { ACCENT_HEX, STOP_ACCENT } from './accents';
import {
  CheckIcon,
  DoorIcon,
  FlagIcon,
  RoomIcon,
  RunnerIcon,
  UsersIcon,
} from './icons';

interface StripProps {
  journey: JourneyInfo;
  /** Tapping the rail opens the floor-by-floor map — it is the only entry on the dashboard. */
  onOpen?(): void;
}

const STOP_ICON: Record<JourneyStop['key'], (props: { className?: string }) => ReactElement> = {
  lobby: UsersIcon,
  gate: DoorIcon,
  hall: RunnerIcon,
  room: RoomIcon,
  end: FlagIcon,
};

/** Inline colours, because each node carries the colour of its own area. */
function nodeStyle(stop: JourneyStop): CSSProperties {
  const accent = ACCENT_HEX[STOP_ACCENT[stop.key]];
  switch (stop.state) {
    case 'lead':
      return {
        color: accent,
        backgroundColor: '#131316',
        boxShadow: `0 0 0 2.5px ${accent}, 0 0 16px -2px ${accent}`,
      };
    case 'done':
      return { color: '#fff', backgroundColor: ACCENT_HEX.red };
    case 'here':
      return { color: '#fff', backgroundColor: accent };
    default:
      return { color: '#6d6d77', backgroundColor: '#26262b' };
  }
}

/**
 * The five-stop route every phone shows: sảnh → cửa vào → hành lang → 305 →
 * kết thúc. Checked stops are red, the area the team is in or walking into wears
 * its own colour as a ring, and stops still ahead stay grey. Labels sit under the
 * nodes exactly like the five-node rail on the wall of the design.
 */
export function JourneyStepper({ journey, onOpen }: StripProps) {
  const { stops, focus } = journey;
  return (
    <div
      className="flex items-start"
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
      {stops.map((stop, i) => {
        const prev = i > 0 ? stops[i - 1] : null;
        const next = i < stops.length - 1 ? stops[i + 1] : null;
        const Icon = stop.state === 'done' ? CheckIcon : STOP_ICON[stop.key];
        return (
          <div key={stop.key} className="flex min-w-0 flex-1 flex-col items-center">
            <div className="relative flex h-[30px] w-full items-center justify-center">
              {prev ? (
                <span
                  className="absolute left-0 right-1/2 top-1/2 h-[2px] -translate-y-1/2"
                  style={{ backgroundColor: prev.state === 'done' ? ACCENT_HEX.red : '#33333a' }}
                  aria-hidden
                />
              ) : null}
              {next ? (
                <span
                  className="absolute left-1/2 right-0 top-1/2 h-[2px] -translate-y-1/2"
                  style={{ backgroundColor: stop.state === 'done' ? ACCENT_HEX.red : '#33333a' }}
                  aria-hidden
                />
              ) : null}
              <span
                className={`step-node relative ${stop.state === 'lead' ? 'step-lead' : ''}`}
                style={nodeStyle(stop)}
                data-testid={`journey-node-${stop.key}`}
                data-state={stop.state}
                data-lead={stop.state === 'lead' ? '1' : '0'}
                aria-hidden
              >
                <Icon />
              </span>
            </div>
            <p
              className={`step-label mt-1.5 text-center font-semibold uppercase tracking-[0.08em] ${
                stop.state === 'todo' ? 'text-[#6f6f78]' : 'text-snow'
              }`}
            >
              {stop.label.map((line) => (
                <span key={line} className="block">
                  {line}
                </span>
              ))}
            </p>
          </div>
        );
      })}
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
            const Icon = stop.state === 'done' ? CheckIcon : STOP_ICON[stop.key];
            return (
              <li
                key={stop.key}
                className="relative flex items-start gap-3 pb-3"
                data-testid={`journey-stop-${stop.key}`}
                data-state={stop.state}
              >
                <span className="step-node relative z-10 mt-0.5 shrink-0" style={nodeStyle(stop)} aria-hidden>
                  <Icon />
                </span>
                <div className="min-w-0 flex-1 border-b border-hair/60 pb-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="truncate text-[0.86rem] font-semibold text-snow">{stop.name}</p>
                    <span className="shrink-0 text-[0.58rem] tracking-[0.1em] text-mute">
                      {stop.floor}
                      {stop.station ? ` · ${ROLE_SHORT[stop.station]}` : ''}
                    </span>
                  </div>
                  <p className="text-[0.66rem] leading-relaxed text-mute">{describeStop(stop)}</p>
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

function describeStop(stop: JourneyStop): string {
  if (stop.state === 'lead') return 'Khu vực đội đang tới';
  if (stop.state === 'here') return 'Đội đang ở đây';
  if (stop.state === 'done') return stop.at_ms !== null ? `✓ ${formatWallTime(stop.at_ms)}` : '✓ đã qua';
  return 'Chưa tới';
}
