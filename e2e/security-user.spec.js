const { test, expect } = require('./helpers/fixtures');
const { login, logout, openSecurity, openAlert, confirmModalAction } = require('./helpers/ui');
const { withTestRedis } = require('./helpers/accounts');
const { getAlertForUser, securitySnapshot } = require('./helpers/security');

const MOBILE_SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

async function createMobileEnvironment(browser, ownerPage, account) {
  const context = await browser.newContext({ baseURL: new URL(ownerPage.url()).origin, userAgent: MOBILE_SAFARI_UA });
  const page = await context.newPage();
  await login(page, account);
  const alert = await getAlertForUser(account.userId, 'NEW_LOGIN_ENVIRONMENT');
  expect(alert).toBeTruthy();
  return { context, page, alert };
}

test('E2E-10: USER Security Center chỉ liệt kê cảnh báo thuộc tài khoản hiện tại', async ({ page, browser, accounts }) => {
  await login(page, accounts.user);
  const otherContext = await browser.newContext({ baseURL: new URL(page.url()).origin, userAgent: MOBILE_SAFARI_UA });
  try {
    const otherPage = await otherContext.newPage();
    await login(otherPage, accounts.user);
    await expect(otherPage).toHaveURL(/dashboard\.html$/);
  } finally { await otherContext.close(); }
  await openSecurity(page);
  await expect(page.locator('#securityRows')).toContainText('Môi trường đăng nhập mới');
  await expect(page.locator('#securityRows')).toContainText('Trung bình');
  const list = await (await page.request.get('/api/security/alerts')).json();
  expect(list.items).toHaveLength(1);
  expect(list.items[0].userId).toBe(accounts.user.userId);
  expect(list.items[0].alertType).toBe('NEW_LOGIN_ENVIRONMENT');
});

test('E2E-11: USER mở chi tiết cảnh báo và xem đúng thông tin, không có secret', async ({ page, browser, accounts }) => {
  await login(page, accounts.user);
  const { context, alert } = await createMobileEnvironment(browser, page, accounts.user);
  try {
    await openAlert(page, alert.alertId);
    await expect(page.locator('#detailTitle')).toContainText('Phát hiện đăng nhập từ thiết bị hoặc trình duyệt mới');
    await expect(page.locator('#detailReasons')).toContainText('Thiết bị / trình duyệt mới');
    await expect(page.locator('#detailSession')).toContainText('Đang hoạt động');
    const detail = await (await page.request.get(`/api/security/alerts/${alert.alertId}`)).text();
    expect(detail).not.toContain('passwordHash');
    expect(detail).not.toContain(accounts.user.password);
    expect(detail).not.toContain('managementId');
    expect(detail).not.toContain('sessionId');
  } finally { await context.close(); }
});

test('E2E-12: USER đánh dấu đã xem và trạng thái giữ nguyên sau tải lại', async ({ page, browser, accounts }) => {
  await login(page, accounts.user);
  const { context, alert } = await createMobileEnvironment(browser, page, accounts.user);
  try {
    await openAlert(page, alert.alertId);
    const readResponse = page.waitForResponse((response) => response.url().includes(`/api/security/alerts/${alert.alertId}/read`));
    await page.locator('#markReadBtn').click();
    expect((await readResponse).status()).toBe(200);
    await expect(page.locator('#markReadBtn')).toBeHidden();
    await expect(page.locator('#detailMeta')).toContainText('Đang mở');
    const stored = await withTestRedis((client) => client.hGetAll(`security:alert:${alert.alertId}`));
    expect(Number(stored.readAt)).toBeGreaterThan(0);
    expect(stored.status).toBe('OPEN');
    await page.reload();
    await openAlert(page, alert.alertId);
    await expect(page.locator('#markReadBtn')).toBeHidden();
    await expect(page.locator('#securityRows')).toContainText('Đã xem');
  } finally { await context.close(); }
});

