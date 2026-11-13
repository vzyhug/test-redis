const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const { once } = require('node:events');

const testRedisUrl = process.env.REDIS_TEST_URL;
if (testRedisUrl) process.env.REDIS_URL = testRedisUrl;
const { client, connectRedis } = require('../src/redisClient');
const sessionService = require('../src/sessionService');
const adminService = require('../src/adminService');
const bcrypt = require('bcrypt');
const { app } = require('../server');

let server;
let baseUrl;
before(async () => {
  if (!testRedisUrl) return;
  await connectRedis();
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (client.isOpen) await client.quit();
});

function account(role = 'USER') {
  const id = `br04-${randomUUID()}`;
  return { userId: id, username: id, email: `${id}@example.invalid`, role };
}
async function seedUser(user) {
  await client.hSet(`user:${user.userId}`, {
    username: user.username, email: user.email, role: user.role,
    passwordHash: await bcrypt.hash('test-password', 4),
  });
  await client.set(`username:${user.username}`, user.userId);
}
async function login(user) {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ username: user.username, password: 'test-password' }),
  });
  return { response, cookie: response.headers.get('set-cookie')?.split(';', 1)[0] };
}
function request(path, cookie, options = {}) {
  const headers = { ...(cookie ? { Cookie: cookie } : {}), ...(options.headers || {}) };
  return fetch(`${baseUrl}${path}`, { ...options, headers });
}
async function fixture(callback) {
  const admin = account('ADMIN');
  const otherAdmin = account('ADMIN');
  const user = account('USER');
  const cookies = [];
  const ids = new Map([[admin.userId, []], [otherAdmin.userId, []], [user.userId, []]]);
  try {
    await Promise.all([seedUser(admin), seedUser(otherAdmin), seedUser(user)]);
    const signIn = async (who) => {
      const result = await login(who);
      assert.equal(result.response.status, 200);
      cookies.push(result.cookie);
      ids.get(who.userId).push(result.cookie.split('=', 2)[1]);
      return result.cookie;
    };
    await callback({ admin, otherAdmin, user, signIn, ids });
  } finally {
    for (const who of [admin, otherAdmin, user]) {
      const indexed = [
        ...(await client.sMembers(`user:sessions:${who.userId}`).catch(() => [])),
        ...(await client.zRange(`user:sessions:order:${who.userId}`, 0, -1).catch(() => [])),
      ];
      const allIds = new Set([...ids.get(who.userId), ...indexed]);
      await client.del([
        ...Array.from(allIds, (id) => `session:${id}`),
        `user:sessions:${who.userId}`, `user:sessions:order:${who.userId}`,
        `audit:auth:user:${who.userId}`,
        `login:count:${who.userId}`, `user:${who.userId}`, `username:${who.username}`,
        `auth:fail:events:${who.username}`, `auth:lock:${who.username}`,
      ]);
    }
  }
}
const testOptions = { skip: !testRedisUrl };

test('TC-01: USER cannot read the system account list (403)', testOptions, async () => fixture(async ({ user, signIn }) => {
  const cookie = await signIn(user);
  assert.equal((await request('/api/admin/users', cookie)).status, 403);
  assert.equal((await request('/admin.html', cookie)).status, 403);
}));

test('TC-02: unauthenticated access to Admin APIs returns 401', testOptions, async () => fixture(async () => {
  assert.equal((await request('/api/admin/users')).status, 401);
  assert.equal((await request('/api/admin/overview')).status, 401);
}));

test('TC-03: ADMIN lists real USER and ADMIN records without hashes or session tokens', testOptions, async () => fixture(async ({ admin, otherAdmin, user, signIn }) => {
  const cookie = await signIn(admin);
  await signIn(user);
  const response = await request(`/api/admin/users?q=${encodeURIComponent(user.username)}&limit=10`, cookie);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.total, 1);
  assert.deepEqual(data.users[0], {
    userId: user.userId, username: user.username, email: user.email, role: 'USER', activeSessionCount: 1,
  });
  const admins = await request(`/api/admin/users?q=${encodeURIComponent(otherAdmin.username)}`, cookie);
  assert.equal((await admins.json()).users[0].role, 'ADMIN');
  assert.equal(JSON.stringify(data).includes('passwordHash'), false);
  assert.equal(JSON.stringify(data).includes('sessionId'), false);
  await client.hSet(`user:${admin.userId}`, { role: 'USER' });
  assert.equal((await request('/api/admin/users', cookie)).status, 403);
  await client.hSet(`user:${admin.userId}`, { role: 'ADMIN' });
}));

