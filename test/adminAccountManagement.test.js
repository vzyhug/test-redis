const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const { once } = require('node:events');

const testRedisUrl = process.env.REDIS_TEST_URL;
if (testRedisUrl) process.env.REDIS_URL = testRedisUrl;
process.env.FIRESTORE_SYNC_ENABLED = 'false';

const { client, connectRedis } = require('../src/redisClient');
const { app } = require('../server');
const bcrypt = require('bcrypt');
const adminService = require('../src/adminService');

let server;
let baseUrl;
let admin;
let adminCookie;
let createdUserId;
let currentUsername;
let updatedUsername;

before(async () => {
  if (!testRedisUrl) return;
  await connectRedis();
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  admin = { userId: `qa-admin-${randomUUID()}`, username: `qa_admin_${randomUUID().slice(0, 8)}` };
  await client.hSet(`user:${admin.userId}`, {
    username: admin.username,
    email: `${admin.username}@example.invalid`,
    role: 'ADMIN',
    passwordHash: await bcrypt.hash('test-admin-password', 4),
  });
  await client.set(`username:${admin.username}`, admin.userId);
  const login = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ username: admin.username, password: 'test-admin-password' }),
  });
  assert.equal(login.status, 200);
  adminCookie = login.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(adminCookie);
});

after(async () => {
  if (createdUserId) {
    await adminService.deleteUser(createdUserId).catch(() => {});
    await client.del(`audit:auth:user:${createdUserId}`);
  }
  if (admin) {
    const sessionIds = new Set([
      ...(await client.sMembers(`user:sessions:${admin.userId}`).catch(() => [])),
      ...(await client.zRange(`user:sessions:order:${admin.userId}`, 0, -1).catch(() => [])),
    ]);
    await client.del([
      ...Array.from(sessionIds, (id) => `session:${id}`),
      `user:sessions:${admin.userId}`, `user:sessions:order:${admin.userId}`,
      `audit:auth:user:${admin.userId}`, `login:count:${admin.userId}`,
      `user:${admin.userId}`, `username:${admin.username}`,
      `auth:fail:events:${admin.username}`, `auth:lock:${admin.username}`,
    ]);
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  if (client.isOpen) await client.quit();
});

test('Admin can create, update, and delete an account in Redis', { skip: !testRedisUrl }, async () => {
  const cookie = adminCookie;
  const headers = { Cookie: cookie, Origin: baseUrl, 'Content-Type': 'application/json' };
  const suffix = randomUUID().slice(0, 8);
  currentUsername = `qa_${suffix}`;
  updatedUsername = `qa_edit_${suffix}`;
  const initialPassword = 'test-account-password';
  const nextPassword = 'test-updated-password';

  const created = await fetch(`${baseUrl}/api/admin/users`, {
    method: 'POST', headers,
    body: JSON.stringify({ username: currentUsername, email: `${currentUsername}@example.invalid`, role: 'USER', password: initialPassword }),
  });
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  createdUserId = createdBody.user.userId;
  assert.equal(createdBody.user.username, currentUsername);
  assert.equal('passwordHash' in createdBody.user, false);
  assert.equal(await client.get(`username:${currentUsername}`), createdUserId);
  let stored = await client.hGetAll(`user:${createdUserId}`);
  assert.equal(stored.role, 'USER');
  assert.equal(stored.email, `${currentUsername}@example.invalid`);
  assert.equal(await bcrypt.compare(initialPassword, stored.passwordHash), true);

  const duplicate = await fetch(`${baseUrl}/api/admin/users`, {
    method: 'POST', headers,
    body: JSON.stringify({ username: currentUsername, email: '', role: 'USER', password: initialPassword }),
  });
  assert.equal(duplicate.status, 409);

  const updated = await fetch(`${baseUrl}/api/admin/users/${encodeURIComponent(createdUserId)}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({ username: updatedUsername, email: `${updatedUsername}@example.invalid`, role: 'ADMIN', password: nextPassword }),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).user.username, updatedUsername);
  assert.equal(await client.get(`username:${currentUsername}`), null);
  assert.equal(await client.get(`username:${updatedUsername}`), createdUserId);
  stored = await client.hGetAll(`user:${createdUserId}`);
  assert.equal(stored.role, 'ADMIN');
  assert.equal(stored.email, `${updatedUsername}@example.invalid`);
  assert.equal(await bcrypt.compare(nextPassword, stored.passwordHash), true);

  const deleted = await fetch(`${baseUrl}/api/admin/users/${encodeURIComponent(createdUserId)}`, {
    method: 'DELETE', headers,
  });
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).userId, createdUserId);
  assert.equal(await client.type(`user:${createdUserId}`), 'none');
  assert.equal(await client.get(`username:${updatedUsername}`), null);
  createdUserId = null;
});
