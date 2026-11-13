const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { once } = require('node:events');

const testRedisUrl = process.env.REDIS_TEST_URL;
if (testRedisUrl) {
  process.env.REDIS_URL = testRedisUrl;
  process.env.AUDIT_RETENTION_SECONDS = '4';
  process.env.AUTH_FAILURE_WINDOW_SECONDS = '20';
  process.env.AUTH_LOCK_SECONDS = '20';
}
const { client, connectRedis } = require('../src/redisClient');
const audit = require('../src/auditService');
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
  audit.stopCleanup();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (client.isOpen) await client.quit();
});

function makeUser(role = 'USER') {
  const userId = `audit-${crypto.randomUUID()}`;
  return { userId, username: userId, email: `${userId}@example.invalid`, role };
}
async function seed(user) {
  await client.hSet(`user:${user.userId}`, {
    username: user.username, email: user.email, role: user.role,
    passwordHash: await bcrypt.hash('audit-password', 4),
  });
  await client.set(`username:${user.username}`, user.userId);
}
async function call(pathname, cookie, options = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(options.headers || {}) },
  });
}
async function signIn(user, password = 'audit-password', extra = {}) {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl, ...(extra.headers || {}) },
    body: JSON.stringify({ username: extra.username || user.username, password }),
  });
  return {
    response,
    body: await response.json(),
    cookie: response.headers.get('set-cookie')?.split(';', 1)[0] || null,
    sessionId: response.headers.get('set-cookie')?.match(/sessionId=([^;]+)/)?.[1] || null,
  };
}
async function cleanup(user, extraIds = [], unknownNames = []) {
  const refs = [
    ...(await client.sMembers(`user:sessions:${user.userId}`).catch(() => [])),
    ...(await client.zRange(`user:sessions:order:${user.userId}`, 0, -1).catch(() => [])),
  ];
  await client.del([
    ...new Set([...extraIds, ...refs].map((id) => `session:${id}`)),
    `user:sessions:${user.userId}`, `user:sessions:order:${user.userId}`,
    `login:count:${user.userId}`, `user:${user.userId}`, `username:${user.username}`,
    `auth:fail:events:${user.username}`, `auth:lock:${user.username}`,
    audit.userStreamKey(user.userId),
    ...unknownNames.flatMap((name) => [`auth:fail:events:${name}`, `auth:lock:${name}`]),
  ]);
}
async function fixture(callback, roles = ['USER', 'ADMIN']) {
  const users = roles.map((role) => makeUser(role));
  const ids = new Map(users.map((user) => [user.userId, []]));
  const unknownNames = [];
  try {
    await Promise.all(users.map(seed));
    const login = async (user, password = 'audit-password') => {
      const result = await signIn(user, password);
      if (result.sessionId) ids.get(user.userId)?.push(result.sessionId);
      return result;
    };
    await callback({ users, login, ids, unknownNames });
  } finally {
    await Promise.all(users.map((user) => cleanup(user, ids.get(user.userId), unknownNames)));
  }
}
async function streamEntries(userId) {
  const key = audit.userStreamKey(userId);
  if (await client.type(key) !== 'stream') return [];
  return client.xRange(key, '-', '+');
}
async function userHistory(cookie, query = '') {
  return call(`/api/history${query ? `?${query}` : ''}`, cookie);
}
async function adminHistory(cookie, query = '') {
  return call(`/api/admin/history${query ? `?${query}` : ''}`, cookie);
}
const testOptions = { skip: !testRedisUrl };

test('TC-01: successful login records one safe LOGIN_SUCCESS entry', testOptions, async () => fixture(async ({ users, login }) => {
  const user = users[0];
  const result = await login(user);
  assert.equal(result.response.status, 200);
  const entries = await streamEntries(user.userId);
  const successes = entries.filter((entry) => entry.message.eventType === 'LOGIN_SUCCESS');
  assert.equal(successes.length, 1);
  assert.equal(successes[0].message.targetUserId, user.userId);
  assert.ok(Number(successes[0].message.occurredAtMs) > 0);
  assert.equal(JSON.stringify(successes).includes(result.sessionId), false);
  assert.equal(JSON.stringify(successes).includes('audit-password'), false);
}));