test('TC-04: ADMIN reads USER sessions without refreshing their TTL or returning auth IDs', testOptions, async () => fixture(async ({ admin, user, signIn, ids }) => {
  const cookie = await signIn(admin); const userCookie = await signIn(user);
  const sid = ids.get(user.userId)[0];
  const before = await client.ttl(`session:${sid}`);
  const response = await request(`/api/admin/users/${user.userId}/sessions`, cookie);
  assert.equal(response.status, 200);
  const data = await response.json();
  const after = await client.ttl(`session:${sid}`);
  assert.equal(data.sessions.length, 1);
  assert.ok(data.sessions[0].managementId);
  assert.equal(data.sessions[0].current, false);
  assert.equal(JSON.stringify(data).includes(sid), false);
  assert.ok(after <= before && after >= before - 2);
  assert.equal((await request('/api/me', userCookie)).status, 200);
}));

test('TC-05: ADMIN can inspect sessions belonging to another ADMIN', testOptions, async () => fixture(async ({ admin, otherAdmin, signIn }) => {
  const cookie = await signIn(admin); await signIn(otherAdmin);
  const response = await request(`/api/admin/users/${otherAdmin.userId}/sessions`, cookie);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.user.role, 'ADMIN');
  assert.equal(body.sessions.length, 1);
}));

test('TC-06: ADMIN revokes one USER session and preserves the other sessions', testOptions, async () => fixture(async ({ admin, user, signIn, ids }) => {
  const cookie = await signIn(admin); const targetCookie = await signIn(user); const survivorCookie = await signIn(user);
  const targetId = ids.get(user.userId)[0];
  const list = await (await request(`/api/admin/users/${user.userId}/sessions`, cookie)).json();
  const targetManagementId = (await sessionService.getSession(targetId)).managementId;
  const target = list.sessions.find((session) => session.managementId === targetManagementId);
  const response = await request(`/api/admin/users/${user.userId}/sessions/${target.managementId}`, cookie, {
    method: 'DELETE', headers: { Origin: baseUrl },
  });
  assert.equal(response.status, 200);
  assert.equal(await client.exists(`session:${targetId}`), 0);
  assert.equal((await request('/api/me', targetCookie)).status, 401);
  assert.equal((await request('/api/me', survivorCookie)).status, 200);
  assert.equal(await client.sIsMember(`user:sessions:${user.userId}`, targetId), false);
  assert.equal(await client.zScore(`user:sessions:order:${user.userId}`, targetId), null);
}));

test('TC-07: ADMIN may revoke another ADMIN session without revoking itself', testOptions, async () => fixture(async ({ admin, otherAdmin, signIn, ids }) => {
  const actorCookie = await signIn(admin); const targetCookie = await signIn(otherAdmin);
  const targetId = ids.get(otherAdmin.userId)[0];
  const list = await (await request(`/api/admin/users/${otherAdmin.userId}/sessions`, actorCookie)).json();
  const response = await request(`/api/admin/users/${otherAdmin.userId}/sessions/${list.sessions[0].managementId}`, actorCookie, {
    method: 'DELETE', headers: { Origin: baseUrl },
  });
  assert.equal(response.status, 200);
  assert.equal(await client.exists(`session:${targetId}`), 0);
  assert.equal((await request('/api/me', actorCookie)).status, 200);
  assert.equal((await request('/api/me', targetCookie)).status, 401);
}));

test('TC-08: USER cannot revoke a session through Admin API', testOptions, async () => fixture(async ({ user, signIn, ids }) => {
  const cookie = await signIn(user);
  const sid = ids.get(user.userId)[0];
  const managementId = (await sessionService.getSession(sid)).managementId;
  const response = await request(`/api/admin/users/${user.userId}/sessions/${managementId}`, cookie, {
    method: 'DELETE', headers: { Origin: baseUrl },
  });
  assert.equal(response.status, 403);
  assert.equal(await client.exists(`session:${sid}`), 1);
}));

test('TC-09: ADMIN receives 404 for a nonexistent target session', testOptions, async () => fixture(async ({ admin, user, signIn }) => {
  const cookie = await signIn(admin);
  const response = await request(`/api/admin/users/${user.userId}/sessions/${randomUUID()}`, cookie, {
    method: 'DELETE', headers: { Origin: baseUrl },
  });
  assert.equal(response.status, 404);
}));

