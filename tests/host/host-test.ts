import { test as base } from '@playwright/test';
export { expect, type Page } from '@playwright/test';
/** Startup news is unrelated to local editing and rejects on intermittent CDN failures. */
export const test = base.extend<{ offlineStartup: void }>({
  offlineStartup: [
    async ({ context }, use) => {
      await context.route(
        /^https:\/\/web\.blockbench\.net\/content\/news\.json(?:\?.*)?$/,
        (route) => route.fulfill({ json: {} }),
      );
      await context.route(/^https:\/\/blckbn\.ch\/api\/stats\/plugins(?:\?.*)?$/, (route) =>
        route.fulfill({ json: {} }),
      );
      await use();
    },
    { auto: true },
  ],
});