test('TC-02: invalid credentials record LOGIN_FAILED without a session or success event', testOptions, async () => fixture(async ({ users, login }) => {
  const user = users[0];
  const result = await login(user, 'bad-password');
  assert.equal(result.response.status, 401);
  assert.equal(await client.sCard(`user:sessions:${user.userId}`), 0);
  const entries = await streamEntries(user.userId);
  assert.equal(entries.filter((entry) => entry.message.eventType === 'LOGIN_FAILED').length, 1);
  assert.equal(entries.some((entry) => entry.message.eventType === 'LOGIN_SUCCESS'), false);
}));

test('TC-03: fifth failure logs one lock event; locked retries do not duplicate it', testOptions, async () => fixture(async ({ users, login }) => {
  const user = users[0];
  let last;
  for (let index = 0; index < 5; index += 1) last = await login(user, 'bad-password');
  assert.equal(last.response.status, 429);
  const before = await streamEntries(user.userId);
  assert.equal(before.filter((entry) => entry.message.eventType === 'LOGIN_FAILED').length, 5);
  assert.equal(before.filter((entry) => entry.message.eventType === 'LOGIN_LOCKED').length, 1);
  await login(user, 'bad-password');
  const after = await streamEntries(user.userId);
  assert.equal(after.filter((entry) => entry.message.eventType === 'LOGIN_LOCKED').length, 1);
}));

test('TC-04: unknown usernames are audited globally without fake user keys or account disclosure', testOptions, async () => fixture(async ({ users, login, unknownNames }) => {
  const fake = `not-found-${crypto.randomUUID()}`;
  unknownNames.push(fake);
  const unknown = await signIn(users[0], 'bad-password', { username: fake });
  const known = await login(users[0], 'bad-password');
  assert.equal(unknown.response.status, known.response.status);
  assert.equal(unknown.body.message, known.body.message);
  assert.equal(await client.exists(`user:${fake}`), 0);
  assert.equal(await client.exists(audit.userStreamKey(fake)), 0);
  const result = await adminHistory((await login(users[1])).cookie,
    `eventType=LOGIN_FAILED&from=${Date.now() - 3000}&limit=100`);
  const entries = await result.json();
  assert.ok(entries.items.some((entry) => entry.username === fake && entry.targetUserId === null));
}));

test('TC-05: current-session logout records LOGOUT and invalidates the cookie', testOptions, async () => fixture(async ({ users, login }) => {
  const user = users[0]; const signedIn = await login(user);
  const response = await call('/api/logout', signedIn.cookie, { method: 'POST', headers: { Origin: baseUrl } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).auditRecorded, true);
  assert.equal((await call('/api/me', signedIn.cookie)).status, 401);
  assert.equal((await streamEntries(user.userId)).filter((entry) => entry.message.eventType === 'LOGOUT').length, 1);
}));

test('TC-06: user revocation records SESSION_REVOKED only after deleting its target', testOptions, async () => fixture(async ({ users, login, ids }) => {
  const user = users[0]; const current = await login(user); const other = await login(user);
  const sessions = await (await call('/api/sessions', current.cookie)).json();
  const target = sessions.find((entry) => !entry.current);
  const response = await call(`/api/sessions/${target.managementId}`, current.cookie, {
    method: 'DELETE', headers: { Origin: baseUrl },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).auditRecorded, true);
  assert.equal((await call('/api/me', other.cookie)).status, 401);
  assert.equal((await call('/api/me', current.cookie)).status, 200);
  assert.equal((await streamEntries(user.userId)).filter((entry) => entry.message.eventType === 'SESSION_REVOKED').length, 1);
}));

test('TC-07: user logout-all records one aggregate event with its actual revoked count', testOptions, async () => fixture(async ({ users, login }) => {
  const user = users[0]; const first = await login(user); await login(user);
  const response = await call('/api/logout-all', first.cookie, { method: 'POST', headers: { Origin: baseUrl } });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.revokedCount, 2);
  const event = (await streamEntries(user.userId)).filter((entry) => entry.message.eventType === 'LOGOUT_ALL');
  assert.equal(event.length, 1);
  assert.equal(event[0].message.revokedCount, '2');
}));

