import { unlockAdmin } from './lib/admin';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/**
 * V3.4 §5–§7 (UI-04) — NPC 2's verification surface and the exit hand-off, in
 * the browser, on the real engine, with five phones.
 *
 * `npc2-verification.test.ts` already pins the authority table, the timestamps
 * and the immutability rules against the in-process engine. This spec is the
 * half that could only be proven in a running page:
 *
 *   · the CRITICAL bug — after a correct attempt is finalised, the big
 *     "BÁO HOÀN THÀNH" must not merely be hidden: the server still has
 *     to refuse the press, so the UI is following the authority rather than
 *     papering over it. Both halves are asserted here.
 *   · a rejected attempt keeps its own claim instant and the round continues;
 *   · one official number, at the stored precision, on every phone;
 *   · NPC 1's exit confirmation cannot move that number;
 *   · the sealed NPC2 screen states its facts once, not five times;
 *   · a phone that loses the network mid-verification comes back to the same
 *     decision, not to a stale or duplicated one.
 */

type Phone = 'lobby' | 'corridor' | 'gate' | 'room305' | 'supervisor';

const ROLE_TAG: Record<Phone, string> = {
  lobby: '01',
  corridor: '02',
  gate: 'NPC 1',
  room305: 'NPC 2',
  supervisor: 'TRỊ',
};

async function signIn(context: BrowserContext, which: Phone): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`/?station=${which}`);
  if (which === 'supervisor') await unlockAdmin(page);
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await expect(page.getByTestId('role-tag')).toHaveText(ROLE_TAG[which]);
  return page;
}

async function phone(browser: Browser, which: Phone) {
  const context = await browser.newContext();
  return { context, page: await signIn(context, which) };
}

const shot = async (page: Page, name: string) => {
  mkdirSync('shots', { recursive: true });
  await page.screenshot({ path: `shots/v34-${name}.png` });
};

const tokenOf = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('sc305.session.v1') ?? '{}').token as string);

/** MM:SS.hh exactly as the authoritative layer formats a stored instant. */
const formatCs = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 10) * 10);
  const m = String(Math.floor(total / 60_000)).padStart(2, '0');
  const s = String(Math.floor((total % 60_000) / 1000)).padStart(2, '0');
  const c = String(Math.floor((total % 1000) / 10)).padStart(2, '0');
  return `${m}:${s}.${c}`;
};

