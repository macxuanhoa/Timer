import { resolveStations, type StationInfo } from '../client/selectors';
import type { Role } from '../shared/constants';
import type { Snapshot } from '../shared/types';

interface Props {
  snap: Snapshot;
  now: number;
  /** This phone's own station, so an operator can find itself without reading the header. */
  self?: Role;
  /** 'wall' is for the TV/projector view, where the chips must read across a room. */
  size?: 'phone' | 'wall';
  className?: string;
}

const CHIP: Record<StationInfo['state'], string> = {
  active: 'border-jade/60 bg-jade/15 text-jade',
  idle: 'border-hair/70 bg-panel/30 text-mute',
};

const DOT: Record<StationInfo['state'], string> = {
  active: 'bg-jade',
  idle: 'bg-hair',
};

const SIZE = {
  phone: { chip: 'gap-0.5 px-1 py-1.5', dot: 'h-1 w-1', text: 'text-[0.56rem]' },
  wall: { chip: 'gap-1 px-2 py-2', dot: 'h-2 w-2', text: 'text-[clamp(0.7rem,1.1vw,1.1rem)]' },
} as const;

function describe(s: StationInfo): string {
  if (s.state === 'active') return s.turn ? `${s.label} — đang giữ lượt, đến lượt bấm` : `${s.label} — đang giữ lượt`;
  return s.turn ? `${s.label} — chờ, đến lượt bấm` : `${s.label} — chờ`;
}

/**
 * Five-station handoff strip, readable from every phone in the room: the jade chip
 * is the leg the team is on (LOBBY while they walk up, NPC 1 while the 5:00 runs),
 * all the others stay grey, and a pale pulsing ring marks whoever must press next
 * right now. Reset is the only window where several chips light up at once.
 */
export function StationStrip({ snap, now, self, size = 'phone', className = '' }: Props) {
  const stations = resolveStations(snap, now);
  const s = SIZE[size];
  return (
    <div
      className={`flex items-stretch gap-1 ${className}`}
      role="list"
      aria-label="Trạng thái năm trạm"
      data-testid="station-strip"
    >
      {stations.map((station) => (
        <div
          key={station.role}
          role="listitem"
          aria-label={describe(station)}
          data-testid={`station-${station.role.toLowerCase()}`}
          data-state={station.state}
          data-turn={station.turn ? '1' : '0'}
          data-self={self === station.role ? '1' : '0'}
          className={`flex min-w-0 flex-1 items-center justify-center rounded-panel border ${s.chip} ${
            CHIP[station.state]
          } ${station.turn ? 'turn-pulse' : ''}`}
        >
          <span className={`shrink-0 rounded-full ${s.dot} ${DOT[station.state]}`} aria-hidden />
          <span
            className={`truncate tracking-[0.02em] ${s.text} ${
              self === station.role ? 'font-bold' : 'font-semibold'
            }`}
          >
            {station.label}
          </span>
        </div>
      ))}
    </div>
  );
}
