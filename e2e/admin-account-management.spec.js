const { test, expect } = require('./helpers/fixtures');
const { login } = require('./helpers/ui');
const { withTestRedis } = require('./helpers/accounts');

test('E2E-29: Admin creates, edits, and deletes an account through the UI', async ({ page, accounts }) => {
  let createdUserId = null;
  let username = `ui_${Date.now().toString(36)}`;
  const updatedUsername = `${username}_edit`;
  try {
    await login(page, accounts.admin);
    const adminPage = await page.goto('/admin.html');
    expect(adminPage.status()).toBe(200);
    await page.locator('#createAccount').click();
    await page.locator('#accountUsername').fill(username);
    await page.locator('#accountEmail').fill(`${username}@example.test`);
    await page.locator('#accountPassword').fill('ui-test-account-password');

    const createResponsePromise = page.waitForResponse((response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/admin/users');
    await page.locator('#accountEditor button[type="submit"]').click();
    const createResponse = await createResponsePromise;
    expect(createResponse.status()).toBe(201);
    const created = await createResponse.json();
    createdUserId = created.user.userId;
    await expect(page.getByRole('row').filter({ hasText: username })).toBeVisible();

    await page.getByRole('row').filter({ hasText: username }).getByRole('button', { name: 'Sửa' }).click();
    await page.locator('#accountUsername').fill(updatedUsername);
    await page.locator('#accountEmail').fill(`${updatedUsername}@example.test`);
    await page.locator('#accountRole').selectOption('ADMIN');
    await page.locator('#accountPassword').fill('ui-test-updated-password');
    const updateResponsePromise = page.waitForResponse((response) =>
      response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/admin/users/${createdUserId}`);
    await page.locator('#accountEditor button[type="submit"]').click();
    expect((await updateResponsePromise).status()).toBe(200);
    const updatedRow = page.getByRole('row').filter({ hasText: updatedUsername });
    await expect(updatedRow).toContainText('ADMIN');

    await updatedRow.getByRole('button', { name: 'Xóa' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const deleteResponsePromise = page.waitForResponse((response) =>
      response.request().method() === 'DELETE' && new URL(response.url()).pathname === `/api/admin/users/${createdUserId}`);
    await page.getByRole('dialog').getByRole('button', { name: 'Xác nhận' }).click();
    const deleteResponse = await deleteResponsePromise;
    expect(deleteResponse.status()).toBe(200);
    await expect(page.getByRole('row').filter({ hasText: updatedUsername })).toHaveCount(0);

    const state = await withTestRedis(async (client) => ({
      userType: await client.type(`user:${createdUserId}`),
      usernameMapping: await client.get(`username:${updatedUsername}`),
    }));
    expect(state).toEqual({ userType: 'none', usernameMapping: null });
    createdUserId = null;
  } finally {
    if (createdUserId) {
      await withTestRedis(async (client) => {
        const sessionIds = new Set([
          ...(await client.sMembers(`user:sessions:${createdUserId}`)),
          ...(await client.zRange(`user:sessions:order:${createdUserId}`, 0, -1)),
        ]);
        await client.del([
          ...Array.from(sessionIds, (id) => `session:${id}`),
          `user:${createdUserId}`, `username:${username}`, `username:${updatedUsername}`,
          `user:sessions:${createdUserId}`, `user:sessions:order:${createdUserId}`,
          `audit:auth:user:${createdUserId}`,
        ]);
      });
    }
  }
});