test('E2E-13: USER xác nhận cảnh báo an toàn mà không thu hồi session', async ({ page, browser, accounts }) => {
  await login(page, accounts.user);
  const { context, alert } = await createMobileEnvironment(browser, page, accounts.user);
  try {
    const beforeSessions = await withTestRedis((client) => client.sCard(`user:sessions:${accounts.user.userId}`));
    await openAlert(page, alert.alertId);
    expect(await page.evaluate(() => typeof window.appConfirm)).toBe('function');
    await page.evaluate(() => {
      const original = window.appConfirm;
      window.appConfirm = (...args) => original(...args).then((result) => { window.__e2eConfirmResult = result; return result; });
    });
    let resolveRequests = 0;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.endsWith(`/api/security/alerts/${alert.alertId}/resolve`)) resolveRequests += 1;
    });
    await page.locator('#resolveSafeBtn').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.locator('#resolveSafeBtn')).toBeDisabled();
    await page.getByRole('dialog').getByRole('button', { name: 'Hủy', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.locator('#resolveSafeBtn')).toBeEnabled();
    expect(await page.evaluate(() => window.__e2eConfirmResult)).toBe(false);
    expect(resolveRequests).toBe(0);
    expect((await withTestRedis((client) => client.hGet(`security:alert:${alert.alertId}`, 'status'))).trim()).toBe('OPEN');

    await page.locator('#resolveSafeBtn').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const resolveResponse = await confirmModalAction(page, `/api/security/alerts/${alert.alertId}/resolve`);
    expect(await page.evaluate(() => window.__e2eConfirmResult)).toBe(true);
    expect(resolveResponse.status()).toBe(200);
    expect(resolveRequests).toBe(1);
    await expect(page.locator('#detailMeta')).toContainText('Đã xác nhận an toàn');
    const stored = await withTestRedis((client) => client.hGetAll(`security:alert:${alert.alertId}`));
    expect(stored.status).toBe('RESOLVED_SAFE');
    expect(Number(stored.resolvedAt)).toBeGreaterThan(0);
    expect(stored.resolvedBy).toBe(accounts.user.userId);
    expect(await withTestRedis((client) => client.sCard(`user:sessions:${accounts.user.userId}`))).toBe(beforeSessions);
  } finally { await context.close(); }
});

test('E2E-13a: lỗi API resolve hiện thông báo và mở lại nút thao tác', async ({ page, browser, accounts }) => {
  await login(page, accounts.user);
  const { context, alert } = await createMobileEnvironment(browser, page, accounts.user);
  try {
    await openAlert(page, alert.alertId);
    const origin = new URL(page.url()).origin;
    const alreadyResolved = await page.request.patch(`/api/security/alerts/${alert.alertId}/resolve`, {
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      data: { action: 'safe' },
    });
    expect(alreadyResolved.status()).toBe(200);

    await page.locator('#resolveSafeBtn').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const resolveResponse = await confirmModalAction(page, `/api/security/alerts/${alert.alertId}/resolve`);
    expect(resolveResponse.status()).toBe(409);
    await expect(page.locator('#securityNotice')).toBeVisible();
    await expect(page.locator('#securityNotice')).toContainText(/thay đổi|xử lý|làm mới/i);
    await expect(page.locator('#resolveSafeBtn')).toBeEnabled();
    expect((await withTestRedis((client) => client.hGet(`security:alert:${alert.alertId}`, 'status'))).trim()).toBe('RESOLVED_SAFE');
  } finally { await context.close(); }
});

test('E2E-14: USER thu hồi phiên browser context liên quan và giữ phiên hiện tại', async ({ page, browser, accounts }) => {
  await login(page, accounts.user);
  const targetContext = await browser.newContext({ baseURL: new URL(page.url()).origin, userAgent: MOBILE_SAFARI_UA });
  try {
      const targetPage = await targetContext.newPage();
      await login(targetPage, accounts.user);
      const alert = await getAlertForUser(accounts.user.userId, 'NEW_LOGIN_ENVIRONMENT');
      expect(alert).toBeTruthy();
      const targetSessionId = (await targetContext.cookies()).find((item) => item.name === 'sessionId').value;
      const targetSession = await withTestRedis(async (client) => ({
        hash: await client.hGetAll(`session:${targetSessionId}`),
        userSessions: await client.sMembers(`user:sessions:${accounts.user.userId}`),
      }));
      const targetManagementId = targetSession.hash.managementId;
      expect(targetManagementId).toBeTruthy();

      await openAlert(page, alert.alertId);
      await page.locator('#revokeAlertSessionBtn').click();
      await page.getByRole('dialog').getByRole('button', { name: 'Xác nhận' }).click();
      await expect(page.locator('#detailMeta')).toContainText('Đã thu hồi phiên');
      expect((await targetPage.request.get('/api/me')).status()).toBe(401);
      expect((await page.request.get('/api/me')).status()).toBe(200);
      const final = await withTestRedis(async (client) => ({
        sessionType: await client.type(`session:${targetSessionId}`),
        userIds: await client.sMembers(`user:sessions:${accounts.user.userId}`),
        orderScore: await client.zScore(`user:sessions:order:${accounts.user.userId}`, targetSessionId),
        alert: await client.hGetAll(`security:alert:${alert.alertId}`),
        relatedManagementId: await client.hGet(`security:alert:${alert.alertId}`, 'relatedManagementId'),
      }));
      expect(final.sessionType).toBe('none');
      expect(final.userIds).not.toContain(targetSessionId);
      expect(final.orderScore).toBeNull();
      expect(final.alert.status).toBe('RESOLVED_REVOKED');
      expect(final.relatedManagementId).toBe(targetManagementId);
  } finally { await targetContext.close(); }
});

