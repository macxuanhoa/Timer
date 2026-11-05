import type { SVGProps } from 'react';

/**
 * Hand-drawn 24px icon set for the operator screens: stroke icons inherit the
 * text colour, filled icons (play / check / bars) are solid so they read across a
 * room. No icon font, no network dependency — everything ships with the PWA.
 */
type IconProps = SVGProps<SVGSVGElement>;

const stroke = (props: IconProps) => ({
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  ...props,
});

const filled = (props: IconProps) => ({
  viewBox: '0 0 24 24',
  fill: 'currentColor',
  'aria-hidden': true,
  ...props,
});

export function HourglassIcon({ className = 'h-4 w-4', ...rest }: IconProps) {
  return (
    <svg {...stroke({ className, ...rest })}>
      <path d="M7 3h10M7 21h10" />
      <path d="M8 3c0 4.5 8 5.5 8 9s-8 4.5-8 9" />
      <path d="M16 3c0 4.5-8 5.5-8 9s8 4.5 8 9" />
    </svg>
  );
}

export function UsersIcon({ className = 'h-4 w-4', ...rest }: IconProps) {
  return (
    <svg {...filled({ className, ...rest })}>
      <circle cx="9" cy="8" r="3" />
      <circle cx="16.2" cy="9" r="2.3" />
      <path d="M2.4 19c0-3.2 2.9-5.4 6.6-5.4s6.6 2.2 6.6 5.4v.6H2.4z" />
      <path d="M16.4 13.7c3 .2 5.2 2.1 5.2 4.7v1.2h-3.1v-.6c0-2-.8-3.7-2.1-5.3z" />
    </svg>
  );
}

export function PencilIcon({ className = 'h-4 w-4', ...rest }: IconProps) {
  return (
    <svg {...stroke({ className, ...rest })}>
      <path d="M4 20h4L19 9l-4-4L4 16v4z" />
      <path d="m15 5 4 4" />
    </svg>
  );
}

