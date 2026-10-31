import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './test/access', outputDir: 'test-results-access', workers: 1, fullyParallel: false, timeout: 90_000,
  expect: { timeout: 15_000 }, reporter: 'list',
  globalSetup: './test/access/setup.ts',
  use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 },
    baseURL: 'http://127.0.0.1:5177', trace: 'retain-on-failure' },
  webServer: {
    command: 'npm run dev -- --port 5177 --strictPort', url: 'http://127.0.0.1:5177',
    reuseExistingServer: false,
    env: { VITE_BACKEND: 'supabase', VITE_SUPABASE_URL: 'https://access-test.invalid',
      VITE_SUPABASE_ANON_KEY: 'local-test-publishable-key' },
  },
});
