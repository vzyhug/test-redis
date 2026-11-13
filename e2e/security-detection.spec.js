const { test, expect } = require('./helpers/fixtures');
const { login, logout, openSecurity } = require('./helpers/ui');
const { withTestRedis } = require('./helpers/accounts');
const { getAlertForUser, listUserAlerts } = require('./helpers/security');
const MOBILE_SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

test('E2E-04: đăng nhập đầu tiên tạo baseline mà không cảnh báo', async ({ page, accounts }) => {
  await login(page, accounts.user);
  const firstAlerts = await listUserAlerts(accounts.user.userId);
  expect(firstAlerts).toEqual([]);
  const baseline = await withTestRedis((client) => client.get(`security:baseline:${accounts.user.userId}`));
  expect(baseline).toBeTruthy();
  await openSecurity(page);
  await expect(page.locator('#securityRows')).toContainText('Chưa phát hiện cảnh báo bảo mật nào.');
});

test('E2E-05: đăng nhập lại bằng cùng Chromium và IP không phát cảnh báo', async ({ page, accounts }) => {
  await login(page, accounts.user);
  await logout(page);
  await login(page, accounts.user);
  await openSecurity(page);
  expect(await listUserAlerts(accounts.user.userId)).toEqual([]);
  await expect(page.locator('#securityRows')).toContainText('Chưa phát hiện cảnh báo bảo mật nào.');
});

test('E2E-06: browser context với User-Agent Safari/iPhone mới được phát hiện', async ({ page, browser, accounts }) => {
  await login(page, accounts.user);
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin, userAgent: MOBILE_SAFARI_UA });
  try {
    const alternatePage = await context.newPage();
    await login(alternatePage, accounts.user);
    const alert = await getAlertForUser(accounts.user.userId, 'NEW_LOGIN_ENVIRONMENT');
    expect(alert).toBeTruthy();
    expect(alert.severity).toBe('MEDIUM');
    expect(alert.reasons.split(',')).toContain('NEW_DEVICE');
    expect(alert.device).toMatch(/Safari.*iOS.*Mobile/i);
    expect(Number(alert.createdAtMs)).toBeGreaterThan(0);
    await expect(context.cookies()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'sessionId' })]));
    await openSecurity(alternatePage);
    await expect(alternatePage.locator('#securityRows')).toContainText('Safari');
    expect(await withTestRedis((client) => client.type(`security:alert:${alert.alertId}`))).toBe('hash');
  } finally { await context.close(); }
});

test('E2E-07: đăng nhập lại từ cùng browser context không tạo cảnh báo trùng', async ({ page, browser, accounts }) => {
  await login(page, accounts.user);
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin, userAgent: MOBILE_SAFARI_UA });
  try {
    const alternatePage = await context.newPage();
    await login(alternatePage, accounts.user);
    await logout(alternatePage);
    await login(alternatePage, accounts.user);
    const alerts = await listUserAlerts(accounts.user.userId);
    expect(alerts.filter((item) => item.alertType === 'NEW_LOGIN_ENVIRONMENT')).toHaveLength(1);
    await openSecurity(alternatePage);
    await expect(alternatePage.locator('#securityRows tr')).toHaveCount(1);
  } finally { await context.close(); }
});

test.skip('E2E-08: NOT RUN — không thể tạo hai IP nguồn thật khác nhau trong browser test cô lập', async () => {
  // Không giả lập phát hiện IP mới bằng X-Forwarded-For; ứng dụng không bật trust proxy.
});

test('E2E-09: lần sai thứ năm khóa tài khoản và tạo duy nhất một cảnh báo HIGH', async ({ page, accounts }) => {
  await page.goto('/login.html');
  await page.locator('#username').fill(accounts.user.username);
  await page.locator('#password').fill('incorrect-e2e-password');
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/login') && response.request().method() === 'POST');
    await page.locator('#loginBtn').click();
    const response = await responsePromise;
    expect(response.status(), `failed login #${attempt}`).toBe(attempt === 5 ? 429 : 401);
  }
  await expect(page.locator('#errorBox')).toBeVisible();
  const extraAttempt = page.waitForResponse((response) => response.url().endsWith('/api/login') && response.request().method() === 'POST');
  await page.locator('#loginBtn').click();
  expect((await extraAttempt).status()).toBe(429);
  const alert = await getAlertForUser(accounts.user.userId, 'LOGIN_LOCKOUT');
  expect(alert).toBeTruthy();
  expect(alert.severity).toBe('HIGH');
  expect(alert.failureCount).toBe('5');
  expect(await withTestRedis((client) => client.sCard(`user:sessions:${accounts.user.userId}`))).toBe(0);
  expect((await listUserAlerts(accounts.user.userId)).filter((item) => item.alertType === 'LOGIN_LOCKOUT')).toHaveLength(1);

  await login(page, accounts.admin);
  await openSecurity(page);
  await page.locator('#securitySeverity').selectOption('HIGH');
  await page.locator('#securityFilters').getByRole('button', { name: 'Áp dụng' }).click();
  await expect(page.locator('#securityRows')).toContainText(accounts.user.username);
  await expect(page.locator('#securityRows')).toContainText('Cao');
});