test('TC-08: BR-02 eviction records only actual SESSION_AUTO_REVOKED events', testOptions, async () => fixture(async ({ users, login }) => {
  const user = users[0];
  await login(user); await login(user); await login(user);
  assert.equal((await streamEntries(user.userId)).filter((entry) => entry.message.eventType === 'SESSION_AUTO_REVOKED').length, 0);
  await login(user);
  const entries = await streamEntries(user.userId);
  assert.equal(entries.filter((entry) => entry.message.eventType === 'SESSION_AUTO_REVOKED').length, 1);
  assert.equal(entries.filter((entry) => entry.message.eventType === 'LOGIN_SUCCESS').length, 4);
  assert.equal((await client.sCard(`user:sessions:${user.userId}`)), 3);
}));

test('TC-09: ADMIN revocation is visible to actor, target, and global history', testOptions, async () => fixture(async ({ users, login }) => {
  const [user, admin] = users; const targetLogin = await login(user); const actorLogin = await login(admin);
  const list = await (await call(`/api/admin/users/${user.userId}/sessions`, actorLogin.cookie)).json();
  const response = await call(`/api/admin/users/${user.userId}/sessions/${list.sessions[0].managementId}`, actorLogin.cookie, {
    method: 'DELETE', headers: { Origin: baseUrl },
  });
  assert.equal(response.status, 200);
  const payload = (await response.json()); assert.equal(payload.auditRecorded, true);
  assert.equal((await call('/api/me', targetLogin.cookie)).status, 401);
  const targetReauthenticated = await login(user);
  const targetHistory = await (await userHistory(targetReauthenticated.cookie)).json();
  assert.ok(targetHistory.items.some((entry) => entry.eventType === 'ADMIN_SESSION_REVOKED' && entry.actorUserId === admin.userId));
  const actorHistory = await (await userHistory(actorLogin.cookie)).json();
  assert.ok(actorHistory.items.some((entry) => entry.eventType === 'ADMIN_SESSION_REVOKED' && entry.targetUserId === user.userId));
}));

test('TC-10: ADMIN can revoke a session of another ADMIN and keeps its own session', testOptions, async () => fixture(async ({ users, login }) => {
  const [actor, target] = users; const targetLogin = await login(target); const actorLogin = await login(actor);
  const targetSessions = await (await call(`/api/admin/users/${target.userId}/sessions`, actorLogin.cookie)).json();
  const response = await call(`/api/admin/users/${target.userId}/sessions/${targetSessions.sessions[0].managementId}`, actorLogin.cookie, {
    method: 'DELETE', headers: { Origin: baseUrl },
  });
  assert.equal(response.status, 200);
  assert.equal((await call('/api/me', targetLogin.cookie)).status, 401);
  assert.equal((await call('/api/me', actorLogin.cookie)).status, 200);
  const event = (await streamEntries(target.userId)).find((entry) => entry.message.eventType === 'ADMIN_SESSION_REVOKED');
  assert.equal(event.message.actorUserId, actor.userId);
}, ['ADMIN', 'ADMIN']));

test('TC-11: ADMIN logout-all creates one ADMIN_LOGOUT_ALL event for the target', testOptions, async () => fixture(async ({ users, login }) => {
  const [target, admin] = users; await login(target); await login(target); const actor = await login(admin);
  const response = await call(`/api/admin/users/${target.userId}/logout-all`, actor.cookie, {
    method: 'POST', headers: { Origin: baseUrl },
  });
  assert.equal(response.status, 200);
  const stream = await streamEntries(target.userId);
  const events = stream.filter((entry) => entry.message.eventType === 'ADMIN_LOGOUT_ALL');
  assert.equal(events.length, 1);
  assert.equal(events[0].message.actorUserId, admin.userId);
  assert.equal(Number(events[0].message.revokedCount), 2);
}));

test('TC-12: personal history is isolated to the authenticated user', testOptions, async () => fixture(async ({ users, login }) => {
  const first = await login(users[0]); const second = await login(users[1]);
  const response = await userHistory(first.cookie);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.ok(data.items.some((entry) => entry.targetUserId === users[0].userId));
  assert.equal(data.items.some((entry) => entry.targetUserId === users[1].userId), false);
  assert.equal((await userHistory(first.cookie, `userId=${users[1].userId}`)).status, 400);
  assert.equal((await userHistory(second.cookie)).status, 200);
}));

