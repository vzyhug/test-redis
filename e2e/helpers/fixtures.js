const { test: base, expect } = require('@playwright/test');
const { seedAccounts } = require('./accounts');

const test = base.extend({
  accounts: async ({}, use) => use(await seedAccounts()),
  browserDiagnostics: async ({ page }, use, testInfo) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });
    await use(errors);
    await testInfo.attach('browser-errors.json', { body: JSON.stringify(errors, null, 2), contentType: 'application/json' });
  },
});

module.exports = { test, expect };
