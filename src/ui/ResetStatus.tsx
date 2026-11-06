import { useState } from 'react';
import type { ReactElement } from 'react';
import type { AttemptRow, ReadinessView, ResetBoard, ResetRow, ResultSummary } from '../client/selectors';
import { pad } from '../client/selectors';
import { type ResetTaskKey, type Role } from '../shared/constants';
import { formatClockCs, formatWallTime } from '../shared/metrics';
import {
  AlertIcon,
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  CrossIcon,
  HourglassIcon,
  PinIcon,
  RoomIcon,
  StairsIcon,
} from './icons';

/**
 * V3.4 — the post-round reset surface, shared by every phone that watches or
 * works the floor-3 checklist.
 *
 * Three rules shape everything in this file, and they are the rules the
 * authoritative layer already enforces:
 *
 *   1. A completed round is presented as finished. The next round's window is
 *      only ever labelled as the next round's, never shown as if it belonged to
 *      the team that just left.
 *   2. Every status comes from the stored checklist row (`completed_at` and the
 *      round's `reset_cycle`) or from this phone's own unacknowledged write. No
 *      component here can mark an area ready, release a seat, open an event or
 *      start a countdown — those are separate operations with separate
 *      permissions, and they stay separate on screen.
 *   3. The official result is only ever echoed, never recalculated, and the
 *      attempt history is only ever folded away, never deleted.
 */

/** The physical area a reset row belongs to, drawn as a shape, not a colour. */
const AREA_ICON: Record<ResetTaskKey, (props: { className?: string }) => ReactElement> = {
  hallway: StairsIcon,
  hidden_objects: PinIcon,
  room: RoomIcon,
};

/** The badge tone per state; the word always agrees with the shape and the tone. */
const ROW_TONE: Record<ResetRow['state'], 'confirmed' | 'live' | 'danger' | 'queued'> = {
  done: 'confirmed',
  submitting: 'live',
  failed: 'danger',
  reopened: 'live',
  open: 'queued',
};

function RowMark({ row }: { row: ResetRow }) {
  if (row.state === 'done') return <CheckIcon className="h-4 w-4" />;
  if (row.state === 'failed') return <CrossIcon className="h-4 w-4" />;
  if (row.state === 'submitting') return <HourglassIcon className="h-4 w-4" />;
  if (row.state === 'reopened') return <AlertIcon className="h-4 w-4" />;
  const Icon = AREA_ICON[row.key] ?? ClockIcon;
  return <Icon className="h-4 w-4" />;
}

/**
 * The three responsibilities of one physical reset, in the order the floor-3 crew
 * walks them. The rows are read-only by construction: the only press that can
 * change one of them lives in the station's own action control, and only for the
 * rows that belong to that station.
 *
 * V3.5 — a note line is only printed where it carries a fact the badge cannot:
 * the server timestamp, or this phone's own write outcome. “Phần việc của NPC 2 ·
 * máy này không xác nhận thay được” under a row already badged “CHỜ NPC 2” said the
 * same thing twice, three times down one card, and the card footnote then said it
 * a fourth time. The “check the area first” rule is the press's own hint, which
 * names the area the button is about to mark — so the row stays quiet.
 */