export function ClockIcon({ className = 'h-4 w-4', ...rest }: IconProps) {
  return (
    <svg {...stroke({ className, ...rest })}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

export function ChevronDownIcon({ className = 'h-4 w-4', ...rest }: IconProps) {
  return (
    <svg {...stroke({ className, ...rest })}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function ChevronRightIcon({ className = 'h-4 w-4', ...rest }: IconProps) {
  return (
    <svg {...stroke({ className, ...rest })}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export function GearIcon({ className = 'h-4 w-4', ...rest }: IconProps) {
  return (
    <svg {...stroke({ className, ...rest })}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
    </svg>
  );
}

/** The double chevron the lobby phone shows while the team walks up. */
export function ArrowUpIcon({ className = 'h-4 w-4', ...rest }: IconProps) {
  return (
    <svg {...stroke({ className, strokeWidth: 2.6, ...rest })}>
      <path d="m6 13 6-6 6 6" />
      <path d="m6 19 6-6 6 6" />
    </svg>
  );
}

export function PlayIcon({ className = 'h-4 w-4', ...rest }: IconProps) {
  return (
    <svg {...filled({ className, ...rest })}>
      <path d="M8 5.2c0-.9 1-1.4 1.7-.9l9 6.8c.6.5.6 1.3 0 1.8l-9 6.8c-.7.5-1.7 0-1.7-.9z" />
    </svg>
  );
}

export function CheckIcon({ className = 'h-4 w-4', ...rest }: IconProps) {
  return (
    <svg {...stroke({ className, strokeWidth: 2.8, ...rest })}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/** The refusal half of a verification decision, mirrored against CheckIcon. */
export function CrossIcon({ className = 'h-4 w-4', ...rest }: IconProps) {
  return (
    <svg {...stroke({ className, strokeWidth: 2.8, ...rest })}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

export function StopIcon({ className = 'h-4 w-4', ...rest }: IconProps) {
  return (
    <svg {...filled({ className, ...rest })}>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
    </svg>
  );
}

export function TrophyIcon({ className = 'h-4 w-4', ...rest }: IconProps) {
  return (
    <svg {...stroke({ className, ...rest })}>
      <path d="M7 4h10v5a5 5 0 0 1-10 0z" />
      <path d="M7 5.5H4.8A1.8 1.8 0 0 0 3 7.3C3 9.4 4.7 11 6.8 11H7" />
      <path d="M17 5.5h2.2A1.8 1.8 0 0 1 21 7.3C21 9.4 19.3 11 17.2 11H17" />
      <path d="M12 14v3.5M8.5 20.5h7M10 17.5h4" />
    </svg>
  );
}

export function BarsIcon({ className = 'h-4 w-4', ...rest }: IconProps) {
  return (
    <svg {...filled({ className, ...rest })}>
      <rect x="4" y="12" width="3.4" height="8" rx="1" />
      <rect x="10.3" y="7" width="3.4" height="13" rx="1" />
      <rect x="16.6" y="3.5" width="3.4" height="16.5" rx="1" />
    </svg>
  );
}

export function DoorIcon({ className = 'h-4 w-4', ...rest }: IconProps) {
  return (
    <svg {...stroke({ className, ...rest })}>
      <path d="M5 21V4.5A1.5 1.5 0 0 1 6.5 3h11A1.5 1.5 0 0 1 19 4.5V21" />
      <path d="M3.5 21h17" />
      <path d="M14.5 12h.01" />
    </svg>
  );
}

/** The hallway leg: a figure running through it. */
export function RunnerIcon({ className = 'h-4 w-4', ...rest }: IconProps) {
  return (
    <svg {...stroke({ className, ...rest })}>
      <circle cx="15.5" cy="4.8" r="2" />
      <path d="M13.8 8.4 10 10.6l-2.6 2.9" />
      <path d="m11.4 10.2 3.2 2.1 1.9 3.1" />
      <path d="m7.4 13.5-2 3.4 1.6 3.4" />
      <path d="m13 14.6-2.6 2.3 1.4 3.4" />
    </svg>
  );
}

/** Room 305: the puzzle sheet inside the room. */
export function RoomIcon({ className = 'h-4 w-4', ...rest }: IconProps) {
  return (
    <svg {...stroke({ className, ...rest })}>
      <rect x="5" y="3.5" width="14" height="17" rx="2" />
      <path d="M8.5 8h7M8.5 12h7M8.5 16h4" />
    </svg>
  );
}

export function FlagIcon({ className = 'h-4 w-4', ...rest }: IconProps) {
  return (
    <svg {...stroke({ className, ...rest })}>
      <path d="M5.5 21V4" />
      <path d="M5.5 4.6h10.8l-2 3.4 2 3.4H5.5z" />
    </svg>
  );
}

/**
 * The secret peek pair. The open eye is shown while the value is hidden ("tap to
 * see"), the barred eye while it is visible ("tap to hide"), so the icon always
 * names the next action rather than the current state.
 */
export function EyeIcon({ className = 'h-4 w-4', ...rest }: IconProps) {
  return (
    <svg {...stroke({ className, ...rest })}>
      <path d="M2.6 12S6 5.8 12 5.8 21.4 12 21.4 12 18 18.2 12 18.2 2.6 12 2.6 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function EyeOffIcon({ className = 'h-4 w-4', ...rest }: IconProps) {
  return (
    <svg {...stroke({ className, ...rest })}>
      <path d="M4 4l16 16" />
      <path d="M9.7 6A9.7 9.7 0 0 1 12 5.8c6 0 9.4 6.2 9.4 6.2a17.4 17.4 0 0 1-3.4 4.1" />
      <path d="M6.3 7.9A16.9 16.9 0 0 0 2.6 12S6 18.2 12 18.2c1.5 0 2.9-.4 4.1-1" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </svg>
  );
}

/**
 * V3.4 state glyphs. The stepper and the connection chip must read their state
 * from the SHAPE as well as the colour, so each of these is a distinct silhouette
 * rather than a variation on the same outline.
 */

/** A stage this phone is not allowed to reach yet. */
export function LockIcon({ className = 'h-4 w-4', ...rest }: IconProps) {
  return (
    <svg {...stroke({ className, ...rest })}>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
      <path d="M8.2 10.5V8a3.8 3.8 0 0 1 7.6 0v2.5" />
    </svg>
  );
}

/** Something here needs a decision — a logged exception, a stall, a lost link. */
export function AlertIcon({ className = 'h-4 w-4', ...rest }: IconProps) {
  return (
    <svg {...stroke({ className, ...rest })}>
      <path d="M12 4.2 21 19.4H3z" />
      <path d="M12 9.6v4.2" />
      <path d="M12 16.6h.01" />
    </svg>
  );
}

/** The live link. Bars, so a weak signal can be shown as fewer of them. */
export function SignalIcon({ className = 'h-4 w-4', ...rest }: IconProps) {
  return (
    <svg {...filled({ className, ...rest })}>
      <rect x="3" y="14" width="3.2" height="6" rx="1" />
      <rect x="8.4" y="10" width="3.2" height="10" rx="1" />
      <rect x="13.8" y="6" width="3.2" height="14" rx="1" />
      <rect x="19.2" y="3" width="1.8" height="17" rx="0.9" opacity="0.45" />
    </svg>
  );
}

/** The link is gone: the same silhouette, struck through. */
export function SignalOffIcon({ className = 'h-4 w-4', ...rest }: IconProps) {
  return (
    <svg {...stroke({ className, strokeWidth: 2.4, ...rest })}>
      <path d="M4 20V15M9 20v-6M14 20V9" />
      <path d="M3 3l18 18" />
    </svg>
  );
}

/** The lantern. Marks the spotlight side of a card, and the running clock. */
export function FlameIcon({ className = 'h-4 w-4', ...rest }: IconProps) {
  return (
    <svg {...stroke({ className, ...rest })}>
      <path d="M12 3.2c3.4 3.6 5.6 6 5.6 9.1A5.6 5.6 0 0 1 12 20.8a5.6 5.6 0 0 1-5.6-8.5c1-1.6 2.2-2.3 2.6-4 1.4 1.3 2 2.4 2.2 3.7.6-2.4 1.4-5.4.6-8.8z" />
    </svg>
  );
}

/** V3.4 picker: the floor-2 stairwell — the climb between the two handovers. */
export function StairsIcon({ className = 'h-4 w-4', ...rest }: IconProps) {
  return (
    <svg {...stroke({ className, ...rest })}>
      <path d="M4 20h4v-4h4v-4h4V8h4" />
      <path d="M4 20v-1" />
    </svg>
  );
}

/** V3.4 picker: the place marker on a card's location line. */
export function PinIcon({ className = 'h-4 w-4', ...rest }: IconProps) {
  return (
    <svg {...stroke({ className, ...rest })}>
      <path d="M12 21s-6.5-5.6-6.5-10.2A6.5 6.5 0 0 1 12 4.3a6.5 6.5 0 0 1 6.5 6.5C18.5 15.4 12 21 12 21z" />
      <circle cx="12" cy="10.6" r="2.2" />
    </svg>
  );
}

/** Records, rounds and rankings: the reporting destination. */
export function ReportIcon({ className = 'h-4 w-4', ...rest }: IconProps) {
  return (
    <svg {...stroke({ className, ...rest })}>
      <rect x="4" y="3.5" width="16" height="17" rx="2" />
      <path d="M8 16.5v-3M12 16.5v-6M16 16.5v-4" />
    </svg>
  );
}

