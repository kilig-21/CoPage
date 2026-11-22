import { defineConfig } from '@playwright/test'

const { COPAGE_E2E_FRONTEND_ORIGIN: frontend, COPAGE_E2E_BACKEND_ORIGIN: backend,
  COPAGE_E2E_SECONDARY_BACKEND_ORIGIN: secondary,
  COPAGE_E2E_PROJECT: project, COPAGE_E2E_BROWSER_CHANNEL: channel } = process.env
const loopback = /^http:\/\/127\.0\.0\.1:\d+$/
if (!loopback.test(frontend ?? '') || !loopback.test(backend ?? '') || !loopback.test(secondary ?? '') ||
    backend === secondary || !/^copage-prod-qa-[0-9a-f]{12}$/.test(project ?? '')) {
  throw new Error('Use npm run test:e2e to provision a fresh isolated CoPage stack.')
}

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 12_000 },
  workers: 1,
  retries: 0,
  outputDir: 'test-results/e2e',
  reporter: 'line',
  use: {
    baseURL: frontend,
    browserName: 'chromium',
    actionTimeout: 12_000,
    navigationTimeout: 25_000,
    ...(channel ? { channel } : {}),
    screenshot: 'only-on-failure',
    trace: { mode: 'retain-on-failure', sources: false },
  },
})
