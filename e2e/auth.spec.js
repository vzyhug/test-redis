const { test, expect } = require('./helpers/fixtures');
const { login, openSecurity } = require('./helpers/ui');
const { withTestRedis } = require('./helpers/accounts');

test('E2E-01: USER có thể đăng nhập bằng UI và session được ghi vào Redis test', async ({ page, accounts }) => {
  const consoleErrors = [];
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  await login(page, accounts.user);
  await expect(page).toHaveURL(/dashboard\.html$/);
  await expect(page.locator('#role')).toHaveText('USER');
  const me = await page.request.get('/api/me');
  expect(me.status()).toBe(200);
  expect((await me.json()).username).toBe(accounts.user.username);
  const cookie = (await page.context().cookies()).find((item) => item.name === 'sessionId');
  expect(cookie).toBeTruthy();
  const redisState = await withTestRedis(async (client) => ({
    userSessions: await client.sCard(`user:sessions:${accounts.user.userId}`),
    sessionType: await client.type(`session:${cookie.value}`),
    ttl: await client.ttl(`session:${cookie.value}`),
  }));
  expect(redisState).toMatchObject({ userSessions: 1, sessionType: 'hash' });
  expect(redisState.ttl).toBeGreaterThan(0);
  expect(consoleErrors).toEqual([]);
});

test('E2E-01a: hủy logout-all giữ nguyên session, xác nhận đăng xuất đúng một lần', async ({ page, accounts }) => {
  await login(page, accounts.user);
  const button = page.locator('#logoutAllBtn');
  let logoutRequests = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/logout-all') logoutRequests += 1;
  });

  await button.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(button).toBeDisabled();
  await page.getByRole('dialog').getByRole('button', { name: 'Hủy', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(button).toBeEnabled();
  expect(logoutRequests).toBe(0);
  expect(await withTestRedis((client) => client.sCard(`user:sessions:${accounts.user.userId}`))).toBe(1);

  const logoutResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/logout-all');
  await button.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Xác nhận', exact: true }).click();
  expect((await logoutResponse).status()).toBe(200);
  await expect(page).toHaveURL(/login\.html$/);
  expect(logoutRequests).toBe(1);
  expect(await withTestRedis((client) => client.sCard(`user:sessions:${accounts.user.userId}`))).toBe(0);
});

