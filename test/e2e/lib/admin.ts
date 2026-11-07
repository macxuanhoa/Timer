import { expect, type Page } from '@playwright/test';
export async function unlockAdmin(page: Page) {
  await page.getByTestId('admin-toggle').click();
  await page.getByTestId('admin-pin').fill(process.env.SC_PASSCODE_SUPERVISOR ?? '211105');
  await page.getByTestId('admin-unlock').click();
  await expect(page.getByTestId('dashboard')).toBeVisible();
}
