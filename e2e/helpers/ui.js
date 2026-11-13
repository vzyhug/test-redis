const { expect } = require('@playwright/test');
const { TEST_PASSWORD } = require('./accounts');

async function login(page, account, password = account.password || TEST_PASSWORD) {
  await page.goto('/login.html');
  await page.locator('#username').fill(account.username);
  await page.locator('#password').fill(password);
  await Promise.all([
    page.waitForURL('**/dashboard.html'),
    page.getByRole('button', { name: 'Đăng nhập' }).click(),
  ]);
  await expect(page.locator('#sideUsername')).toHaveText(account.username);
}

async function logout(page) {
  await Promise.all([
    page.waitForURL('**/login.html'),
    page.locator('#sideLogout').click(),
  ]);
}

async function openSecurity(page) {
  await page.goto('/security.html');
  await expect(page.locator('#securityTotal')).not.toHaveText('—');
  await expect(page.locator('#securityPageInfo')).not.toContainText('Đang tải');
}

async function openAlert(page, alertId) {
  const response = await page.request.get(`/api/security/alerts/${alertId}`);
  expect(response.status()).toBe(200);
  await openSecurity(page);
  await expect(page.getByRole('button', { name: 'Chi tiết' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Chi tiết' }).first().click();
  await expect(page.locator('#securityDetail')).toBeVisible();
}

async function confirmModalAction(page, endpointPath, timeout = 5000) {
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  const responseWaiter = page.waitForResponse(
    (response) => new URL(response.url()).pathname.endsWith(endpointPath),
    { timeout },
  );
  await page.getByRole('dialog').getByRole('button', { name: 'Xác nhận', exact: true }).click();
  try {
    return await responseWaiter;
  } catch (error) {
    throw new Error(`${error.message}; browser errors=${JSON.stringify(browserErrors)}`);
  }
}

async function loginInNewContext(browser, baseURL, account, options = {}) {
  const context = await browser.newContext({ ...options, baseURL });
  const page = await context.newPage();
  await login(page, account);
  return { context, page };
}

module.exports = { login, logout, openSecurity, openAlert, confirmModalAction, loginInNewContext };
