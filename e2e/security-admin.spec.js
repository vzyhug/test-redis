const { test, expect } = require('./helpers/fixtures');
const { login, openSecurity, openAlert, confirmModalAction } = require('./helpers/ui');
const { withTestRedis } = require('./helpers/accounts');
const { getAlertForUser } = require('./helpers/security');

const MOBILE_SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

async function createAlertFor(browser, baseURL, account) {
  const baselineContext = await browser.newContext({ baseURL });
  try {
    const baselinePage = await baselineContext.newPage();
    await login(baselinePage, account);
  } finally { await baselineContext.close(); }
  const context = await browser.newContext({ baseURL, userAgent: MOBILE_SAFARI_UA });
  try {
    const page = await context.newPage();
    await login(page, account);
    const alert = await getAlertForUser(account.userId, 'NEW_LOGIN_ENVIRONMENT');
    expect(alert).toBeTruthy();
    return alert;
  } finally { await context.close(); }
}

test('E2E-16: ADMIN xem được cảnh báo thuộc nhiều tài khoản qua API và UI', async ({ page, browser, accounts }) => {
  const baseURL = 'http://127.0.0.1:3100';
  const userAlert = await createAlertFor(browser, baseURL, accounts.user);
  const otherAlert = await createAlertFor(browser, baseURL, accounts.otherUser);
  await login(page, accounts.admin);
  await openSecurity(page);
  await expect(page.locator('#securityRows')).toContainText(accounts.user.username);
  await expect(page.locator('#securityRows')).toContainText(accounts.otherUser.username);
  const response = await page.request.get('/api/admin/security/alerts');
  const result = await response.json();
  expect(response.status()).toBe(200);
  expect(result.items.map((alert) => alert.alertId)).toEqual(expect.arrayContaining([userAlert.alertId, otherAlert.alertId]));
  const raw = JSON.stringify(result);
  expect(raw).not.toContain('passwordHash');
  expect(raw).not.toContain('managementId');
  expect(raw).not.toContain('sessionId');
});

test('E2E-17: ADMIN lọc cảnh báo theo loại, mức độ, trạng thái và tài khoản', async ({ page, browser, accounts }) => {
  await createAlertFor(browser, 'http://127.0.0.1:3100', accounts.user);
  await createAlertFor(browser, 'http://127.0.0.1:3100', accounts.otherUser);
  await login(page, accounts.admin);
  await openSecurity(page);
  await expect(page.locator('#securitySearchLabel')).toBeVisible();
  await page.locator('#securitySeverity').selectOption('MEDIUM');
  await page.locator('#securityType').selectOption('NEW_LOGIN_ENVIRONMENT');
  await page.locator('#securityStatus').selectOption('OPEN');
  await page.locator('#securitySearch').fill(accounts.user.username);
  await page.locator('#securityFilters').getByRole('button', { name: 'Áp dụng' }).click();
  await expect(page.locator('#securityRows')).toContainText(accounts.user.username);
  await expect(page.locator('#securityRows')).not.toContainText(accounts.otherUser.username);
  const response = await page.request.get(`/api/admin/security/alerts?severity=MEDIUM&alertType=NEW_LOGIN_ENVIRONMENT&status=OPEN&q=${accounts.user.username}`);
  expect(response.status()).toBe(200);
  expect((await response.json()).items).toHaveLength(1);
});

