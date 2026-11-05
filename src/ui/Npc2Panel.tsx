import { useEffect, useState } from 'react';
import type { LiveStore } from '../client/liveStore';
import type { AttemptRow, CountdownView, Npc2Stage } from '../client/selectors';
import { formatClockCs } from '../shared/metrics';
import { OfficialResultCard } from './TimeView';
import { CheckIcon, CrossIcon, UsersIcon } from './icons';

/**
 * V3.4 — NPC2's verification surface, and the single place that decides whether
 * a completion report may be recorded at all.
 *
 * The old panel kept its big "GHI NHẬN BÁO HOÀN THÀNH" button on screen
 * whatever the server had already decided, so pressing it after a finalised
 * result could only ever earn "Giai đoạn hiện tại không nhận thao tác này".
 * The panel now asks the authoritative layer the same question the RPC asks
 * (`resolveNpc2Stage` → `authorize`) and simply does not render a control the
 * backend would refuse. Server-side validation stays exactly as it was — this
 * removes the invitation to press, never the refusal behind it.
 */
interface Props {
  store: LiveStore;
  stage: Npc2Stage;
  attempts: AttemptRow[];
  countdown: CountdownView;
  pending: string | null;
  verifying: string | null;
}

export function Npc2Panel({ store, stage, attempts, countdown, pending, verifying }: Props) {
  const busy = pending !== null || verifying !== null;
  const open = attempts.filter((a) => a.open);
  // One irreversible press at a time: the VALID decision is armed by a first
  // tap and only lands on the second, mirroring the bypass/exit safeguards.
  const [armedId, setArmedId] = useState<string | null>(null);
  useEffect(() => {
    // Disarm whenever the decision is in flight or its outcome has landed.
    if (busy || stage.finalized) setArmedId(null);
  }, [busy, stage.finalized]);
  useEffect(() => () => setArmedId(null), []);

  const press = (action: 'CLAIM_COMPLETE' | 'VERIFY_ATTEMPT', meta: Record<string, unknown> = {}) =>
    void store.act(action, meta);

  // A row's own words, from the shared status vocabulary: once the round is
  // sealed the list still shows every claim — including one NPC 2 never judged —
  // and calling that "Đã từ chối" would invent a decision the database never
  // recorded.
  const noteFor = (a: AttemptRow) => {
    if (a.status === 'VALID') return `Đã chốt · ${a.inTime ? 'thời gian tính theo mốc báo' : 'ngoài giờ'}`;
    if (a.status === 'INVALID') return 'Đã từ chối · giữ nguyên mốc báo để đối chiếu';
    if (a.status === 'LATE') return 'Ghi nhận sau hết giờ — không tạo kết quả thắng';
    return a.open
      ? 'Đang chờ NPC 2 kiểm tra trận đồ'
      : 'Lượt chơi đã chốt trước khi lần báo này được quyết định — mốc báo giữ nguyên';
  };

  const claimPending = pending === 'CLAIM_COMPLETE' || verifying === 'CLAIM_COMPLETE';
  const verifyPending = pending === 'VERIFY_ATTEMPT' || verifying === 'VERIFY_ATTEMPT';

  return (
    <div className="npc2-panel" data-testid="npc2-panel" data-can-claim={stage.canClaim ? '1' : '0'} data-finalized={stage.finalized ? '1' : '0'}>
      {/* ------------------------------------------- the milestone replaces the CTA */}
      {stage.finalized ? (
        <OfficialResultCard
          teamText={countdown.teamText}
          officialMs={stage.officialMs ?? countdown.officialMs ?? 0}
          waitingLine="Đang chờ NPC 1 xác nhận đội rời tầng 3."
        />
      ) : stage.canClaim ? (
        <button
          type="button"
          onClick={() => press('CLAIM_COMPLETE')}
          disabled={busy}
          className="cta cta-amber"
          data-testid="record-claim"
          data-action="CLAIM_COMPLETE"
          data-pending={claimPending ? '1' : '0'}
        >
          <UsersIcon className="h-5 w-5" />
          {claimPending ? 'ĐANG GHI…' : 'GHI NHẬN BÁO HOÀN THÀNH'}
        </button>
      ) : (
        /* Read-only hand-off: the phase no longer accepts reports, and the
           screen says so in the same words the server would use. */
        <p className="npc2-readonly" role="status" data-testid="npc2-readonly">
          {stage.claimRefusal}
        </p>
      )}

      {/* ------------------------------------------------ late-window honesty band */}
      {stage.canClaim && stage.lateOnly && !stage.finalized && (
        <p className="npc2-late-band" data-testid="npc2-late-note">
          Hết giờ — lần báo mới chỉ được lưu để đối chiếu, không thể thành kết quả thắng.
        </p>
      )}

      {/* ----------------------------------------- pending verification decision cards */}
      {open.map((a) => {
        const armed = armedId === a.id;
        return (
          <div
            key={a.id}
            className="npc2-verify-card"
            data-testid={`verify-card-${a.seq}`}
            data-armed={armed ? '1' : '0'}
          >
            <p className="npc2-verify-head" data-testid={`verify-head-${a.seq}`}>
              <span>LẦN {a.seq} · {formatClockCs(a.elapsedMs)}</span>
              <span className="npc2-verify-state" data-testid={`verify-state-${a.seq}`}>ĐANG CHỜ XÁC MINH</span>
            </p>
            <p className="npc2-verify-time">Thời gian ghi theo mốc báo của đội — không đổi theo lúc bạn chốt.</p>
            <div className="npc2-decisions">
              <button
                type="button"
                onClick={() => press('VERIFY_ATTEMPT', { attempt_id: a.id, decision: 'INVALID' })}
                disabled={busy}
                className="npc2-decision npc2-decision-reject"
                data-testid={`attempt-invalid-${a.seq}`}
              >
                <CrossIcon className="h-4 w-4" />
                <span>CHƯA ĐÚNG — TIẾP TỤC</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!a.inTime || busy) return;
                  if (!armed) {
                    setArmedId(a.id);
                    return;
                  }
                  press('VERIFY_ATTEMPT', { attempt_id: a.id, decision: 'VALID' });
                }}
                disabled={busy || !a.inTime}
                className="npc2-decision npc2-decision-confirm"
                data-testid={`attempt-valid-${a.seq}`}
                data-armed={armed ? '1' : '0'}
              >
                <CheckIcon className="h-4 w-4" />
                <span>{verifyPending && armed ? 'ĐANG CHỐT…' : armed ? 'XÁC NHẬN CHỐT KẾT QUẢ' : 'CHÍNH XÁC — CHỐT THỜI GIAN'}</span>
              </button>
            </div>
            <div className="npc2-decision-notes">
              <p>Trận đồ chưa khớp: từ chối lần này, đội tiếp tục chơi.</p>
              <p>Trận đồ khớp: {formatClockCs(a.elapsedMs)} thành KẾT QUẢ CHÍNH THỨC, không thể hoàn tác.</p>
            </div>
            {!a.inTime ? (
              <p className="npc2-late-inline" data-testid={`verify-late-${a.seq}`}>
                Mốc báo ngoài giờ — không thể chốt thành kết quả thắng.
              </p>
            ) : null}
          </div>
        );
      })}

      {/* --------------------------------------------------- compact attempt history */}
      {attempts.some((a) => !a.open) && (
        <ul className="npc2-history" data-testid="attempt-list">
          {attempts.filter((a) => !a.open).map((a) => (
            <li key={a.id} className="npc2-history-row" data-testid={`attempt-${a.seq}`} data-status={a.status}>
              <p className="npc2-history-label" data-testid="attempt-label">
                <span className="npc2-history-seq">Lần {a.seq}</span>
                <span className="digital">{formatClockCs(a.elapsedMs)}</span>
                <span className={`npc2-history-state npc2-history-state-${a.status}`}>
                  {a.statusWord}
                </span>
              </p>
              <p className="npc2-history-note" data-testid="attempt-closed">
                {noteFor(a)}
              </p>
            </li>
          ))}
        </ul>
      )}

      {open.length > 0 && (
        <p className="npc2-pending-hint" data-testid="attempt-hint">
          {countdown.running
            ? `Đang chờ quyết định cho ${open.length} lần báo — đồng hồ vẫn chạy`
            : `Hết giờ — còn ${open.length} lần báo chờ quyết định`}
        </p>
      )}
    </div>
  );
}