test('E2E-15: không báo thu hồi thành công nếu phiên liên quan đã hết hạn trước đó', async ({ page, browser, accounts }) => {
  await login(page, accounts.user);
  const { context, page: targetPage, alert } = await createMobileEnvironment(browser, page, accounts.user);
  try {
    await logout(targetPage);
    const response = await page.request.post(`/api/security/alerts/${alert.alertId}/revoke-session`, {
      headers: { Origin: new URL(page.url()).origin },
    });
    expect(response.status()).toBe(409);
    expect((await response.json()).sessionActive).toBe(false);
    const stored = await withTestRedis((client) => client.hGetAll(`security:alert:${alert.alertId}`));
    expect(stored.status).toBe('OPEN');
    expect((await page.request.get('/api/me')).status()).toBe(200);
  } finally { await context.close(); }
});

test('E2E-20: USER A không đọc hoặc thay đổi cảnh báo USER B', async ({ page, browser, accounts }) => {
  await login(page, accounts.user);
  const otherContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const otherPage = await otherContext.newPage();
    await login(otherPage, accounts.otherUser);
    const environment = await browser.newContext({ baseURL: new URL(page.url()).origin, userAgent: MOBILE_SAFARI_UA });
    try {
      const environmentPage = await environment.newPage();
      await login(environmentPage, accounts.otherUser);
    } finally { await environment.close(); }
    const alert = await getAlertForUser(accounts.otherUser.userId, 'NEW_LOGIN_ENVIRONMENT');
    expect(alert).toBeTruthy();
    const read = await page.request.get(`/api/security/alerts/${alert.alertId}`);
    const mutation = await page.request.patch(`/api/security/alerts/${alert.alertId}/read`, {
      headers: { Origin: new URL(page.url()).origin },
    });
    expect(read.status()).toBe(404);
    expect(mutation.status()).toBe(404);
    expect((await withTestRedis((client) => client.hGet(`security:alert:${alert.alertId}`, 'readAt'))).trim()).toBe('');
    expect((await page.request.get('/api/me')).status()).toBe(200);
    await otherPage.goto('/security.html');
    await expect(otherPage.locator('#securityRows')).toContainText('Môi trường đăng nhập mới');
  } finally { await otherContext.close(); }
});

test('E2E-21: thiếu Origin hoặc Origin sai bị từ chối, cảnh báo không đổi', async ({ page, browser, accounts }) => {
  await login(page, accounts.user);
  const { context, alert } = await createMobileEnvironment(browser, page, accounts.user);
  try {
    const origin = new URL(page.url()).origin;
    for (const headers of [{ Origin: 'https://invalid.example' }, {}]) {
      const response = await page.request.patch(`/api/security/alerts/${alert.alertId}/read`, { headers });
      expect(response.status()).toBe(403);
    }
    const data = await withTestRedis((client) => client.hGetAll(`security:alert:${alert.alertId}`));
    expect(data.status).toBe('OPEN');
    expect(data.readAt || '').toBe('');
    expect((await page.request.get('/api/me')).status()).toBe(200);
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:3100$/);
  } finally { await context.close(); }
});

test('E2E-28: API, UI, alert indexes, event stream và session Redis nhất quán', async ({ page, browser, accounts }) => {
  await login(page, accounts.user);
  const { context, alert } = await createMobileEnvironment(browser, page, accounts.user);
  try {
    const initial = await securitySnapshot(accounts.user.userId, alert.alertId);
    expect(initial.alert.status).toBe('OPEN');
    expect(initial.userScore).not.toBeNull();
    expect(initial.globalScore).not.toBeNull();
    expect(initial.openUser).not.toBeNull();
    expect(initial.openGlobal).not.toBeNull();
    expect(initial.eventsType).toBe('stream');

    await openAlert(page, alert.alertId);
    const readResponse = page.waitForResponse((response) => response.url().includes(`/api/security/alerts/${alert.alertId}/read`));
    await page.locator('#markReadBtn').click();
    expect((await readResponse).status()).toBe(200);
    const afterRead = await withTestRedis((client) => client.hGetAll(`security:alert:${alert.alertId}`));
    expect(Number(afterRead.readAt)).toBeGreaterThan(0);
    expect(afterRead.status).toBe('OPEN');

    await page.locator('#resolveSafeBtn').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const resolveResponse = await confirmModalAction(page, `/api/security/alerts/${alert.alertId}/resolve`);
    expect(resolveResponse.status()).toBe(200);
    const resolved = await withTestRedis(async (client) => ({
      alert: await client.hGetAll(`security:alert:${alert.alertId}`),
      openUser: await client.zScore(`security:user:alerts:${accounts.user.userId}:open`, alert.alertId),
      resolvedUser: await client.zScore(`security:user:alerts:${accounts.user.userId}:resolved`, alert.alertId),
      events: await client.xRange(`security:alert:events:${alert.alertId}`, '-', '+'),
    }));
    expect(resolved.alert.status).toBe('RESOLVED_SAFE');
    expect(resolved.openUser).toBeNull();
    expect(resolved.resolvedUser).not.toBeNull();
    expect(resolved.events.map((event) => event.message.eventType)).toEqual(expect.arrayContaining(['ALERT_CREATED', 'ALERT_READ', 'ALERT_RESOLVED_SAFE']));
  } finally { await context.close(); }
});
