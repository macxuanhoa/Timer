import type { JourneyStopDef, Role } from '../shared/constants';
import type { TeamTone } from '../client/selectors';

/**
 * One accent per station and per area, exactly as the four-screen design uses
 * them: the header pill wears the station colour, while the stepper ring and the
 * status dot wear the colour of the area the team is in.
 */
export type Accent = 'red' | 'green' | 'amber' | 'blue' | 'violet' | 'slate';

export const ACCENT_HEX: Record<Accent, string> = {
  red: '#e1362c',
  green: '#1fb96e',
  amber: '#f0a12a',
  blue: '#3b82f6',
  violet: '#a855f7',
  slate: '#7c7c86',
};

/** Station colours: the role pill in the header. */
export const ROLE_ACCENT: Record<Role, Accent> = {
  LOBBY: 'red',
  GATE: 'amber',
  CORRIDOR: 'blue',
  ROOM305: 'violet',
  SUPERVISOR: 'slate',
};

/** Area colours: the stepper ring and the status dot under it. */
export const STOP_ACCENT: Record<JourneyStopDef['key'], Accent> = {
  lobby: 'red',
  gate: 'red',
  hall: 'blue',
  room: 'violet',
  end: 'slate',
};

/** Team-line colours (amber while moving, green while playing, violet in 305…). */
export const TEAM_TONE_HEX: Record<TeamTone, string> = {
  red: ACCENT_HEX.red,
  green: ACCENT_HEX.green,
  amber: ACCENT_HEX.amber,
  blue: ACCENT_HEX.blue,
  violet: ACCENT_HEX.violet,
  mute: '#8b8b94',
};