test('TC-10: managementId cannot be used with a different target userId', testOptions, async () => fixture(async ({ admin, user, otherAdmin, signIn, ids }) => {
  const cookie = await signIn(admin); await signIn(user);
  const targetId = ids.get(user.userId)[0];
  const list = await (await request(`/api/admin/users/${user.userId}/sessions`, cookie)).json();
  const response = await request(`/api/admin/users/${otherAdmin.userId}/sessions/${list.sessions[0].managementId}`, cookie, {
    method: 'DELETE', headers: { Origin: baseUrl },
  });
  assert.equal(response.status, 404);
  assert.equal(await client.exists(`session:${targetId}`), 1);
}));

test('TC-11: Admin logout-all for USER preserves Admin sessions and account data', testOptions, async () => fixture(async ({ admin, user, signIn, ids }) => {
  const actorCookie = await signIn(admin); await signIn(user); await signIn(user);
  await client.set(`login:count:${user.userId}`, '17');
  const response = await request(`/api/admin/users/${user.userId}/logout-all`, actorCookie, {
    method: 'POST', headers: { Origin: baseUrl },
  });
  assert.equal(response.status, 200);
  for (const id of ids.get(user.userId)) assert.equal(await client.exists(`session:${id}`), 0);
  assert.equal(await client.type(`user:${user.userId}`), 'hash');
  assert.equal(await client.get(`login:count:${user.userId}`), '17');
  assert.equal((await request('/api/me', actorCookie)).status, 200);
  assert.equal(await client.exists(`user:sessions:${user.userId}`), 0);
  assert.equal(await client.exists(`user:sessions:order:${user.userId}`), 0);
}));

test('TC-12: Admin can logout all sessions of another ADMIN', testOptions, async () => fixture(async ({ admin, otherAdmin, signIn, ids }) => {
  const actorCookie = await signIn(admin); await signIn(otherAdmin); await signIn(otherAdmin);
  const response = await request(`/api/admin/users/${otherAdmin.userId}/logout-all`, actorCookie, {
    method: 'POST', headers: { Origin: baseUrl },
  });
  assert.equal(response.status, 200);
  for (const id of ids.get(otherAdmin.userId)) assert.equal(await client.exists(`session:${id}`), 0);
  assert.equal((await request('/api/me', actorCookie)).status, 200);
}));

test('TC-13: Admin may revoke its current session, clear cookie, and lose access', testOptions, async () => fixture(async ({ admin, signIn, ids }) => {
  const cookie = await signIn(admin); const sid = ids.get(admin.userId)[0];
  const sessionList = await (await request(`/api/admin/users/${admin.userId}/sessions`, cookie)).json();
  assert.equal(sessionList.sessions[0].current, true);
  const me = await (await request('/api/me', cookie)).json();
  const response = await request(`/api/admin/users/${admin.userId}/sessions/${me.managementId}`, cookie, {
    method: 'DELETE', headers: { Origin: baseUrl },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).currentSessionRevoked, true);
  assert.match(response.headers.get('set-cookie'), /sessionId=;/);
  assert.equal(await client.exists(`session:${sid}`), 0);
  assert.equal((await request('/api/admin/overview', cookie)).status, 401);
}));

test('TC-14: Admin logout-all of itself clears its session and leaves USER sessions intact', testOptions, async () => fixture(async ({ admin, user, signIn, ids }) => {
  const cookie = await signIn(admin); const sid = ids.get(admin.userId)[0];
  const userCookie = await signIn(user); const userSid = ids.get(user.userId)[0];
  const response = await request(`/api/admin/users/${admin.userId}/logout-all`, cookie, {
    method: 'POST', headers: { Origin: baseUrl },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).currentSessionRevoked, true);
  assert.match(response.headers.get('set-cookie'), /sessionId=;/);
  assert.equal(await client.exists(`session:${sid}`), 0);
  assert.equal((await request('/api/admin/overview', cookie)).status, 401);
  assert.equal(await client.exists(`session:${userSid}`), 1);
  assert.equal((await request('/api/me', userCookie)).status, 200);
}));

test('TC-15: overview counts users, active accounts, sessions, and role groups', testOptions, async () => fixture(async ({ admin, user, otherAdmin, signIn }) => {
  const cookie = await signIn(admin); await signIn(user); await signIn(user); await signIn(otherAdmin);
  const response = await request('/api/admin/overview', cookie);
  assert.equal(response.status, 200);
  const stats = await response.json();
  assert.ok(stats.totalUsers >= 3);
  assert.ok(stats.activeAccounts >= 3);
  assert.ok(stats.totalActiveSessions >= 4);
  assert.equal(stats.activeSessionsByRole.USER + stats.activeSessionsByRole.ADMIN, stats.totalActiveSessions);
}));

