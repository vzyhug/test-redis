const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const { once } = require('node:events');

const testRedisUrl = process.env.REDIS_TEST_URL;
if (testRedisUrl) process.env.REDIS_URL = testRedisUrl;
const { client, connectRedis } = require('../src/redisClient');
const sessions = require('../src/sessionService');
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

const newUser = () => {
  const id = `revoke-${randomUUID()}`;
  return { userId: id, username: id, role: 'USER' };
};
async function seed(user) {
  await client.hSet(`user:${user.userId}`, {
    username: user.username, passwordHash: await bcrypt.hash('test-password', 4), role: user.role,
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
async function api(path, cookie, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(options.headers || {}) },
  });
}
async function clean(user, authIds = []) {
  const ids = new Set(authIds);
  const refs = [
    ...(await client.sMembers(`user:sessions:${user.userId}`).catch(() => [])),
    ...(await client.zRange(`user:sessions:order:${user.userId}`, 0, -1).catch(() => [])),
  ];
  refs.forEach((id) => ids.add(id));
  await client.del([
    ...Array.from(ids, (id) => `session:${id}`),
    `user:sessions:${user.userId}`, `user:sessions:order:${user.userId}`,
    `audit:auth:user:${user.userId}`,
    `login:count:${user.userId}`, `user:${user.userId}`, `username:${user.username}`,
    `auth:fail:events:${user.username}`, `auth:lock:${user.username}`,
  ]);
}

test('TC-01/02/03: session APIs expose managementId only and revoke an owned other session', {
  skip: !testRedisUrl,
}, async () => {
  const user = newUser(); const authIds = [];
  try {
    await seed(user);
    const first = await login(user); assert.equal(first.response.status, 200);
    const firstId = first.cookie.split('=', 2)[1]; authIds.push(firstId);
    const second = await login(user); assert.equal(second.response.status, 200);
    const secondId = second.cookie.split('=', 2)[1]; authIds.push(secondId);
    const meResponse = await api('/api/me', first.cookie);
    const me = await meResponse.json();
    assert.equal(meResponse.status, 200);
    assert.ok(me.managementId); assert.equal('sessionId' in me, false);
    assert.equal((await api('/api/me', `sessionId=${me.managementId}`)).status, 401);
    const listResponse = await api('/api/sessions', first.cookie);
    const list = await listResponse.json();
    assert.equal(list.some((item) => 'sessionId' in item), false);
    assert.ok(list.every((item) => item.managementId));
    const target = list.find((item) => !item.current);
    assert.ok(target);
    assert.notEqual(target.managementId, secondId);
    const before = await client.ttl(`session:${firstId}`);
    const result = await api(`/api/sessions/${target.managementId}`, first.cookie, {
      method: 'DELETE', headers: { Origin: baseUrl },
    });
    assert.equal(result.status, 200);
    assert.equal(await client.exists(`session:${secondId}`), 0);
    assert.equal(await client.sIsMember(`user:sessions:${user.userId}`, secondId), false);
    assert.equal(await client.zScore(`user:sessions:order:${user.userId}`, secondId), null);
    assert.ok(await client.ttl(`session:${firstId}`) >= before - 2);
    assert.equal((await api('/api/me', second.cookie)).status, 401);
    assert.equal((await api('/api/sessions/not-a-uuid', first.cookie, { method: 'DELETE', headers: { Origin: baseUrl } })).status, 404);
  } finally { await clean(user, authIds); }
});

test('TC-04/05: cannot revoke current, unknown, or another user session', {
  skip: !testRedisUrl,
}, async () => {
  const user = newUser(); const other = newUser(); const ids = [];
  try {
    await seed(user); await seed(other);
    const a = await login(user); const b = await login(other);
    ids.push(a.cookie.split('=', 2)[1], b.cookie.split('=', 2)[1]);
    const current = await (await api('/api/me', a.cookie)).json();
    assert.equal((await api(`/api/sessions/${current.managementId}`, a.cookie, { method: 'DELETE', headers: { Origin: baseUrl } })).status, 400);
    const otherList = await (await api('/api/sessions', b.cookie)).json();
    assert.equal((await api(`/api/sessions/${otherList[0].managementId}`, a.cookie, { method: 'DELETE', headers: { Origin: baseUrl } })).status, 404);
    assert.equal(await client.exists(`session:${ids[1]}`), 1);
    assert.equal((await api(`/api/sessions/${randomUUID()}`, a.cookie, { method: 'DELETE', headers: { Origin: baseUrl } })).status, 404);
  } finally { await clean(user, [ids[0]]); await clean(other, [ids[1]]); }
});