test('TC-13: USER receives 403 for system-wide Admin history', testOptions, async () => fixture(async ({ users, login }) => {
  const user = await login(users[0]);
  assert.equal((await adminHistory(user.cookie)).status, 403);
}));

test('TC-14: unauthenticated history APIs return 401', testOptions, async () => fixture(async () => {
  assert.equal((await userHistory(null)).status, 401);
  assert.equal((await adminHistory(null)).status, 401);
}));

test('TC-15: ADMIN can read global USER and ADMIN events without secrets', testOptions, async () => fixture(async ({ users, login }) => {
  const [user, admin] = users; await login(user); await login(admin);
  const response = await adminHistory((await login(admin)).cookie);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.ok(data.items.some((entry) => entry.targetUserId === user.userId));
  assert.ok(data.items.some((entry) => entry.targetUserId === admin.userId));
  const raw = JSON.stringify(data);
  assert.equal(raw.includes('passwordHash'), false);
  assert.equal(raw.includes('audit-password'), false);
}));

test('TC-16: stream cursor paging has no duplicates and remains stable as new entries arrive', testOptions, async () => fixture(async ({ users, login, unknownNames }) => {
  const user = users[0]; const admin = users[1]; const actor = await login(admin);
  for (let attempt = 0; attempt < 5; attempt += 1) await login(user, 'bad-password');
  let page = await (await adminHistory(actor.cookie,
    `userId=${user.userId}&eventType=LOGIN_FAILED&limit=2`)).json();
  assert.equal(page.items.length, 2);
  const seen = new Set(page.items.map((entry) => entry.eventId));
  const lockKey = `auth:lock:${user.username}`;
  await client.del([lockKey, `auth:fail:events:${user.username}`]);
  await login(user); // A newer event must not shift the older cursor pages.
  while (page.hasMore) {
    page = await (await adminHistory(actor.cookie,
      `userId=${user.userId}&eventType=LOGIN_FAILED&limit=2&cursor=${encodeURIComponent(page.nextCursor)}`)).json();
    for (const item of page.items) {
      assert.equal(seen.has(item.eventId), false);
      seen.add(item.eventId);
    }
  }
  assert.equal(seen.size, 5);
}));

