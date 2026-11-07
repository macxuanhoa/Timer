import { expect, test } from '@playwright/test';
import { unlockAdmin } from './lib/admin';

test('PIN unlock grants real admin actions; the circle returns to guest and revokes authority', async ({ page, request }) => {
  await page.goto('/');
  await page.getByTestId('admin-toggle').click();
  await page.getByTestId('admin-pin').fill('000000');
  await page.getByTestId('admin-unlock').click();
  await expect(page.getByRole('alert')).toContainText('Mật mã chưa đúng.');
  await expect(page.getByTestId('admin-pin')).toHaveValue('');
  await expect(page.getByTestId('admin-pin')).toBeFocused();
  await page.getByTestId('admin-pin').fill('211105');
  await page.getByTestId('admin-unlock').click();
  await expect(page.getByTestId('dashboard')).toBeVisible();
  const token = await page.evaluate(() => JSON.parse(localStorage.getItem('sc305.session.v1')!).token as string);
  await page.getByTestId('open-settings').click();
  await page.getByTestId('sheet-tab-admin').click();
  await page.getByTestId('cfg-duration-min').fill('4');
  await page.getByTestId('cfg-duration-sec').fill('30');
  const command = page.waitForResponse(res => res.url().endsWith('/api/command'));
  await page.getByTestId('cfg-save').click();
  expect((await (await command).json()).ok).toBe(true);
  await expect(page.getByTestId('cfg-duration-current')).toContainText('04:30');
  await page.getByTestId('cfg-duration-min').fill('5');
  await page.getByTestId('cfg-duration-sec').fill('0');
  const restore = page.waitForResponse(res => res.url().endsWith('/api/command'));
  await page.getByTestId('cfg-save').click();
  expect((await (await restore).json()).ok).toBe(true);
  await page.reload();
  await expect(page.getByTestId('admin-toggle')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('admin-toggle').click();
  await expect(page.getByTestId('scream-home')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('sc305.session.v1'))).toBeNull();
  expect((await request.get('/api/snapshot', { headers: { authorization: 'Bearer ' + token } })).status()).toBe(401);
  await page.reload();
  await expect(page.getByTestId('admin-toggle')).toHaveAttribute('aria-pressed', 'false');
});

test('a lost logout receipt shows a Vietnamese error and a retry safely returns to guest', async ({ page }) => {
  await page.goto('/');
  await unlockAdmin(page);
  await page.route('**/api/logout', async route => { await route.fetch(); await route.abort(); }, { times: 1 });
  await page.getByTestId('admin-toggle').click();
  await expect(page.getByRole('alert')).toContainText('Chưa thoát được quyền.');
  await expect(page.getByTestId('admin-toggle')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('admin-toggle').click();
  await expect(page.getByTestId('scream-home')).toBeVisible();
});

test('the 320px PIN dialog supports keyboard use and clears a cancelled PIN', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/');
  await page.getByTestId('admin-toggle').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('admin-pin')).toBeFocused();
  await page.getByTestId('admin-pin').fill('123456');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('admin-toggle')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('admin-pin')).toHaveValue('');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  const badge = await page.getByTestId('admin-toggle').boundingBox();
  expect(badge?.width).toBe(44); expect(badge?.height).toBe(44);
});
