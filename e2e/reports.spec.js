const { test, expect } = require('./helpers/fixtures');
const { login } = require('./helpers/ui');
const { withTestRedis } = require('./helpers/accounts');
const { getAlertForUser } = require('./helpers/security');

const MOBILE_SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function parseCsv(source) {
  const text = source.replace(/^\uFEFF/, '');
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += char;
  }
  return rows.filter((values) => values.some((value) => value !== ''));
}

async function downloadCsv(page, button) {
  const downloadWait = page.waitForEvent('download');
  await button.click();
  const download = await downloadWait;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return { download, text: Buffer.concat(chunks).toString('utf8') };
}

async function vnToday(page) {
  return page.evaluate(() => new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10));
}

test('E2E-EX-01: USER tải CSV lịch sử thật, tiếng Việt và chỉ dữ liệu cá nhân', async ({ page, accounts }) => {
  await login(page, accounts.user);
  await page.goto('/reports.html');
  await expect(page.locator('#reportsLoading')).toBeHidden();
  await expect(page.getByLabel('Tài khoản (user ID)').first()).toBeHidden();
  const { download, text } = await downloadCsv(page, page.getByRole('button', { name: 'Xuất lịch sử CSV' }));
  const rows = parseCsv(text);
  expect(download.suggestedFilename()).toMatch(/^lich-su-hoat-dong-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(rows[0]).toEqual(['STT', 'Thời gian (Asia/Ho_Chi_Minh)', 'Tài khoản', 'Loại sự kiện', 'Kết quả', 'Thiết bị', 'Địa chỉ IP', 'Mô tả']);
  expect(rows.slice(1).some((row) => row[2] === accounts.user.username && row[3] === 'LOGIN_SUCCESS')).toBe(true);
  expect(text).not.toContain(accounts.user.password);
  expect(text).not.toContain('passwordHash');
  await expect(page.locator('#reportsNotice')).toContainText('Đã tải báo cáo CSV thành công');
});

test('E2E-EX-02: USER tải cảnh báo hiện tại từ Redis, không thấy lựa chọn tài khoản', async ({ page, browser, accounts }) => {
  await login(page, accounts.user);
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin, userAgent: MOBILE_SAFARI_UA });
  try {
    const secondPage = await context.newPage();
    await login(secondPage, accounts.user);
    const alert = await getAlertForUser(accounts.user.userId, 'NEW_LOGIN_ENVIRONMENT');
    expect(alert).toBeTruthy();
    await page.goto('/reports.html');
    await expect(page.locator('#reportsLoading')).toBeHidden();
    await expect(page.locator('.admin-report-filter').first()).toBeHidden();
    const { text } = await downloadCsv(page, page.getByRole('button', { name: 'Xuất cảnh báo CSV' }));
    const rows = parseCsv(text);
    expect(rows[0]).toContain('Mã cảnh báo');
    expect(rows.some((row) => row[1] === alert.alertId && row[3] === accounts.user.username)).toBe(true);
  } finally { await context.close(); }
});

test('E2E-EX-03: ADMIN exports global history and alerts, then filters to one account', async ({ page, browser, accounts }) => {
  await login(page, accounts.admin);
  const baseURL = new URL(page.url()).origin;
  const context = await browser.newContext({ baseURL });
  try {
    const userPage = await context.newPage();
    await login(userPage, accounts.user);
    const mobileContext = await browser.newContext({ baseURL, userAgent: MOBILE_SAFARI_UA });
    try { await login(await mobileContext.newPage(), accounts.user); }
    finally { await mobileContext.close(); }
    const userAlert = await getAlertForUser(accounts.user.userId, 'NEW_LOGIN_ENVIRONMENT');
    expect(userAlert).toBeTruthy();
    await page.goto('/reports.html');
    await expect(page.locator('#reportsLoading')).toBeHidden();
    const accountFilter = page.locator('#historyExportUser');
    await expect(accountFilter).toBeVisible();
    await accountFilter.fill(accounts.user.userId);
    const filtered = await downloadCsv(page, page.getByRole('button', { name: 'Xuất lịch sử CSV' }));
    const filteredRows = parseCsv(filtered.text).slice(1);
    expect(filteredRows.length).toBeGreaterThan(0);
    expect(filteredRows.every((row) => row[2] === accounts.user.username)).toBe(true);

    await accountFilter.fill('');
    const all = await downloadCsv(page, page.getByRole('button', { name: 'Xuất lịch sử CSV' }));
    const allRows = parseCsv(all.text).slice(1);
    expect(allRows.some((row) => row[2] === accounts.user.username)).toBe(true);
    expect(allRows.some((row) => row[2] === accounts.admin.username)).toBe(true);

    const alertFilter = page.locator('#securityExportUser');
    await alertFilter.fill(accounts.user.userId);
    const filteredAlerts = await downloadCsv(page, page.getByRole('button', { name: 'Xuất cảnh báo CSV' }));
    const filteredAlertRows = parseCsv(filteredAlerts.text).slice(1);
    expect(filteredAlertRows.length).toBeGreaterThan(0);
    expect(filteredAlertRows.every((row) => row[3] === accounts.user.username)).toBe(true);
    await alertFilter.fill('');
    const allAlerts = await downloadCsv(page, page.getByRole('button', { name: 'Xuất cảnh báo CSV' }));
    expect(parseCsv(allAlerts.text).some((row) => row[1] === userAlert.alertId)).toBe(true);
  } finally { await context.close(); }
});

