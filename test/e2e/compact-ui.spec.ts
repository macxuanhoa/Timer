import { expect, test, type Page } from '@playwright/test';
import { unlockAdmin } from './lib/admin';
const fits = async (page: Page) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
};
const token = (p: Page) => p.evaluate(() => JSON.parse(localStorage.getItem('sc305.session.v1') ?? '{}').token as string);

test('compact Home grants and revokes Admin on the server', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/');
  await expect(page.getByTestId('scream-home')).toBeVisible();
  await fits(page);
  await page.getByTestId('admin-toggle').click();
  await expect(page.getByTestId('admin-pin')).toBeFocused();
  await page.getByTestId('admin-pin').fill('000000');
  await page.getByTestId('admin-unlock').click();
  await expect(page.getByRole('alert')).toContainText('Mật mã');
  await expect(page.getByTestId('admin-pin')).toHaveValue('');
  await page.getByTestId('admin-pin').fill('211105');
  await page.getByTestId('admin-unlock').click();
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await expect(page.getByTestId('admin-toggle')).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(page.getByTestId('dashboard')).toBeVisible();
  const old = await token(page);
  await page.getByTestId('open-seat-management').click();
  await expect(page.getByTestId('sheet-tab-admin')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('admin-group-risk')).not.toHaveAttribute('open', '');
  await fits(page);
  await page.getByTestId('close-details').click();
  await page.getByTestId('admin-toggle').click();
  await expect(page.getByTestId('scream-home')).toBeVisible();
  expect((await page.request.get('/api/account', { headers: { authorization: 'Bearer ' + old } })).status()).toBe(401);
  await page.reload();
  await expect(page.getByTestId('scream-home')).toBeVisible();
});

test('compact stations preserve the full game and confirmation flow at 320px', async ({ browser }) => {
  const errors: string[] = [];
  const adminContext = await browser.newContext({ viewport: { width: 320, height: 640 }, reducedMotion: 'reduce' });
  const admin = await adminContext.newPage();
  await admin.goto('/');
  await unlockAdmin(admin);
  const adminToken = await token(admin);
  expect((await admin.request.post('/api/dev/reset', { headers: { authorization: 'Bearer ' + adminToken } })).ok()).toBe(true);
  const pages: Page[] = [];
  for (const role of ['LOBBY', 'CORRIDOR', 'GATE', 'ROOM305', 'OBSERVER']) {
    const context = await browser.newContext({ viewport: { width: 320, height: 640 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/');
    await page.getByTestId('station-' + role).click();
    await expect(page.getByTestId(role === 'OBSERVER' ? 'observer' : 'dashboard')).toBeVisible();
    pages.push(page); await fits(page);
  }
  const [lobby, corridor, gate, room, viewer] = pages;
  await lobby.getByTestId('primary-action').click();
  await expect(corridor.getByTestId('primary-action')).toHaveText('ĐỘI ĐÃ ĐẾN TẦNG 2');
  await corridor.getByTestId('primary-action').click();
  await expect(gate.getByTestId('primary-action')).toHaveText('BẮT ĐẦU');
  await gate.getByTestId('primary-action').click();
  await expect(room.getByTestId('record-claim')).toHaveText('BÁO HOÀN THÀNH');
  for (const p of pages) await fits(p);
  await expect(viewer.getByTestId('record-claim')).toHaveCount(0);
  await room.getByTestId('record-claim').click();
  const help = room.locator('details.help-details');
  await expect(help).toHaveCount(1);
  await expect(help).not.toHaveAttribute('open', '');
  await help.locator('summary').click();
  await expect(help).toHaveAttribute('open', '');
  await help.locator('summary').click();
  await room.getByTestId('attempt-valid-1').click();
  await expect(room.getByTestId('attempt-valid-1')).toHaveAttribute('data-armed', '1');
  await expect(room.getByText(/Không thể hoàn tác/)).toBeVisible();
  await room.getByTestId('attempt-valid-1').click();
  await expect(gate.getByTestId('primary-action')).toHaveAttribute('data-action', 'CONFIRM_EXIT');
  await gate.getByTestId('primary-action').click();
  await expect(gate.getByTestId('primary-action')).toHaveAttribute('data-armed', '1');
  await gate.getByTestId('primary-action').click();
  await expect(gate.getByTestId('reset-checklist')).toBeVisible();
  for (const width of [320, 390, 430]) {
    for (const p of pages) { await p.setViewportSize({ width, height: 844 }); await fits(p); }
  }
  expect(errors).toEqual([]);
  for (const p of pages) await p.context().close();
  await adminContext.close();
});