export function ResetChecklist({ board, role }: { board: ResetBoard; role: Role }) {
  const noteWorthReading = (row: ResetRow) =>
    row.state === 'done' || row.state === 'failed' || row.state === 'submitting';
  return (
    <section className="reset-card" data-testid="reset-checklist" data-done={board.done} data-total={board.total}>
      <header className="reset-head">
        <p className="reset-eyebrow">
          <StairsIcon className="h-3.5 w-3.5" />
          RESET VẬT LÝ · TẦNG 3
        </p>
        <p className="reset-count digital" data-testid="reset-count">
          {board.done}/{board.total}
        </p>
      </header>
      <ul className="reset-list">
        {board.rows.map((row) => (
          <li
            key={row.key}
            className="reset-row"
            data-testid={`reset-row-${row.key}`}
            data-state={row.state}
            data-owner={row.mine ? 'mine' : 'other'}
          >
            <span className="reset-mark" aria-hidden>
              <RowMark row={row} />
            </span>
            <span className="reset-row-body">
              <span className="reset-row-top">
                <span className="reset-area">
                  {row.label}
                  {row.mine ? <span className="reset-mine">· phần của bạn</span> : <span className="reset-owner">{row.owner}</span>}
                </span>
                <span className="badge" data-tone={ROW_TONE[row.state]} data-testid={`reset-state-${row.key}`}>
                  {row.status}
                </span>
              </span>
              {noteWorthReading(row) ? (
                <span className="reset-note" data-testid={`reset-note-${row.key}`}>{row.note}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {board.allDone ? (
        <p className="reset-foot" data-testid="reset-footnote">
          Cả ba khu vực đã được xác nhận · NPC 1 còn một bước chốt khu vực.
        </p>
      ) : role !== 'GATE' ? (
        /* The one reader who has no row of their own still needs to know why the
           card cannot be pressed here. NPC 1's own screen says it row by row. */
        <p className="reset-foot" data-testid="reset-footnote">
          Chỉ vị trí đứng tại khu vực này mới xác nhận được · màn hình này chỉ đọc.
        </p>
      ) : null}
    </section>
  );
}

/**
 * The completed round, stated once, in the order an operator needs it: which
 * team, that its round is over, and the time the server recorded for it.
 *
 * It deliberately occupies the place the idle 05:00 clock used to hold. A phone
 * held in the hand while the floor is being put back answers one question — what
 * became of the team that just left — and the next round's duration is answered
 * underneath that, labelled for what it is.
 */
export function RoundResultCard({ summary, teamNumber, nextLimitLabel }: {
  summary: ResultSummary;
  /** The received team's number, so the heading always reads ĐỘI #001. */
  teamNumber: number | null;
  nextLimitLabel: string;
}) {
  const named = summary.teamText !== `Đội #${pad(teamNumber ?? 0)}`;
  return (
    <section className="round-result" data-testid="hero" data-mode="RESET" data-result={summary.result ?? 'NONE'}>
      <p className="round-result-eyebrow" data-testid="hero-label">
        <CheckIcon className="h-3.5 w-3.5" />
        {summary.headline}
      </p>
      <p className="round-result-team digital" data-testid="round-result-team">
        {teamNumber !== null ? `ĐỘI #${pad(teamNumber)}` : summary.teamText.toUpperCase()}
        {named && teamNumber !== null ? (
          <span className="round-result-name">{summary.teamText.replace(/^Đội #?/, '')}</span>
        ) : null}
      </p>
      <p className="round-result-label" data-testid="round-result-label">{summary.resultLabel}</p>
      <p
        className={`digital round-result-time${summary.officialText ? ' is-official' : ''}`}
        data-testid="hero-clock"
        data-mode={summary.officialText ? 'RESULT' : 'STATE'}
      >
        {summary.officialText ?? summary.stateWord}
      </p>
      <p className="round-result-meta" data-testid="round-result-meta">
        {summary.exitText ? `Đội rời tầng 3 lúc ${summary.exitText}` : 'Chưa ghi nhận mốc rời tầng 3'}
        {summary.attempts > 0 ? ` · ${summary.attempts} lần báo` : ''}
      </p>
      <p className="round-result-next" data-testid="next-round-note">
        <ClockIcon className="h-3.5 w-3.5 shrink-0" />
        <span>LƯỢT KẾ TIẾP · <span className="digital">{nextLimitLabel}</span></span>
      </p>
    </section>
  );
}

/**
 * Whether the next team may be received yet, answered from the same permission
 * table the lobby's own press is checked against. Nothing here can invite a team
 * early: the wording follows the checklist and the verification state, and a
 * floor that is still owed a confirmation is stated as still owed.
 */
export function NextTeamStatus({ readiness }: { readiness: ReadinessView }) {
  const tone = readiness.key === 'ready' ? 'confirmed' : readiness.key === 'ended' ? 'idle' : 'queued';
  return (
    <section className="readiness" data-testid="next-team-status" data-state={readiness.key} data-can-call={readiness.canCallTeam ? '1' : '0'}>
      <p className="readiness-title">
        {readiness.key === 'ready' ? <CheckIcon className="h-4 w-4" /> : <HourglassIcon className="h-4 w-4" />}
        {readiness.title}
      </p>
      {/* V3.5: the sentence naming the outstanding areas was the checklist directly
          above it, row for row. Who is still owed a confirmation is the badge. */}
      {readiness.waitingOn.length > 0 ? (
        <p className="readiness-owners">
          <span className="badge" data-tone={tone} data-testid="next-team-waiting">
            CHỜ {readiness.waitingOn.join(' · ')}
          </span>
        </p>
      ) : (
        <p className="readiness-detail" data-testid="next-team-detail">{readiness.detail}</p>
      )}
      {/* V3.5: what a reset confirmation does and does not touch is stated once, in
          the sheet's Quản trị group, next to the controls it describes. */}
    </section>
  );
}

/**
 * The completed round's history: the official result stays on the surface, the
 * individual claims move into one expandable area. A rejected attempt keeps its
 * own row and its own timestamp — folding the list away is a display choice, and
 * the record underneath it never changes.
 */
export function AttemptLedger({ attempts }: { attempts: AttemptRow[] }) {
  const [open, setOpen] = useState(false);
  if (attempts.length === 0) return null;
  const valid = attempts.filter((a) => a.status === 'VALID');
  const summary = valid.length > 0
    ? `${valid.length} lần chính xác · ${attempts.length - valid.length} lần khác`
    : `${attempts.length} lần báo · chưa có lần chính xác`;
  return (
    <section className="ledger" data-testid="attempt-ledger" data-open={open ? '1' : '0'}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="ledger-toggle"
        data-testid="attempt-details-toggle"
      >
        <span className="ledger-head">
          <span className="ledger-eyebrow">LỊCH SỬ LẦN BÁO</span>
          <span className="ledger-summary">{summary}</span>
        </span>
        <ChevronDownIcon className={`h-4 w-4 shrink-0${open ? ' is-open' : ''}`} />
      </button>
      {open ? (
        <ul className="ledger-list" data-testid="attempt-details">
          {attempts.map((a) => (
            <li key={a.id} className="ledger-row" data-testid={`ledger-${a.seq}`} data-status={a.status}>
              <span className="ledger-seq">Lần {a.seq}</span>
              <span className="ledger-time digital">{formatClockCs(a.elapsedMs)}</span>
              <span className="ledger-state" data-status={a.status}>
                {a.statusWord}
              </span>
              <span className="ledger-when">{formatWallTime(a.claimedAt)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * V3.5 removed `ResetActionNote`. Its sentence under the press was the outstanding
 * row's own note three lines above it, and when every row was done it restated the
 * checklist's confirmed badge. The rule it carried — press only when the area has
 * really been reset — now lives in the row note alone.
 */
