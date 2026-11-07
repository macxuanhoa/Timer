import type { Role } from '../shared/constants';
import type { TeamTone } from '../client/selectors';

/**
 * V3.3 horror-event palette. The V3.2 accents read corporate: a bright jade
 * "success" green sat next to a plain blue and violet, and the countdown's
 * jade digits looked like a stopwatch, not a Room 305 night run.
 *
 * The new accents stay legible on a phone at arm's length, but the semantic
 * mapping is the operator's own vocabulary — bone-amber for "seat ready",
 * ember for "attention", blood for "danger", and cooler bone tones for the
 * stations that own a room. Every hue is anchored to the poster's warm light
 * against black: no neon, no corporate blue.
 *
 * The token names (red / green / amber / blue / violet / slate) stay identical
 * so nothing outside this file has to rename its meaning: `green` becomes the
 * "ready" bone-amber rather than jade. Callers that read the semantic word
 * keep working; the surface shifts.
 */
type Accent = 'red' | 'green' | 'amber' | 'blue' | 'violet' | 'slate';

export const ACCENT_HEX: Record<Accent, string> = {
  /** Danger / blood / OPERATOR_01 (the door team). Deep crimson, still readable
      against ink-900 in a darkened room. */
  red: '#e2483d',
  /** Ready / success / a seat a phone can claim. Bone-amber, not jade — the
      lantern glow from the poster rather than a positive-state green. */
  green: '#e6b877',
  /** Warning / attention / NPC1 (the gate). Ember. */
  amber: '#f4893a',
  /** OPERATOR_02 (floor 2). Cool slate-teal, still legible next to ember. */
  blue: '#5a9cab',
  /** NPC2 (room 305). Deep amethyst. */
  violet: '#a26cd9',
  /** Supervisor / system. Ash-grey, never neon. */
  slate: '#a5a5b0',
};

/** Station colours: the role pill in the header. */
export const ROLE_ACCENT: Record<Role, Accent> = {
  LOBBY: 'red',
  CORRIDOR: 'blue',
  GATE: 'amber',
  ROOM305: 'violet',
  SUPERVISOR: 'slate',
  OBSERVER: 'green',
};

/** Team-line colours. Same mapping as the station accents. */
export const TEAM_TONE_HEX: Record<TeamTone, string> = {
  red: ACCENT_HEX.red,
  green: ACCENT_HEX.green,
  amber: ACCENT_HEX.amber,
  blue: ACCENT_HEX.blue,
  violet: ACCENT_HEX.violet,
  mute: '#8b8b94',
};

/**
 * The countdown's own colours. Kept separate from ACCENT_HEX because the digits
 * carry their own semantics: the running clock needs a hot, cinematic glow that
 * shifts as the round ends. Never green — jade was the V3.2 misstep the
 * operator feedback called out directly.
 */
export const COUNTDOWN_TONE: Record<'ok' | 'warn' | 'danger' | 'frozen', string> = {
  ok: '#f4893a',
  warn: '#ffb445',
  danger: '#e2483d',
  frozen: '#e6b877',
};