test('TC-06/07/08/09: logout all removes only this account sessions, clears cookie, preserves non-session keys', {
  skip: !testRedisUrl,
}, async () => {
  const user = newUser(); const other = newUser(); const ids = [];
  try {
    await seed(user); await seed(other);
    const a = await login(user); const b = await login(user); const c = await login(other);
    ids.push(a.cookie.split('=', 2)[1], b.cookie.split('=', 2)[1]);
    const otherId = c.cookie.split('=', 2)[1];
    await client.set(`login:count:${user.userId}`, '42');
    await client.set(`auth:lock:${user.username}`, '1', { EX: 60 });
    await client.zAdd(`auth:fail:events:${user.username}`, [{ score: Date.now(), value: 'preserve' }]);
    const result = await api('/api/logout-all', a.cookie, { method: 'POST', headers: { Origin: baseUrl } });
    assert.equal(result.status, 200);
    assert.match(result.headers.get('set-cookie'), /sessionId=;/);
    for (const id of ids) assert.equal(await client.exists(`session:${id}`), 0);
    assert.equal((await api('/api/me', b.cookie)).status, 401);
    assert.equal(await client.exists(`session:${otherId}`), 1);
    assert.equal(await client.get(`login:count:${user.userId}`), '42');
    assert.equal(await client.get(`auth:lock:${user.username}`), '1');
    assert.equal(await client.zCard(`auth:fail:events:${user.username}`), 1);
  } finally { await clean(user, ids); await clean(other); }
});

test('TC-10: state-changing endpoints reject missing or cross-origin Origin', {
  skip: !testRedisUrl,
}, async () => {
  const user = newUser(); const ids = [];
  try {
    await seed(user); const signedIn = await login(user); ids.push(signedIn.cookie.split('=', 2)[1]);
    assert.equal((await api('/api/logout-all', signedIn.cookie, { method: 'POST' })).status, 403);
    assert.equal((await api('/api/logout-all', signedIn.cookie, { method: 'POST', headers: { Origin: 'https://attacker.invalid' } })).status, 403);
    assert.equal(await client.exists(`session:${ids[0]}`), 1);
    assert.equal((await api('/api/logout', signedIn.cookie, { method: 'POST', headers: { Origin: 'https://attacker.invalid' } })).status, 403);
  } finally { await clean(user, ids); }
});

test('TC-11/12: legacy sessions receive a managementId on read without changing their TTL', {
  skip: !testRedisUrl,
}, async () => {
  const user = newUser(); const id = randomUUID();
  try {
    await client.hSet(`session:${id}`, { userId: user.userId, username: user.username, role: user.role, device: 'legacy', ip: '127.0.0.1', loginTime: new Date().toISOString() });
    await client.expire(`session:${id}`, 900);
    await client.sAdd(`user:sessions:${user.userId}`, id);
    await client.zAdd(`user:sessions:order:${user.userId}`, [{ score: Date.now(), value: id }]);
    const before = await client.ttl(`session:${id}`);
    const legacy = await sessions.getSession(id);
    assert.ok(legacy.managementId);
    assert.equal(await client.hGet(`session:${id}`, 'managementId'), legacy.managementId);
    assert.ok(await client.ttl(`session:${id}`) <= before);
  } finally { await clean(user, [id]); }
});

test('TC-13: a login committed after logout-all remains active', {
  skip: !testRedisUrl,
}, async () => {
  const user = newUser(); const ids = [];
  try {
    await seed(user); const first = await login(user); ids.push(first.cookie.split('=', 2)[1]);
    await sessions.revokeAllSessions(user.userId);
    const later = await login(user); assert.equal(later.response.status, 200); ids.push(later.cookie.split('=', 2)[1]);
    assert.equal(await client.exists(`session:${ids[0]}`), 0);
    assert.equal(await client.exists(`session:${ids[1]}`), 1);
    assert.deepEqual(await client.sMembers(`user:sessions:${user.userId}`), [ids[1]]);
  } finally { await clean(user, ids); }
});