test('E2E-18: ADMIN xác nhận an toàn cảnh báo USER và USER thấy actor/trạng thái', async ({ page, browser, accounts }) => {
  const alert = await createAlertFor(browser, 'http://127.0.0.1:3100', accounts.user);
  await login(page, accounts.admin);
  await openSecurity(page);
  await page.getByRole('button', { name: 'Chi tiết' }).first().click();
  await expect(page.locator('#detailMeta')).toContainText(accounts.user.username);
  expect(await page.evaluate(() => typeof window.appConfirm)).toBe('function');
  await page.locator('#resolveSafeBtn').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  const resolveResponse = await confirmModalAction(page, `/api/admin/security/alerts/${alert.alertId}/resolve`);
  expect(resolveResponse.status()).toBe(200);
  await expect(page.locator('#detailMeta')).toContainText('Đã xác nhận an toàn');
  const stored = await withTestRedis((client) => client.hGetAll(`security:alert:${alert.alertId}`));
  expect(stored.status).toBe('RESOLVED_SAFE');
  expect(stored.resolvedBy).toBe(accounts.admin.userId);

  const userContext = await browser.newContext({ baseURL: 'http://127.0.0.1:3100' });
  try {
    const userPage = await userContext.newPage();
    await login(userPage, accounts.user);
    await openSecurity(userPage);
    await userPage.getByRole('button', { name: 'Chi tiết' }).click();
    await expect(userPage.locator('#detailMeta')).toContainText('Đã xác nhận an toàn');
    await expect(userPage.locator('#detailResolver')).toHaveText(accounts.admin.userId);
  } finally { await userContext.close(); }
});

test('E2E-19: ADMIN thu hồi session liên quan của USER, session ADMIN vẫn còn', async ({ page, browser, accounts }) => {
  await login(page, accounts.user);
  const targetContext = await browser.newContext({ baseURL: 'http://127.0.0.1:3100', userAgent: MOBILE_SAFARI_UA });
  try {
      const targetPage = await targetContext.newPage();
      await login(targetPage, accounts.user);
      const alert = await getAlertForUser(accounts.user.userId, 'NEW_LOGIN_ENVIRONMENT');
      expect(alert).toBeTruthy();
      const cookie = (await targetContext.cookies()).find((item) => item.name === 'sessionId');
      const targetSession = await withTestRedis((client) => client.hGetAll(`session:${cookie.value}`));
      const managementId = targetSession.managementId;
      await login(page, accounts.admin);
      await openSecurity(page);
      await page.getByRole('button', { name: 'Chi tiết' }).first().click();
      await page.locator('#revokeAlertSessionBtn').click();
      await page.getByRole('dialog').getByRole('button', { name: 'Xác nhận' }).click();
      await expect(page.locator('#detailMeta')).toContainText('Đã thu hồi phiên');
      expect((await targetPage.request.get('/api/me')).status()).toBe(401);
      expect((await page.request.get('/api/me')).status()).toBe(200);
      const after = await withTestRedis(async (client) => ({
        hash: await client.type(`session:${cookie.value}`),
        member: await client.sIsMember(`user:sessions:${accounts.user.userId}`, cookie.value),
        order: await client.zScore(`user:sessions:order:${accounts.user.userId}`, cookie.value),
        relatedManagementId: await client.hGet(`security:alert:${alert.alertId}`, 'relatedManagementId'),
      }));
      expect(managementId).toBeTruthy();
      expect(after).toEqual({ hash: 'none', member: false, order: null, relatedManagementId: managementId });
  } finally { await targetContext.close(); }
});

test('E2E-22: ADMIN thu hồi session từ xa và USER bị đưa về Login ở request bảo vệ kế tiếp', async ({ page, browser, accounts }) => {
  const userContext = await browser.newContext({ baseURL: 'http://127.0.0.1:3100' });
  try {
    const userPage = await userContext.newPage();
    await login(userPage, accounts.user);
    const sessionsResponse = await userPage.request.get('/api/sessions');
    const sessions = await sessionsResponse.json();
    const target = sessions.find((item) => item.current);
    expect(target.managementId).toBeTruthy();

    await login(page, accounts.admin);
    const revoke = await page.request.delete(`/api/admin/users/${accounts.user.userId}/sessions/${target.managementId}`, {
      headers: { Origin: 'http://127.0.0.1:3100' },
    });
    expect(revoke.status()).toBe(200);
    expect((await revoke.json()).success).toBe(true);
    const protectedResponse = await userPage.request.get('/api/me');
    expect(protectedResponse.status()).toBe(401);
    await userPage.goto('/dashboard.html');
    await expect(userPage).toHaveURL(/login\.html$/);
    expect((await page.request.get('/api/me')).status()).toBe(200);
  } finally { await userContext.close(); }
});