test.describe.serial('V3.4 §5–§7 — NPC2 verification, sealed result, NPC1 exit', () => {
  test('the whole hand-off, with the authority behind every button', async ({ browser }) => {
    test.setTimeout(300_000);
    const lobby = await phone(browser, 'lobby');
    const corridor = await phone(browser, 'corridor');
    const gate = await phone(browser, 'gate');
    const room = await phone(browser, 'room305');
    const sup = await phone(browser, 'supervisor');
    const pages = [lobby.page, corridor.page, gate.page, room.page, sup.page];

    const reset = await sup.context.request.post('/api/dev/reset', { headers: { authorization: `Bearer ${await tokenOf(sup.page)}` } });
    expect(reset.ok()).toBe(true);
    for (const p of pages) await p.reload();
    for (const p of pages) await expect(p.getByTestId('dashboard')).toBeVisible();

    const snapshot = async () => {
      const res = await sup.context.request.get('/api/snapshot', { headers: { authorization: `Bearer ${await tokenOf(sup.page)}` } });
      return (await res.json()) as {
        revision: number;
        active_round?: {
          id?: string; status?: string; result?: string; official_duration_ms?: number | null;
          validated_attempt_id?: string | null; exit_confirmed_at?: number | null; exit_by_role?: string | null;
        } | null;
        attempts?: { id: string; seq: number; status: string; elapsed_ms: number; claimed_at: number }[];
        log?: { action: string; actor_role: string }[];
      };
    };
    /** A command sent straight to the authority, bypassing every UI guard. */
    const raw = async (from: Page, action: string, meta: Record<string, unknown> = {}, revision?: number, key?: string) => {
      const snap = await snapshot();
      const res = await from.context().request.post('/api/command', {
        data: { action, meta, idempotency_key: key ?? `${action}-${Date.now()}-${Math.random()}`, expected_revision: revision ?? snap.revision },
        headers: { authorization: `Bearer ${await tokenOf(from)}` },
      });
      return { status: res.status(), body: (await res.json()) as { ok: boolean; code?: string; message?: string; revision?: number } };
    };

    // 1. Round running on every phone.
    await lobby.page.getByTestId('primary-action').click();
    await corridor.page.getByTestId('primary-action').click();
    await gate.page.getByTestId('primary-action').click();
    await expect(room.page.getByTestId('countdown-screen')).toBeVisible();
    await expect(room.page.getByTestId('record-claim')).toBeVisible();
    await expect(room.page.getByTestId('npc2-panel')).toHaveAttribute('data-can-claim', '1');

    // 2. NPC2 records a completion report; the clock keeps running.
    await room.page.getByTestId('record-claim').click();
    await expect(room.page.getByTestId('verify-card-1')).toBeVisible();
    await expect(room.page.getByTestId('verify-state-1')).toHaveText('ĐANG CHỜ XÁC MINH');
    await expect(room.page.getByTestId('hero-clock')).toHaveAttribute('data-mode', 'GAME');
    const claimOne = (await snapshot()).attempts?.find((a) => a.seq === 1)!;
    expect(claimOne.status).toBe('PENDING');
    await shot(room.page, 'npc2-pending-decision');

    // 3. Duplicate submission cannot become two reports. The UI blocks a second
    // press while the first is unacknowledged; behind it the authority keys each
    // committed tap by actor + action + idempotency key. Two concurrent sends of
    // one key must therefore add AT MOST one row — never two. (One row is a
    // legitimate new report while the clock runs; the defect this pins is the
    // replay creating a second one.)
    const beforeDup = (await snapshot()).attempts?.length ?? 0;
    const dupKey = `dup-claim-${Date.now()}`;
    const [firstSend, replaySend] = await Promise.all([
      raw(room.page, 'CLAIM_COMPLETE', {}, undefined, dupKey),
      raw(room.page, 'CLAIM_COMPLETE', {}, undefined, dupKey),
    ]);
    const afterDup = (await snapshot()).attempts?.length ?? 0;
    expect(afterDup, 'a replayed idempotency key created a second report').toBeLessThanOrEqual(beforeDup + 1);
    // The replay is answered from the cache, not re-executed: if both said yes,
    // they report the same committed revision.
    if (firstSend.body.ok && replaySend.body.ok) {
      expect(replaySend.body.revision ?? firstSend.body.revision).toBe(firstSend.body.revision);
    }

    // 4. An incorrect attempt keeps its own timestamp and the round continues.
    await room.page.getByTestId('attempt-invalid-1').click();
    await expect(room.page.getByTestId('attempt-1')).toHaveAttribute('data-status', 'INVALID', { timeout: 20_000 });
    const kept = (await snapshot()).attempts?.find((a) => a.seq === 1)!;
    expect(kept.claimed_at).toBe(claimOne.claimed_at);
    expect(kept.elapsed_ms).toBe(claimOne.elapsed_ms);
    expect((await snapshot()).active_round?.official_duration_ms).toBeNull();
    // Permitted continuation: the report window is still open on this phone.
    await expect(room.page.getByTestId('record-claim')).toBeVisible();

    // 5. Two reports are pending at once and the older one is the correct one.
    //    Sealing the round must not leave a pressable decision on the other, and
    //    must not invent a decision for the row nobody judged. Sequence numbers
    //    are read from the authority, because step 3 may have added a row.
    await room.page.getByTestId('record-claim').click();
    const newest = async () => (await snapshot()).attempts!.reduce((a, b) => (b.seq > a.seq ? b : a));
    const claimTwo = await newest();
    await expect(room.page.getByTestId(`verify-card-${claimTwo.seq}`)).toBeVisible();
    await room.page.getByTestId('record-claim').click();
    const leftover = await newest();
    expect(leftover.seq).toBeGreaterThan(claimTwo.seq);
    await expect(room.page.getByTestId(`verify-card-${leftover.seq}`)).toBeVisible();

    await room.page.getByTestId(`attempt-valid-${claimTwo.seq}`).click();
    await expect(room.page.getByTestId(`attempt-valid-${claimTwo.seq}`)).toHaveAttribute('data-armed', '1');
    await room.page.getByTestId(`attempt-valid-${claimTwo.seq}`).click();
    await expect.poll(async () => (await snapshot()).active_round?.result, { timeout: 20_000 }).toBe('WON');

    // 5b. The claim nobody decided is read-only everywhere: no card, no press,
    // the authority still refuses it, and the row says "not decided" rather than
    // borrowing the words of a rejection that never happened.
    await expect(room.page.getByTestId(`verify-card-${leftover.seq}`)).toHaveCount(0);
    await expect(room.page.getByTestId(`attempt-valid-${leftover.seq}`)).toHaveCount(0);
    const lateJudge = await raw(room.page, 'VERIFY_ATTEMPT', { attempt_id: leftover.id, decision: 'VALID' });
    expect(lateJudge.body.ok).toBe(false);
    await expect(room.page.getByTestId(`attempt-${leftover.seq}`)).toContainText('CHƯA QUYẾT ĐỊNH');
    const stillSealed = await snapshot();
    expect(stillSealed.active_round?.result).toBe('WON');
    expect(stillSealed.active_round?.official_duration_ms).toBe(claimTwo.elapsed_ms);
    expect(stillSealed.active_round?.validated_attempt_id).toBe(claimTwo.id);

    /* ------------------------------- CRITICAL: the CTA is gone AND refused */
    await expect(room.page.getByTestId('record-claim')).toHaveCount(0);
    await expect(room.page.getByTestId('npc2-panel')).toHaveAttribute('data-can-claim', '0');
    await expect(room.page.getByTestId('npc2-panel')).toHaveAttribute('data-finalized', '1');
    await expect(room.page.getByTestId('official-result')).toBeVisible();
    // Not a hidden button: the authority still answers the same press with the
    // same refusal it gave before the redesign.
    const refused = await raw(room.page, 'CLAIM_COMPLETE');
    expect(refused.body.ok).toBe(false);
    expect(refused.body.code).toBe('INVALID_STATE');
    // And no second official result can be produced, from either direction.
    const reJudge = await raw(room.page, 'VERIFY_ATTEMPT', { attempt_id: claimTwo.id, decision: 'INVALID' });
    expect(reJudge.body.ok).toBe(false);
    const afterRefusals = await snapshot();
    expect(afterRefusals.active_round?.result).toBe('WON');
    expect(afterRefusals.active_round?.validated_attempt_id).toBe(claimTwo.id);

    // 6. Authoritative precision: the stored claim instant, to the hundredth.
    const official = afterRefusals.active_round?.official_duration_ms!;
    expect(official).toBe(claimTwo.elapsed_ms);
    // V3.4.1: the sealed card no longer prints the official instant a second time —
    // the hero digits are that exact number, at the largest size on the surface.
    // The hero keeps MM:SS in the digits and the hundredths as its own fraction.
    await expect(room.page.getByTestId('hero-clock')).toHaveText(formatCs(official).slice(0, 5));
    await expect(room.page.getByTestId('hero-fraction')).toHaveText(`.${formatCs(official).slice(6, 8)}`);
    await expect(room.page.getByTestId('hero-clock')).toHaveAttribute('data-mode', 'RESULT');

    // 7. The sealed screen states each fact once.
    await expect(room.page.getByTestId('countdown-team')).toHaveCount(0);
    await expect(room.page.getByTestId('countdown-status')).toHaveCount(0);
    await expect(room.page.getByTestId('countdown-meter')).toHaveCount(0);
    await expect(room.page.getByTestId('notice')).toHaveCount(0);
    // History stays compact and complete: every attempt, each with its own instant.
    await expect(room.page.getByTestId('attempt-1')).toContainText(formatCs(claimOne.elapsed_ms));
    await expect(room.page.getByTestId(`attempt-${claimTwo.seq}`)).toContainText(formatCs(claimTwo.elapsed_ms));
    await expect(room.page.getByTestId(`attempt-${leftover.seq}`)).toContainText(formatCs(leftover.elapsed_ms));
    await shot(room.page, 'npc2-sealed-once');

    // 8. Cross-phone synchronisation: NPC 1 gets the authorised exit action.
    await expect(gate.page.getByTestId('npc1-handoff')).toBeVisible({ timeout: 20_000 });
    await expect(gate.page.getByTestId('npc1-handoff-official')).toContainText(formatCs(official));
    // 8b. NPC 1's screen states each fact once, exactly like NPC 2's sealed one.
    // The hand-off card beside the press owns the team, the official instant and
    // the verdict; the hero keeps the digits and stops saying them again above it.
    await expect(gate.page.getByTestId('countdown-team')).toHaveCount(0);
    await expect(gate.page.getByTestId('countdown-status')).toHaveCount(0);
    await expect(gate.page.getByTestId('hero-clock')).toHaveText(formatCs(official).slice(0, 5));
    await expect(gate.page.getByTestId('npc1-handoff-team')).toContainText('#001');
    // The START_GAME receipt from a press made a whole round ago is not still
    // hanging under the card that says the round is over.
    await expect(gate.page.getByTestId('notice')).toHaveCount(0);
    await shot(gate.page, 'npc1-handoff-once');
    await expect(gate.page.getByTestId('primary-action')).toHaveText('ĐỘI ĐÃ RỜI TẦNG 3');
    // Nobody else is offered a press at all: the exit belongs to NPC 1 alone,
    // and on the other phones the lock renders no control to mis-tap.
    for (const p of [lobby.page, corridor.page, sup.page]) {
      await expect(p.getByTestId('primary-action')).toHaveCount(0);
    }
    // And the authority refuses it from another role.
    const wrongRole = await raw(lobby.page, 'CONFIRM_EXIT');
    expect(wrongRole.body.ok).toBe(false);
    expect(wrongRole.body.code).toBe('PERMISSION_DENIED');

    // 9. A stale revision is refused and the phone resynchronises.
    const stale = await raw(sup.page, 'ABORT_ROUND', { reason: 'stale probe' }, 1);
    expect(stale.body.code).toBe('STALE_REVISION');

    // 10. NPC 1's exit confirmation transitions into the physical reset — and
    // changes nothing about the score.
    await gate.page.getByTestId('primary-action').click();
    await expect(gate.page.getByTestId('primary-action')).toHaveText('XÁC NHẬN LẠI: ĐỘI ĐÃ RỜI TẦNG 3');
    await gate.page.getByTestId('primary-action').click();
    await expect.poll(async () => (await snapshot()).active_round?.status, { timeout: 20_000 }).toBe('EXIT_CONFIRMED');
    const exited = await snapshot();
    expect(exited.active_round?.official_duration_ms).toBe(official);
    expect(exited.active_round?.exit_by_role).toBe('GATE');
    await expect(gate.page.getByTestId('reset-checklist')).toBeVisible();
    await expect(gate.page.getByTestId('hero-clock')).toHaveAttribute('data-mode', 'RESULT');
    await shot(gate.page, 'npc1-exit-handoff');

    // 11. Network recovery on the deciding phone: the sealed state comes back
    // sealed, never as a fresh pressable CTA. The round is already out of the
    // lock by now, so this is the header chip and the retry it offers.
    await room.page.context().setOffline(true);
    for (let i = 0; i < 40; i++) {
      const s = await room.page.getByTestId('connection').getAttribute('data-status');
      if (s !== 'CONNECTED') break;
      await room.page.waitForTimeout(1_000);
    }
    await expect(room.page.getByTestId('connection')).not.toHaveAttribute('data-status', 'CONNECTED', { timeout: 5_000 });
    await expect(room.page.getByTestId('sync-retry')).toBeVisible();
    await room.page.context().setOffline(false);
    await expect(room.page.getByTestId('connection')).toHaveAttribute('data-status', 'CONNECTED', { timeout: 40_000 });
    // Recovery returns the sealed truth, not a fresh reporting window: the CTA
    // stays absent and the authority still refuses a new report.
    await expect(room.page.getByTestId('record-claim')).toHaveCount(0);
    const afterReconnect = await raw(room.page, 'CLAIM_COMPLETE');
    expect(afterReconnect.body.ok).toBe(false);
    expect((await snapshot()).active_round?.result).toBe('WON');

    for (const { context } of [lobby, corridor, gate, room, sup]) await context.close();
  });
});
