import { expect, test, type Browser, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/**
 * V3.4 §9 (UI-07) — QUẢN TRỊ and BÁO CÁO in a running page, on the real engine.
 *
 * `reporting-semantics.test.ts` pins the source fields. This spec is the other
 * half: the words the operator actually reads, in the order they arrive, with
 * the two rounds that make the three reported semantic issues visible at once —
 * a team that finished inside its limit, and a team cancelled for discipline
 * with no score to withhold.
 *
 * The workflow itself is driven through the authoritative HTTP command API
 * rather than five phone pages: the subject here is the report and the admin
 * surface, and the cross-phone hand-offs those commands perform are already
 * pinned by UI-01…UI-05. Keeping the engine calls out of the browser also keeps
 * the round inside its own time limit while the assertions run.
 */

type Account = 'lobby' | 'corridor' | 'gate' | 'room305' | 'supervisor';

interface RoundRow {
  id: string;
  team_number: number;
  result: string;
  official_duration_ms: number | null;
  needs_review: boolean;
  review_reasons: string[];
  decertified: boolean;
  abort_kind: string | null;
  deadline_at: number | null;
  game_started_at: number | null;
}

test.describe.serial('V3.4 §9 — admin hierarchy, report semantics, audit filters', () => {
  test('two rounds, one report that tells them apart', async ({ browser, request }) => {
    test.setTimeout(240_000);

    const token = async (account: Account) => {
      const res = await request.post('/api/login', { data: { account } });
      expect(res.ok()).toBe(true);
      return (await res.json()) as { token: string };
    };
    const tokens = {} as Record<Account, string>;
    for (const a of ['lobby', 'corridor', 'gate', 'room305', 'supervisor'] as Account[]) {
      tokens[a] = (await token(a)).token;
    }
    const hdr = (a: Account) => ({ authorization: `Bearer ${tokens[a]}` });

    const board = async () => {
      const res = await request.get('/api/snapshot', { headers: hdr('supervisor') });
      return (await res.json()) as {
        revision: number;
        rounds?: RoundRow[];
        active_round?: RoundRow | null;
        attempts?: { id: string; seq: number; round_id: string; status: string }[];
      };
    };
    /** One command, sent with the revision the server just reported. */
    const cmd = async (a: Account, action: string, meta: Record<string, unknown> = {}) => {
      const { revision } = await board();
      const res = await request.post('/api/command', {
        data: { action, meta, idempotency_key: `${action}-${revision}-${Math.random()}`, expected_revision: revision },
        headers: hdr(a),
      });
      const body = (await res.json()) as { ok: boolean; code?: string; message?: string };
      expect(body.ok, `${action} on ${a}: ${body.code} ${body.message ?? ''}`).toBe(true);
      return body;
    };
    const advance = async (ms: number) => {
      const res = await request.post('/api/dev/clock', { data: { advance_ms: ms }, headers: hdr('supervisor') });
      expect(res.ok()).toBe(true);
    };

    // Specs earlier in the same run leave the shared engine mid-flow; this one
    // needs a known starting event and a known round limit.
    const fresh = await request.post('/api/dev/reset', { headers: hdr('supervisor') });
    expect(fresh.ok()).toBe(true);

    await cmd('supervisor', 'CONFIGURE', { game_limit_ms: 300_000, prep_allowance_ms: 60_000, reset_target_ms: 120_000, hidden_object_owner: 'ROOM305' });

    /* ------------------------------------------ team #001 finishes in time */
    await cmd('lobby', 'CALL_TEAM');
    await cmd('corridor', 'CONFIRM_FLOOR2');
    await cmd('gate', 'START_GAME');
    await advance(42_000);
    await cmd('room305', 'CLAIM_COMPLETE');
    const snap1 = await board();
    const first = snap1.active_round!;
    const claim = snap1.attempts!.find((a) => a.round_id === first.id)!;
    await cmd('room305', 'VERIFY_ATTEMPT', { attempt_id: claim.id, decision: 'VALID' });
    await cmd('gate', 'CONFIRM_EXIT');
    const wonOfficial = (await board()).rounds!.at(-1)!.official_duration_ms;
    expect(wonOfficial).not.toBeNull();
    await cmd('gate', 'RESET_DONE');
    await cmd('room305', 'RESET_DONE');
    await cmd('gate', 'GATE_FINALIZE');

    /* ------------------------------- team #002 is cancelled for discipline */
    await cmd('lobby', 'CALL_TEAM');
    await cmd('corridor', 'CONFIRM_FLOOR2');
    await cmd('gate', 'START_GAME');
    await advance(15_000);
    await cmd('supervisor', 'ABORT_ROUND', { reason: 'Đội tự ý mở cửa phụ', kind: 'misconduct' });
    await cmd('gate', 'CONFIRM_EXIT');

    const rounds = (await board()).rounds!;
    const cancelled = rounds.at(-1)!;
    expect(cancelled.abort_kind).toBe('misconduct');
    expect(cancelled.needs_review).toBe(true);
    expect(cancelled.official_duration_ms).toBeNull();

    /* ================================================== the supervisor's UI */
    const context = await browser.newContext();
    const sup: Page = await context.newPage();
    await sup.goto('/?station=supervisor');
    await expect(sup.getByTestId('dashboard')).toBeVisible();
    await expect(sup.getByTestId('role-tag')).toHaveText('TRỊ');

    await sup.getByTestId('open-details').click({ timeout: 15_000 });
    await sup.getByTestId('sheet-tab-report').click({ timeout: 15_000 });

    // 1 — the summary is the first block, and it counts rounds the way the
    // operations tab does: recorded / closed / open / cancelled, spelled out.
    const summary = sup.getByTestId('report-summary');
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('2 lượt đã ghi nhận · 1 đã đóng · 1 đang diễn ra · 1 lượt bị hủy có kiểm toán');
    await expect(summary).toContainText('Đội có kết quả chính thức');
    await expect(summary).toContainText('Vòng chờ Quản trị viên quyết');

    // 2 — the best official result is the stored instant, with its eligibility
    // rule stated next to it.
    await expect(sup.getByTestId('report-best')).toContainText('Chỉ tính đội có lần báo hoàn thành được NPC 2 chốt');
    await expect(sup.getByTestId('report-best-team')).toContainText('#001');

    // 3 — the disqualified team never enters the ranking.
    expect(await sup.getByTestId('leaderboard-table').locator('tbody tr').count(),
      'a decertified team must not be ranked').toBe(1);

    // 4 — folded by default: the summary line is visible, the detail rows are
    // not, and opening changes no number.
    const card1 = sup.getByTestId('round-detail-1');
    await expect(card1.getByTestId('round-score-1')).toContainText('THÀNH CÔNG');
    await expect(card1.getByTestId('round-detail-rows-1')).toBeHidden();
    await card1.getByTestId('round-detail-toggle-1').click();
    await expect(card1.getByTestId('round-detail-rows-1')).toBeVisible();

    // Issue 3 — the scheduled expiry reads as the field it is, never with the
    // outcome word, and the relation to the finished round is stated.
    const labels = await card1.locator('.round-card-body > div > span:first-child').allInnerTexts();
    expect(labels, `row labels: ${labels.join(' | ')}`).not.toContain('Hết giờ');
    expect(labels).toContain('Mốc hết giờ theo lịch');
    await expect(card1.getByTestId('round-detail-rows-1')).toContainText('đội hoàn thành trước mốc');
    // The official instant the report prints is the engine's own number.
    await expect(card1.getByTestId('round-detail-rows-1')).toContainText('Điểm chính thức');

    // Issue 1 — the cancellation is described by the kind the server recorded,
    // on the card and in the audit trail, and the two cannot disagree.
    const card2 = sup.getByTestId('round-detail-2');
    await expect(card2.getByTestId('round-flag-2')).toHaveText('CHỜ XÉT');
    await card2.getByTestId('round-detail-toggle-2').click();
    await expect(card2.getByTestId('round-detail-rows-2')).toContainText('Kỷ luật · vi phạm luật chơi');
    await expect(card2.getByTestId('round-detail-rows-2')).not.toContainText('loại hủy không được ghi nhận');
    // The classification and the operator's own words are two labelled facts on
    // the same card, not one sentence that appears to contradict another tab.
    await expect(card2.getByTestId('round-detail-rows-2')).toContainText('Lý do ghi nhận');
    await expect(card2.getByTestId('round-detail-rows-2')).toContainText('Đội tự ý mở cửa phụ');

    await sup.getByTestId('audit-search').fill('HỦY LƯỢT');
    await expect(sup.getByTestId('history').locator('li').first()).toContainText('Kỷ luật · vi phạm luật chơi');
    await expect(sup.getByTestId('history').locator('li')).not.toContainText('An toàn · y tế');
    await sup.getByTestId('audit-search').fill('');

    // Issue 2 — the two review populations, each with the count its label
    // describes. The cancelled round has no official time, so the withheld-score
    // count is zero while one round genuinely awaits a decision; before the
    // split, a single "Kết quả chờ xét: 0" sat beside a card reading CHỜ XÉT.
    const perfKeys = await sup.getByTestId('performance').locator('div > span:first-child').allInnerTexts();
    const readKpi = async (key: string) => {
      const i = perfKeys.indexOf(key);
      expect(i, `KPI row "${key}" exists`).toBeGreaterThanOrEqual(0);
      // Each row is one div with two spans, so the value of key `i` sits at
      // 2i+1 in the flat span list.
      return (await sup.getByTestId('performance').locator('div > span').nth(2 * i + 1).innerText()).trim();
    };
    // A third row is read as well, so the index arithmetic above cannot pass by
    // coincidence the way it did when the two populations shared a value.
    expect(await readKpi('Đội đã xử lý')).toMatch(/^\d+$/);
    expect(await readKpi('Vòng đang chờ Quản trị viên quyết')).toBe('1');
    expect(await readKpi('Kết quả chờ xét (có điểm chính thức)')).toBe('0');
    expect(await readKpi('Lượt bị hủy')).toBe('1');

    // 6 — the audit filters, and says how much it hid.
    await sup.getByTestId('audit-filter-role').selectOption('ROOM305');
    await expect(sup.getByTestId('audit-count')).toContainText('khớp bộ lọc');
    const actorLines = await sup.getByTestId('history').locator('li p').nth(1).innerText();
    expect(actorLines).toContain('NPC 2');
    await sup.getByTestId('audit-filter-role').selectOption('');

    // 7 — diagnostics behind one deliberate open; 8 — the export is still the
    // whole record.
    await expect(sup.getByTestId('connectivity')).toBeHidden();
    await sup.getByTestId('report-diagnostics').locator('summary').click();
    await expect(sup.getByTestId('connectivity')).toBeVisible();

    const download = await Promise.all([
      sup.waitForEvent('download'),
      sup.getByTestId('export-csv').click(),
    ]).then(([d]) => d);
    expect(download.suggestedFilename()).toMatch(/^scream-305-.*\.csv$/);
    mkdirSync('shots', { recursive: true });
    await sup.screenshot({ path: 'shots/v34-report-semantics.png', fullPage: true });

    /* ================================================== QUẢN TRỊ */
    await sup.getByTestId('sheet-tab-admin').click();

    // The hierarchy is the design: status, then the action, then the seats, then
    // the event, then settings, and the operations that can damage a night last.
    const order = await sup.evaluate(() => {
      const y = (sel: string) => (document.querySelector(sel)?.getBoundingClientRect().top ?? -1) + window.scrollY;
      return {
        status: y('[data-testid="admin-event-status"]'),
        next: y('[data-testid="admin-next-action"]'),
        seats: y('[data-testid="admin-group-seats"]'),
        lifecycle: y('[data-testid="admin-group-lifecycle"]'),
        config: y('[data-testid="admin-group-config"]'),
        risk: y('[data-testid="admin-group-risk"]'),
      };
    });
    // Every block must be present, or the ordering check below could pass on
    // missing elements (a query miss reports -1, which is still a number).
    for (const id of ['admin-event-status', 'admin-next-action', 'admin-group-seats',
      'admin-group-lifecycle', 'admin-group-config', 'admin-group-risk']) {
      await expect(sup.getByTestId(id)).toHaveCount(1);
    }
    // The sheet scrolls inside its own container, so the absolute offsets are
    // negative once the tab has been read; what is pinned is the order.
    expect(order.next, JSON.stringify(order)).toBeGreaterThan(order.status);
    expect(order.seats, JSON.stringify(order)).toBeGreaterThan(order.next);
    expect(order.lifecycle, JSON.stringify(order)).toBeGreaterThan(order.seats);
    expect(order.config, JSON.stringify(order)).toBeGreaterThan(order.lifecycle);
    expect(order.risk, JSON.stringify(order)).toBeGreaterThan(order.config);

    await expect(sup.getByTestId('admin-event-state-word')).not.toHaveText('');
    // §3A: the block's large headline is the workflow stage, not a second copy
    // of the sheet header's verdict. The verdict is still stated, as a row.
    await expect(sup.getByTestId('admin-event-stage-word')).not.toHaveText('');
    await expect(sup.getByTestId('admin-event-stage-word')).not.toHaveText(
      await sup.getByTestId('sheet-event-state').innerText());
    await expect(sup.getByTestId('admin-next-next')).toContainText('TIẾP THEO');

    // The review control now lists the round that only a review can close.
    await expect(sup.getByTestId('review-count')).toContainText('VÒNG CHỜ QUẢN TRỊ VIÊN QUYẾT (1)');
    await expect(sup.getByTestId('review-round')).toContainText('#002');
    await expect(sup.getByTestId('review-round')).toContainText('không có điểm chính thức');
    await sup.screenshot({ path: 'shots/v34-admin-hierarchy.png', fullPage: true });

    await sup.getByTestId('review-round').selectOption(cancelled.id);
    await sup.getByTestId('review-reason').fill('Đã làm việc với đội trưởng, giữ nguyên quyết định hủy');
    await sup.getByTestId('review-reject').click();
    await expect(sup.getByTestId('review-count')).toHaveCount(0, { timeout: 20_000 });

    // The official instant of team #001 survived every one of these operations.
    const after = (await board()).rounds!;
    expect(after.find((r) => r.team_number === 1)?.official_duration_ms).toBe(wonOfficial);
    expect(after.find((r) => r.team_number === 2)?.decertified).toBe(true);
    expect(after.find((r) => r.team_number === 2)?.needs_review).toBe(false);

    /* ------------------------------------------- a station sees no admin */
    // Checked while the event is still open: a finished event replaces the
    // station footer, so this is the phase where the tab bar is meaningful.
    const gateContext = await browser.newContext();
    const gate = await gateContext.newPage();
    await gate.goto('/?station=gate');
    await expect(gate.getByTestId('dashboard')).toBeVisible();
    await gate.getByTestId('open-details').click({ timeout: 15_000 });
    await expect(gate.getByTestId('sheet-tab-admin')).toHaveCount(0);
    await expect(gate.getByTestId('sheet-tab-report')).toBeVisible();
    await gateContext.close();

    // Round #002's floor is handed back before the night can be closed: the
    // engine refuses END_EVENT while a round is still open. These go through
    // the command API so a refusal names itself — the UI press path for
    // END_EVENT is already pinned by v34-reset-lifecycle and v31-vietnamese.
    await cmd('gate', 'RESET_DONE');
    await cmd('room305', 'RESET_DONE');
    await cmd('gate', 'GATE_FINALIZE');
    await cmd('supervisor', 'END_EVENT', { reason: 'Hết ca' });

    /* -------------------------------------------------- event-ended view */
    // The sheet stays open across the close, because a finished event replaces
    // the station footer — the ended state is asserted from the sheet the
    // organiser was already reading.
    await expect(sup.getByTestId('admin-open-new')).toBeVisible({ timeout: 20_000 });
    await expect(sup.getByTestId('admin-event-state-word')).toContainText('KẾT THÚC');
    await sup.getByTestId('sheet-tab-report').click();
    await expect(sup.getByTestId('report-summary')).toContainText('2 lượt đã ghi nhận · 2 đã đóng');
    await expect(sup.getByTestId('report-summary')).toContainText('SỰ KIỆN ĐÃ KẾT THÚC');
    await sup.screenshot({ path: 'shots/v34-report-ended.png', fullPage: true });

    // The closed event's record stays readable, with the same stored instant.
    const ended = (await board()).rounds!;
    expect(ended.find((r) => r.team_number === 1)?.official_duration_ms).toBe(wonOfficial);
    expect(ended.find((r) => r.team_number === 2)?.official_duration_ms).toBeNull();

    await context.close();
  });
});
