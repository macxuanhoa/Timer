import { describe, expect, it } from 'vitest';
import { TestHub, SEC } from './helpers/harness';
import { analytics, disputedRounds, reviewPendingRounds, roundMetrics } from '../src/shared/metrics';
import { ABORT_KIND_LABEL, OUTCOME_LABEL, abortKindWord } from '../src/shared/constants';
import type { LogEntry } from '../src/shared/types';

/**
 * V3.4 §9 (UI-07) — the three reporting-semantic issues, pinned at the source
 * fields rather than at the pixels. Each case names the stored value the UI is
 * allowed to print, so a future label change cannot silently re-merge two
 * different populations under one word again.
 */

const sentenceOf = (hub: TestHub, action: string): string => {
  const row = [...hub.snapshot().log].reverse().find((l: LogEntry) => l.action === action);
  return row?.metadata?.detail_text ? String(row.metadata.detail_text) : '';
};

describe('V3.4 §9 — reporting semantics at the source fields', () => {
  it('1. a cancellation is described by the kind that was recorded, never by another', () => {
    const build = (kind: 'safety' | 'misconduct') => {
      const hub = new TestHub();
      hub.command('lobby', 'CALL_TEAM');
      hub.command('corridor', 'CONFIRM_FLOOR2');
      hub.command('gate', 'START_GAME');
      hub.advance(2 * SEC);
      const res = hub.command('supervisor', 'ABORT_ROUND', { reason: 'Di chuyển đội ra khu an toàn', kind });
      expect(res.ok).toBe(true);
      return hub;
    };

    const safety = build('safety');
    const safetyRound = safety.snapshot().rounds.at(-1)!;
    expect(safetyRound.abort_kind).toBe('safety');
    // The audit sentence and the stored field agree, and neither calls a safety
    // cancellation a rule breach.
    const safetySentence = sentenceOf(safety, 'ABORT_ROUND');
    expect(safetySentence).toContain(ABORT_KIND_LABEL.safety);
    expect(safetySentence).not.toContain('vi phạm');

    const misconduct = build('misconduct');
    const misconductSentence = sentenceOf(misconduct, 'ABORT_ROUND');
    misconductRoundCheck(misconduct);
    expect(misconductSentence).toContain(ABORT_KIND_LABEL.misconduct);
  });

  it('2. an unrecorded kind is named as unrecorded, never as a violation', () => {
    // The hosted `apply_action` builds its sentence with `case … else 'Kỷ luật ·
    // vi phạm luật chơi'` (migration 0017 line 1143) while storing
    // `abort_kind = p_meta->>'kind'` raw (line 1116). A command that arrives
    // without a recognised kind therefore keeps an empty field and gains a
    // violation in the history. The presentation layer cannot repair that
    // sentence without rewriting the audit, so it must never repeat the guess:
    // every value the server did not record reads as unrecorded.
    for (const unknown of [null, undefined, '', 'Safety', 'an toàn', 'unknown']) {
      const word = abortKindWord(unknown);
      expect(word, String(unknown)).not.toContain('vi phạm');
      expect(word, String(unknown)).toBe('loại hủy không được ghi nhận');
    }
    expect(abortKindWord('safety')).toBe(ABORT_KIND_LABEL.safety);
    expect(abortKindWord('technical')).toBe(ABORT_KIND_LABEL.technical);
    expect(abortKindWord('misconduct')).toBe(ABORT_KIND_LABEL.misconduct);
  });

  it('3. awaiting-decision and withheld-score are two populations, counted separately', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.command('corridor', 'CONFIRM_FLOOR2');
    hub.command('gate', 'START_GAME');
    hub.advance(2 * SEC);
    // A misconduct cancellation with no validated claim: `needs_review` is set,
    // and there is no official duration to withhold from the ranking.
    hub.command('supervisor', 'ABORT_ROUND', { reason: 'Đội tự ý rời khu vực', kind: 'misconduct' });

    const snap = hub.snapshot();
    const cancelled = snap.rounds.at(-1)!;
    expect(cancelled.needs_review).toBe(true);
    expect(cancelled.official_duration_ms).toBeNull();

    expect(reviewPendingRounds(snap.rounds).map((r) => r.id)).toContain(cancelled.id);
    expect(disputedRounds(snap.rounds)).toHaveLength(0);

    const stats = analytics(snap, hub.now());
    // The old single KPI reported `disputed` under the words "Kết quả chờ xét",
    // so a night with this round showed zero beside a card reading CHỜ XÉT. The
    // two numbers now exist separately, and each is what its label says.
    expect(stats.reviewPending).toBe(1);
    expect(stats.disputed).toBe(0);
    expect(stats.aborted).toBe(1);
  });

  it('4. a cancelled round with no score is still resolvable by the review the UI offers', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.command('corridor', 'CONFIRM_FLOOR2');
    hub.command('gate', 'START_GAME');
    hub.advance(2 * SEC);
    hub.command('supervisor', 'ABORT_ROUND', { reason: 'Đội tự ý rời khu vực', kind: 'misconduct' });
    const cancelled = hub.snapshot().rounds.at(-1)!;

    // The engine accepts the decision for this round — it only ever required
    // `needs_review`. Listing the control from `disputedRounds` (which needs an
    // official duration) was therefore a UI-only lockout of the sole path that
    // closes the round, per `attemptsJudgable`.
    const res = hub.command('supervisor', 'REVIEW_RESOLVE', {
      round_id: cancelled.id, decision: 'REJECT', reason: 'Xác minh với đội trưởng',
    });
    expect(res.ok).toBe(true);
    const after = hub.snapshot().rounds.at(-1)!;
    expect(after.needs_review).toBe(false);
    expect(after.review_resolved_at).not.toBeNull();
    expect(reviewPendingRounds(hub.snapshot().rounds)).toHaveLength(0);
  });

  it('5. the scheduled deadline is a field, and a finished team keeps its outcome', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.command('corridor', 'CONFIRM_FLOOR2');
    hub.command('gate', 'START_GAME');
    hub.advance(30 * SEC);
    hub.command('room305', 'CLAIM_COMPLETE');
    const claim = hub.attempts().at(-1)!;
    hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: claim.id, decision: 'VALID' });
    hub.command('gate', 'CONFIRM_EXIT');
    hub.command('gate', 'CONFIRM_EXIT');

    const snap = hub.snapshot();
    const won = snap.rounds.at(-1)!;
    const limit = won.deadline_at! - won.game_started_at!;
    const m = roundMetrics(won, snap.reset_tasks, hub.now(), snap.attempts ?? [], limit);

    // Both facts coexist on the row: the round finished well before its
    // scheduled expiry, and its outcome is a success. Printing the first under
    // the word the second uses is what made a winning team look time-outed.
    expect(m.result).toBe('WON');
    expect(OUTCOME_LABEL[m.result]).toBe('THÀNH CÔNG');
    expect(won.official_duration_ms).toBe(30 * SEC);
    // `game_stopped_at` is written only when a clock is stopped by expiry or
    // cancellation, so a winning round keeps it null — the completion instant
    // the report compares against the deadline is start + official duration.
    expect(won.game_stopped_at).toBeNull();
    const finishedAt = won.game_started_at! + won.official_duration_ms!;
    expect(finishedAt).toBeLessThan(won.deadline_at!);
    // The deadline itself is never rewritten by finishing early.
    expect(won.deadline_at).toBe(won.game_started_at! + limit);
  });

  it('6. a round that really ran out still reads as hết giờ, and only then', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.command('corridor', 'CONFIRM_FLOOR2');
    hub.command('gate', 'START_GAME');
    hub.advance(6 * 60 * SEC);   // past the 05:00 snapshot, no claim recorded
    const snap = hub.snapshot();
    const timed = snap.rounds.at(-1) ?? snap.active_round!;
    const limit = roundLimitOf(timed);
    const m = roundMetrics(timed, snap.reset_tasks, hub.now(), snap.attempts ?? [], limit);
    expect(OUTCOME_LABEL[m.result]).toBe('HẾT GIỜ');
  });

  it('7. an early exit is classified by its path, and the reason stays the operator’s words', () => {
    // The reported contradiction — a round cancelled "An toàn · y tế" while a
    // transition describes "vi phạm" — reproduces exactly here. `EARLY_EXIT`
    // stamps `abort_kind = 'safety'` whatever the reason box said
    // (engine.ts line 965), and the audit sentence is built from that kind
    // while the free-text reason is kept beside it. Both are stored facts; the
    // report shows them as two labelled rows rather than letting them read as
    // one contradictory statement, and no rule or wording here is changed.
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.command('corridor', 'CONFIRM_FLOOR2');
    hub.command('gate', 'START_GAME');
    hub.advance(30 * SEC);
    const res = hub.command('gate', 'EARLY_EXIT', { reason: 'Đội vi phạm nội quy, rời khu vực sớm' });
    expect(res.ok).toBe(true);

    const r = hub.snapshot().rounds.at(-1)!;
    expect(r.abort_kind).toBe('safety');
    // The early-exit path keeps the operator's words in `exit_reason`, not in
    // `abort_reason` — which is why the report reads whichever one is set.
    expect(r.exit_reason).toBe('Đội vi phạm nội quy, rời khu vực sớm');
    expect(r.abort_reason).toBeNull();
    const sentence = sentenceOf(hub, 'EARLY_EXIT');
    expect(sentence).toContain(ABORT_KIND_LABEL.safety);
    // The classification did not invent the reason and the reason did not
    // change the classification: they are separate stored fields.
    expect(sentence).not.toContain('vi phạm');
    expect(abortKindWord(r.abort_kind)).toBe('An toàn · y tế');
    // And the consequence of the kind holds — not disqualified, so an in-time
    // claim could still be judged on its own instant.
    expect(r.decertified).toBe(false);
  });
});

// Small local helpers, so the assertions read as the fields they inspect.
function misconductRoundCheck(hub: TestHub): void {
  const r = hub.snapshot().rounds.at(-1)!;
  expect(r.abort_kind).toBe('misconduct');
  expect(r.decertified).toBe(true);
}

function roundLimitOf(r: { deadline_at: number | null; game_started_at: number | null }): number {
  return r.deadline_at !== null && r.game_started_at !== null ? r.deadline_at - r.game_started_at : 300_000;
}