test('E2E-02: ADMIN đăng nhập và thấy chức năng quản trị', async ({ page, accounts }) => {
  await login(page, accounts.admin);
  await expect(page.locator('#role')).toHaveText('ADMIN');
  await expect(page.getByRole('link', { name: /Người dùng & phiên/ })).toBeVisible();
  const adminPage = await page.goto('/admin.html');
  expect(adminPage.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Quản trị hệ thống' })).toBeVisible();
});

test('E2E-03: USER bị từ chối trang và API ADMIN', async ({ page, accounts }) => {
  await login(page, accounts.user);
  await expect(page.locator('.nav-label.admin-nav')).toBeHidden();
  await expect(page.locator('.admin-nav').nth(1)).toBeHidden();
  const pageResponse = await page.goto('/admin.html');
  expect(pageResponse.status()).toBe(403);
  const apiResponse = await page.request.get('/api/admin/security/alerts');
  expect(apiResponse.status()).toBe(403);
  expect(await apiResponse.text()).not.toContain(accounts.otherUser.username);
});

test('E2E-23: Sidebar điều hướng đúng và chỉ hiện menu ADMIN cho ADMIN', async ({ page, accounts }) => {
  await login(page, accounts.user);
  await expect(page.getByRole('link', { name: 'Trung tâm bảo mật' })).toBeVisible();
  await page.getByRole('link', { name: 'Trung tâm bảo mật' }).click();
  await expect(page).toHaveURL(/security\.html$/);
  await expect(page.getByRole('link', { name: 'Trung tâm bảo mật' })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.nav-label.admin-nav')).toBeHidden();
  await expect(page.locator('.admin-nav').nth(1)).toBeHidden();
  const adminContext = await page.context().browser().newContext({ baseURL: new URL(page.url()).origin });
  try {
    const adminPage = await adminContext.newPage();
    await login(adminPage, accounts.admin);
    await expect(adminPage.getByRole('link', { name: /Người dùng & phiên/ })).toBeVisible();
  } finally { await adminContext.close(); }
});

test('E2E-24: Security Center responsive ở desktop, tablet và mobile', async ({ page, accounts }) => {
  await login(page, accounts.user);
  await openSecurity(page);
  for (const viewport of [{ width: 1366, height: 768 }, { width: 768, height: 1024 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(viewport);
    await expect(page.getByRole('heading', { name: 'Trung tâm bảo mật' })).toBeVisible();
    const widths = await page.evaluate(() => ({ root: document.documentElement.scrollWidth, viewport: window.innerWidth }));
    expect(widths.root, `horizontal overflow at ${viewport.width}x${viewport.height}`).toBeLessThanOrEqual(widths.viewport + 1);
    await expect(page.locator('#securityRefresh')).toBeVisible();
  }
  await expect(page.locator('#menuToggle')).toBeVisible();
  await page.locator('#menuToggle').click();
  await expect(page.locator('body')).toHaveClass(/drawer-open/);
  await page.getByRole('link', { name: 'Tổng quan' }).click();
  await expect(page.locator('body')).not.toHaveClass(/drawer-open/);
});

test('E2E-25: UI hiển thị loading, empty và lỗi tải cảnh báo', async ({ page, accounts }) => {
  await login(page, accounts.user);
  let releaseRequest;
  const gate = new Promise((resolve) => { releaseRequest = resolve; });
  await page.route('**/api/security/alerts?**', async (route) => { await gate; await route.continue(); });
  const navigation = page.goto('/security.html');
  await expect(page.locator('#securityRows')).toContainText('Đang tải cảnh báo');
  releaseRequest();
  await navigation;
  await expect(page.locator('#securityRows')).toContainText('Chưa phát hiện cảnh báo bảo mật nào.');
  await page.unroute('**/api/security/alerts?**');
  await page.route('**/api/security/alerts?**', (route) => route.abort('failed'));
  await page.locator('#securityRefresh').click();
  await expect(page.locator('#securityNotice')).toBeVisible();
  await expect(page.locator('#securityRows td.empty')).toContainText('Failed to fetch');
});

test('E2E-26: thao tác chính không tạo uncaught error hoặc request lỗi ngoài dự kiến', async ({ page, accounts, browserDiagnostics }) => {
  await login(page, accounts.user);
  await openSecurity(page);
  await page.locator('#securityRefresh').click();
  await expect(page.locator('#securityPageInfo')).not.toContainText('Đang tải');
  expect(browserDiagnostics).toEqual([]);
  const failedRequests = [];
  page.on('requestfailed', (request) => failedRequests.push(`${request.method()} ${request.url()}`));
  await page.reload();
  await expect(page.locator('#securityPageInfo')).not.toContainText('Đang tải');
  expect(failedRequests).toEqual([]);
});

test('E2E-27: API/UI không để lộ credential, cookie, Session ID hay dữ liệu USER khác', async ({ page, browser, accounts }) => {
  await login(page, accounts.user);
  const baseURL = new URL(page.url()).origin;
  const otherContext = await browser.newContext({ baseURL, userAgent: 'E2E-Isolated-Other-Account/1.0' });
  try {
    const otherPage = await otherContext.newPage();
    await login(otherPage, accounts.otherUser);
    await otherPage.goto('/security.html');
    await expect(otherPage.locator('#securityPageInfo')).not.toContainText('Đang tải');
    const listResponse = await otherPage.request.get('/api/security/alerts');
    const listText = await listResponse.text();
    expect(listText).not.toContain('passwordHash');
    expect(listText).not.toContain(accounts.user.username);
    expect(await otherPage.evaluate(() => Object.keys(localStorage))).toEqual([]);
  } finally { await otherContext.close(); }
  await openSecurity(page);
  const responses = await Promise.all([
    page.request.get('/api/security/overview'),
    page.request.get('/api/security/alerts'),
  ]);
  const body = await Promise.all(responses.map((response) => response.text()));
  const cookieValue = (await page.context().cookies()).find((item) => item.name === 'sessionId').value;
  expect(JSON.stringify(body)).not.toContain('passwordHash');
  expect(JSON.stringify(body)).not.toContain(accounts.user.password);
  expect(JSON.stringify(body)).not.toContain(cookieValue);
  expect(JSON.stringify(body)).not.toContain('sessionId');
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
});