test('E2E-EX-04: daily summary matches audit data and follows Vietnam day', async ({ page, accounts }) => {
  await login(page, accounts.user);
  const today = await vnToday(page);
  const failedLogin = await page.request.post('/api/login', {
    headers: { 'Content-Type': 'application/json', Origin: new URL(page.url()).origin },
    data: { username: accounts.user.username, password: 'known-wrong-password' },
  });
  expect(failedLogin.status()).toBe(401);
  await page.goto('/reports.html');
  await expect(page.locator('#reportsLoading')).toBeHidden();
  await page.setViewportSize({ width: 375, height: 812 });
  const widths = await page.evaluate(() => ({ root: document.documentElement.scrollWidth, viewport: window.innerWidth }));
  expect(widths.root).toBeLessThanOrEqual(widths.viewport + 1);
  await page.locator('#summaryExportFrom').fill(today);
  await page.locator('#summaryExportTo').fill(today);
  const { text } = await downloadCsv(page, page.getByRole('button', { name: 'Xuất thống kê CSV' }));
  const rows = parseCsv(text);
  const current = rows.find((row) => row[0] === today);
  expect(current).toBeTruthy();
  expect(Number(current[1])).toBe(1);
  expect(Number(current[2])).toBe(1);
});

test('E2E-EX-05: empty result downloads header-only CSV; invalid dates and API errors are shown', async ({ page, accounts }) => {
  await login(page, accounts.user);
  await page.goto('/reports.html');
  await expect(page.locator('#reportsLoading')).toBeHidden();
  const old = await page.evaluate(() => {
    const date = new Date(Date.now() + 7 * 60 * 60 * 1000);
    date.setUTCDate(date.getUTCDate() - 20);
    return date.toISOString().slice(0, 10);
  });
  await page.locator('#historyExportFrom').fill(old);
  await page.locator('#historyExportTo').fill(old);
  const empty = await downloadCsv(page, page.getByRole('button', { name: 'Xuất lịch sử CSV' }));
  expect(parseCsv(empty.text)).toHaveLength(1);
  await expect(page.locator('#reportsNotice')).toContainText('CSV chỉ gồm tiêu đề');

  const today = await vnToday(page);
  const yesterday = await page.evaluate(() => {
    const date = new Date(Date.now() + 7 * 60 * 60 * 1000); date.setUTCDate(date.getUTCDate() - 1); return date.toISOString().slice(0, 10);
  });
  await page.locator('#historyExportFrom').fill(today);
  await page.locator('#historyExportTo').fill(yesterday);
  await page.getByRole('button', { name: 'Xuất lịch sử CSV' }).click();
  await expect(page.locator('#reportsNotice')).toContainText('Ngày bắt đầu phải nhỏ hơn');

  await page.locator('#historyExportFrom').fill(today);
  await page.locator('#historyExportTo').fill(today);
  await page.route('**/api/reports/history/export?**', (route) => route.abort('failed'));
  await page.getByRole('button', { name: 'Xuất lịch sử CSV' }).click();
  await expect(page.locator('#reportsNotice')).toContainText('Failed to fetch');
});

test('E2E-EX-06: expired session redirects to login without downloading JSON as CSV', async ({ page, accounts }) => {
  await login(page, accounts.user);
  await page.goto('/reports.html');
  await expect(page.locator('#reportsLoading')).toBeHidden();
  await page.context().clearCookies();
  await page.getByRole('button', { name: 'Xuất lịch sử CSV' }).click();
  await expect(page).toHaveURL(/login\.html$/);
});
