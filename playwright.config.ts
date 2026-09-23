import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/host',
  workers: 1,
  timeout: 60000,
  use: {
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node scripts/serve-host.mjs',
    url: `http://127.0.0.1:${process.env.MCUI_HOST_PORT ?? '4178'}`,
    reuseExistingServer: !process.env.MCUI_HOST_PORT,
    timeout: 30000,
  },
});