test('TC-16: expired session references are cleaned and never returned as active', testOptions, async () => fixture(async ({ admin, user, signIn, ids }) => {
  const cookie = await signIn(admin);
  const expiredId = await sessionService.createSession(user, 'expired-device', '127.0.0.1');
  ids.get(user.userId).push(expiredId);
  await client.expire(`session:${expiredId}`, 1);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const response = await request(`/api/admin/users/${user.userId}/sessions`, cookie);
  assert.equal((await response.json()).sessions.length, 0);
  assert.equal(await client.sIsMember(`user:sessions:${user.userId}`, expiredId), false);
  assert.equal(await client.zScore(`user:sessions:order:${user.userId}`, expiredId), null);
}));

test('TC-17: concurrent login and single-session revoke leave indexes consistent', testOptions, async () => fixture(async ({ admin, user, signIn, ids }) => {
  const adminCookie = await signIn(admin); const old = await signIn(user);
  const oldSession = await sessionService.getSession(old.split('=', 2)[1]);
  const [loginResult, revokeResult] = await Promise.all([
    login(user),
    request(`/api/admin/users/${user.userId}/sessions/${oldSession.managementId}`, adminCookie, {
      method: 'DELETE', headers: { Origin: baseUrl },
    }),
  ]);
  assert.equal(loginResult.response.status, 200);
  assert.ok([200, 404].includes(revokeResult.status));
  const setIds = await client.sMembers(`user:sessions:${user.userId}`);
  const orderIds = await client.zRange(`user:sessions:order:${user.userId}`, 0, -1);
  assert.ok(setIds.length <= sessionService.MAX_SESSIONS);
  assert.deepEqual(new Set(setIds), new Set(orderIds));
  for (const id of setIds) assert.equal((await client.hGet(`session:${id}`, 'userId')), user.userId);
}));

test('TC-18: logout-all concurrent with login serializes without orphaned indexes', testOptions, async () => fixture(async ({ admin, user, signIn }) => {
  const adminCookie = await signIn(admin); await signIn(user);
  const [logout, loginResult] = await Promise.all([
    request(`/api/admin/users/${user.userId}/logout-all`, adminCookie, { method: 'POST', headers: { Origin: baseUrl } }),
    login(user),
  ]);
  assert.equal(logout.status, 200);
  assert.equal(loginResult.response.status, 200);
  const setIds = await client.sMembers(`user:sessions:${user.userId}`);
  const orderIds = await client.zRange(`user:sessions:order:${user.userId}`, 0, -1);
  assert.deepEqual(new Set(setIds), new Set(orderIds));
  assert.ok(setIds.length <= 1);
  for (const id of setIds) assert.equal(await client.type(`session:${id}`), 'hash');
}));

test('TC-19: invalid or missing Origin blocks Admin mutations before Redis session refresh', testOptions, async () => fixture(async ({ admin, user, signIn, ids }) => {
  const cookie = await signIn(admin); await signIn(user);
  const adminId = ids.get(admin.userId)[0];
  const ttlBefore = await client.ttl(`session:${adminId}`);
  assert.equal((await request(`/api/admin/users/${user.userId}/logout-all`, cookie, { method: 'POST' })).status, 403);
  assert.equal((await request(`/api/admin/users/${user.userId}/logout-all`, cookie, {
    method: 'POST', headers: { Origin: 'https://attacker.invalid' },
  })).status, 403);
  const ttlAfter = await client.ttl(`session:${adminId}`);
  assert.ok(ttlAfter <= ttlBefore && ttlAfter >= ttlBefore - 1);
  assert.equal(await client.sCard(`user:sessions:${user.userId}`), 1);
}));

test('TC-20: Admin revocation preserves login count, failure events, and lock TTL', testOptions, async () => fixture(async ({ admin, user, signIn }) => {
  const cookie = await signIn(admin); await signIn(user);
  await client.set(`login:count:${user.userId}`, '9');
  await client.zAdd(`auth:fail:events:${user.username}`, [{ score: Date.now(), value: 'failure' }]);
  await client.set(`auth:lock:${user.username}`, '1', { EX: 60 });
  const lockBefore = await client.ttl(`auth:lock:${user.username}`);
  const response = await request(`/api/admin/users/${user.userId}/logout-all`, cookie, {
    method: 'POST', headers: { Origin: baseUrl },
  });
  assert.equal(response.status, 200);
  assert.equal(await client.get(`login:count:${user.userId}`), '9');
  assert.equal(await client.zCard(`auth:fail:events:${user.username}`), 1);
  assert.ok((await client.ttl(`auth:lock:${user.username}`)) <= lockBefore);
  assert.equal(await client.get(`auth:lock:${user.username}`), '1');
}));