test('TC-17: filters combine correctly and reject invalid event/time inputs', testOptions, async () => fixture(async ({ users, login }) => {
  const [user, admin] = users; const actor = await login(admin);
  await login(user);
  const from = new Date(Date.now() - 5000).toISOString();
  const to = new Date(Date.now() + 1000).toISOString();
  const filtered = await adminHistory(actor.cookie,
    `userId=${user.userId}&eventType=LOGIN_SUCCESS&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  const body = await filtered.json();
  assert.equal(filtered.status, 200);
  assert.ok(body.items.length >= 1);
  assert.ok(body.items.every((item) => item.targetUserId === user.userId && item.eventType === 'LOGIN_SUCCESS'));
  assert.equal((await adminHistory(actor.cookie, 'eventType=NOPE')).status, 400);
  assert.equal((await adminHistory(actor.cookie, 'from=not-a-date')).status, 400);
  assert.equal((await adminHistory(actor.cookie, `from=${to}&to=${from}`)).status, 400);
}));

test('TC-18: exact retention trim keeps young entries, trims old entries, then expires idle stream', testOptions, async () => fixture(async ({ users, login }) => {
  const user = users[0]; const signedIn = await login(user);
  await login(user, 'bad-password');
  await new Promise((resolve) => setTimeout(resolve, 2200));
  await login(user); // new append trims only entries older than the four-second retention window.
  const streamKey = audit.userStreamKey(user.userId);
  assert.equal(await client.xLen(streamKey), 3);
  await new Promise((resolve) => setTimeout(resolve, 2200));
  const response = await userHistory(signedIn.cookie);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.items.some((entry) => entry.eventType === 'LOGIN_FAILED'), false);
  assert.ok(data.items.some((entry) => entry.eventType === 'LOGIN_SUCCESS'));
  await new Promise((resolve) => setTimeout(resolve, 2100));
  assert.equal(await client.exists(streamKey), 0);
}));

test('TC-19: concurrent successful logins audit only actual sessions and preserve BR-01/02 indexes', testOptions, async () => fixture(async ({ users, login }) => {
  const user = users[0];
  const results = await Promise.all(Array.from({ length: 10 }, () => login(user)));
  assert.ok(results.every((result) => result.response.status === 200));
  const events = await streamEntries(user.userId);
  assert.equal(events.filter((entry) => entry.message.eventType === 'LOGIN_SUCCESS').length, 10);
  assert.equal(events.filter((entry) => entry.message.eventType === 'SESSION_AUTO_REVOKED').length, 7);
  const setIds = await client.sMembers(`user:sessions:${user.userId}`);
  const orderIds = await client.zRange(`user:sessions:order:${user.userId}`, 0, -1);
  assert.equal(setIds.length, 3);
  assert.deepEqual(new Set(setIds), new Set(orderIds));
}));

test('TC-20: demoted ADMIN loses global history access but retains personal history', testOptions, async () => fixture(async ({ users, login }) => {
  const admin = users.find((user) => user.role === 'ADMIN'); const signedIn = await login(admin);
  await client.hSet(`user:${admin.userId}`, { role: 'USER' });
  assert.equal((await adminHistory(signedIn.cookie)).status, 403);
  assert.equal((await userHistory(signedIn.cookie)).status, 200);
}));

test('TC-21: audit fields and history responses contain no password, cookie, sessionId, or managementId', testOptions, async () => fixture(async ({ users, login }) => {
  const user = users[0]; const signedIn = await login(user);
  const me = await (await call('/api/me', signedIn.cookie)).json();
  const data = await (await userHistory(signedIn.cookie)).json();
  const entries = await streamEntries(user.userId);
  const raw = JSON.stringify({ data, entries });
  for (const forbidden of ['passwordHash', 'audit-password', signedIn.sessionId, me.managementId, signedIn.cookie]) {
    assert.equal(raw.includes(forbidden), false);
  }
}));

test('TC-22: wrong audit key type fails before login mutation and reports no fake success', testOptions, async () => fixture(async ({ users, login }) => {
  const user = users[0];
  await client.set(audit.userStreamKey(user.userId), 'wrong-type');
  const response = await login(user);
  assert.equal(response.response.status, 500);
  assert.equal(response.body.success, false);
  assert.equal(await client.sCard(`user:sessions:${user.userId}`), 0);
  assert.equal(await client.get(`login:count:${user.userId}`), null);
  assert.equal(await client.type(audit.globalStreamKey()), 'stream');
}));

test('TC-23: retention cleanup touches audit streams only', testOptions, async () => fixture(async ({ users, login }) => {
  const user = users[0]; const signedIn = await login(user);
  await client.set(`auth:lock:${user.username}`, '1', { EX: 100 });
  await client.set(`login:count:${user.userId}`, '12');
  const oldStream = audit.userStreamKey(`cleanup-${crypto.randomUUID()}`);
  await client.xAdd(oldStream, `${Date.now() - 10000}-0`, { eventType: 'LOGIN_SUCCESS', occurredAtMs: String(Date.now() - 10000) });
  await client.expire(oldStream, 100);
  await audit.cleanupOnce();
  assert.equal(await client.xLen(oldStream), 0);
  assert.equal(await client.type(`user:${user.userId}`), 'hash');
  assert.equal(await client.exists(`session:${signedIn.sessionId}`), 1);
  assert.equal(await client.get(`auth:lock:${user.username}`), '1');
  assert.equal(await client.get(`login:count:${user.userId}`), '12');
  await client.del(oldStream);
}));

test('TC-24: cursor, limit, eventType, and date validation rejects malformed input', testOptions, async () => fixture(async ({ users, login }) => {
  const admin = users.find((user) => user.role === 'ADMIN'); const actor = await login(admin);
  assert.equal((await adminHistory(actor.cookie, 'cursor=bad')).status, 400);
  assert.equal((await adminHistory(actor.cookie, 'limit=101')).status, 400);
  assert.equal((await adminHistory(actor.cookie, 'limit=0')).status, 400);
  assert.equal((await adminHistory(actor.cookie, 'eventType=FAKE')).status, 400);
  assert.equal((await adminHistory(actor.cookie, 'to=not-time')).status, 400);
  assert.equal((await adminHistory(actor.cookie, `userId=${'x'.repeat(129)}`)).status, 400);
}));
