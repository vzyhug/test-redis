const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { once } = require('node:events');

const testRedisUrl = process.env.REDIS_TEST_URL;
if (testRedisUrl) {
  process.env.REDIS_URL = testRedisUrl;
  process.env.SECURITY_ALERT_RETENTION_SECONDS = '180';
  process.env.SECURITY_ALERT_DEDUPE_SECONDS = '30';
  process.env.AUTH_FAILURE_WINDOW_SECONDS = '20';
  process.env.AUTH_LOCK_SECONDS = '2';
}
const { client, connectRedis } = require('../src/redisClient');
const sessions = require('../src/sessionService');
const security = require('../src/securityService');
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
  security.stopCleanup();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (client.isOpen) await client.quit();
});

function account(role = 'USER') {
  const id = `security-${crypto.randomUUID()}`;
  return { userId: id, username: id, email: `${id}@example.invalid`, role };
}
async function seed(user) {
  await client.hSet(`user:${user.userId}`, {
    username: user.username, email: user.email,
    passwordHash: await bcrypt.hash('security-password', 4), role: user.role,
  });
  await client.set(`username:${user.username}`, user.userId);
}
async function login(user, { ua = 'Mozilla/5.0 Chrome/124.0 Windows NT 10.0', password = 'security-password' } = {}) {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': ua },
    body: JSON.stringify({ username: user.username, password }),
  });
  return { response, cookie: response.headers.get('set-cookie')?.split(';', 1)[0] || '' };
}
async function api(route, cookie = '', options = {}) {
  return fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(options.headers || {}) },
  });
}
async function userAlerts(cookie, params = 'limit=100') {
  const response = await api(`/api/security/alerts?${params}`, cookie);
  assert.equal(response.status, 200);
  return response.json();
}
async function alertDetail(alertId, cookie) {
  const response = await api(`/api/security/alerts/${alertId}`, cookie);
  assert.equal(response.status, 200);
  return response.json();
}
async function createEnvironmentAlert(user, cookie, { ua = 'Mozilla/5.0 Firefox/124.0 Windows NT 10.0', ip = '127.0.0.1' } = {}) {
  const me = await (await api('/api/me', cookie)).json();
  return security.observeSuccessfulLogin({ userId: user.userId, username: user.username, userAgent: ua, ip, managementId: me.managementId });
}
async function clean(user, sessionIds = []) {
  const userKey = security.userIndex(user.userId);
  const alertIds = await client.zRange(userKey, 0, -1).catch(() => []);
  const globalKey = security.globalIndex();
  for (const alertId of alertIds) {
    await client.del(security.keyAlert(alertId));
    await Promise.all([client.zRem(globalKey, alertId), client.zRem(`${globalKey}:open`, alertId),
      client.zRem(`${globalKey}:high`, alertId), client.zRem(`${globalKey}:resolved`, alertId)]);
  }
  const dedupe = await client.scan('0', { MATCH: `security:dedupe:${user.userId}:*`, COUNT: 100 });
  const ids = new Set(sessionIds);
  const sessionRefs = [
    ...(await client.sMembers(`user:sessions:${user.userId}`).catch(() => [])),
    ...(await client.zRange(`user:sessions:order:${user.userId}`, 0, -1).catch(() => [])),
  ];
  sessionRefs.forEach((id) => ids.add(id));
  await client.del([
    ...Array.from(ids, (id) => `session:${id}`),
    `user:sessions:${user.userId}`, `user:sessions:order:${user.userId}`,
    `audit:auth:user:${user.userId}`, `login:count:${user.userId}`,
    `user:${user.userId}`, `username:${user.username}`,
    `auth:fail:events:${user.username}`, `auth:lock:${user.username}`,
    security.knownDevices(user.userId), security.knownIps(user.userId), security.baseline(user.userId),
    userKey, `${userKey}:open`, `${userKey}:high`, `${userKey}:resolved`, ...dedupe.keys,
  ]);
}
const it = (name, fn) => test(name, { skip: !testRedisUrl }, fn);

it('SC-TC-01: first successful login creates a baseline without an alert', async () => {
  const user = account(); let id;
  try {
    await seed(user); const result = await login(user); assert.equal(result.response.status, 200); id = result.cookie.split('=', 2)[1];
    assert.equal(await client.get(security.baseline(user.userId)), '1');
    assert.equal((await userAlerts(result.cookie)).items.length, 0);
    assert.ok(await client.sIsMember(security.knownDevices(user.userId), crypto.createHash('sha256').update('Chrome|Windows|Desktop').digest('hex')));
  } finally { await clean(user, [id]); }
});

it('SC-TC-02: a previously known environment does not create repeated alerts', async () => {
  const user = account(); const ids = [];
  try {
    await seed(user); const first = await login(user); ids.push(first.cookie.split('=', 2)[1]);
    const second = await login(user); ids.push(second.cookie.split('=', 2)[1]);
    assert.equal((await userAlerts(second.cookie)).items.length, 0);
  } finally { await clean(user, ids); }
});

it('SC-TC-03: a new browser creates one MEDIUM NEW_DEVICE alert without locking', async () => {
  const user = account(); const ids = [];
  try {
    await seed(user); const first = await login(user); ids.push(first.cookie.split('=', 2)[1]);
    const second = await login(user, { ua: 'Mozilla/5.0 Firefox/124.0 Windows NT 10.0' }); ids.push(second.cookie.split('=', 2)[1]);
    assert.equal(second.response.status, 200);
    const { items } = await userAlerts(second.cookie);
    assert.equal(items.length, 1); assert.equal(items[0].severity, 'MEDIUM'); assert.deepEqual(items[0].reasons, ['NEW_DEVICE']);
    assert.equal(await client.exists(`auth:lock:${user.username}`), 0);
  } finally { await clean(user, ids); }
});

it('SC-TC-04: a new IP creates a LOW NEW_IP alert after success', async () => {
  const user = account(); const ids = [];
  try {
    await seed(user); const first = await login(user); ids.push(first.cookie.split('=', 2)[1]);
    const result = await createEnvironmentAlert(user, first.cookie, { ip: '203.0.113.50', ua: 'Mozilla/5.0 Chrome/124.0 Windows NT 10.0' });
    assert.equal(result.alertCreated, true);
    const detail = await alertDetail(result.alertId, first.cookie);
    assert.equal(detail.alert.severity, 'LOW'); assert.deepEqual(detail.alert.reasons, ['NEW_IP']);
  } finally { await clean(user, ids); }
});

it('SC-TC-05: new device and IP are combined in one MEDIUM alert', async () => {
  const user = account(); const ids = [];
  try {
    await seed(user); const first = await login(user); ids.push(first.cookie.split('=', 2)[1]);
    const result = await createEnvironmentAlert(user, first.cookie, { ip: '198.51.100.22', ua: 'Mozilla/5.0 Firefox/124.0 Linux x86_64' });
    const list = await userAlerts(first.cookie);
    assert.equal(result.alertCreated, true); assert.equal(list.items.length, 1);
    assert.deepEqual(list.items[0].reasons.sort(), ['NEW_DEVICE', 'NEW_IP']); assert.equal(list.items[0].severity, 'MEDIUM');
  } finally { await clean(user, ids); }
});

it('SC-TC-06: failed login does not create a trusted device or IP baseline', async () => {
  const user = account();
  try {
    await seed(user); const result = await login(user, { password: 'wrong-password', ua: 'Mozilla/5.0 Firefox/124.0' });
    assert.equal(result.response.status, 401);
    assert.equal(await client.exists(security.baseline(user.userId)), 0);
    assert.equal(await client.exists(security.knownDevices(user.userId)), 0);
    assert.equal(await client.exists(security.knownIps(user.userId)), 0);
  } finally { await clean(user); }
});

it('SC-TC-07: the fifth failure creates one HIGH lockout alert only once per lock', async () => {
  const user = account();
  try {
    await seed(user);
    for (let i = 0; i < 5; i += 1) await login(user, { password: 'wrong-password' });
    const lock = await login(user, { password: 'wrong-password' }); assert.equal(lock.response.status, 429);
    const events = await client.zRange(security.userIndex(user.userId), 0, -1);
    assert.equal(events.length, 1);
    const alert = await client.hGetAll(security.keyAlert(events[0]));
    assert.equal(alert.alertType, 'LOGIN_LOCKOUT'); assert.equal(alert.severity, 'HIGH');
  } finally { await clean(user); }
});

it('SC-TC-08: lock expiry allows a later successful login and preserves existing sessions', async () => {
  const user = account(); let id;
  try {
    await seed(user); const first = await login(user); id = first.cookie.split('=', 2)[1];
    for (let i = 0; i < 5; i += 1) await login(user, { password: 'wrong-password' });
    const before = await client.ttl(`session:${id}`);
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const later = await login(user); assert.equal(later.response.status, 200);
    assert.equal(await client.exists(`session:${id}`), 1); assert.ok(await client.ttl(`session:${id}`) <= before);
  } finally { await clean(user, [id]); }
});

it('SC-TC-09: USER sees only alerts indexed to their account', async () => {
  const user = account(); const other = account(); const ids = [];
  try {
    await seed(user); await seed(other);
    const a = await login(user); const b = await login(other); ids.push(a.cookie.split('=', 2)[1], b.cookie.split('=', 2)[1]);
    const alert = await createEnvironmentAlert(user, a.cookie, { ip: '203.0.113.10' });
    await createEnvironmentAlert(other, b.cookie, { ip: '203.0.113.11' });
    const list = await userAlerts(a.cookie);
    assert.ok(list.items.some((item) => item.alertId === alert.alertId));
    assert.ok(list.items.every((item) => item.userId === user.userId));
  } finally { await clean(user, [ids[0]]); await clean(other, [ids[1]]); }
});

it('SC-TC-10: USER cannot read another account alert by ID', async () => {
  const user = account(); const other = account(); const ids = [];
  try {
    await seed(user); await seed(other); const a = await login(user); const b = await login(other); ids.push(a.cookie.split('=', 2)[1], b.cookie.split('=', 2)[1]);
    const alert = await createEnvironmentAlert(other, b.cookie, { ip: '203.0.113.12' });
    assert.equal((await api(`/api/security/alerts/${alert.alertId}`, a.cookie)).status, 404);
  } finally { await clean(user, [ids[0]]); await clean(other, [ids[1]]); }
});

it('SC-TC-11: ADMIN global listing includes alerts associated with USER and ADMIN accounts', async () => {
  const user = account(); const admin = account('ADMIN'); const ids = [];
  try {
    await seed(user); await seed(admin);
    const u = await login(user); const a = await login(admin); ids.push(u.cookie.split('=', 2)[1], a.cookie.split('=', 2)[1]);
    await createEnvironmentAlert(user, u.cookie, { ip: '203.0.113.13' });
    await createEnvironmentAlert(admin, a.cookie, { ip: '203.0.113.14' });
    const response = await api('/api/admin/security/alerts?limit=100', a.cookie); assert.equal(response.status, 200);
    const list = await response.json();
    assert.ok(list.items.some((item) => item.userId === user.userId)); assert.ok(list.items.some((item) => item.userId === admin.userId));
  } finally { await clean(user, [ids[0]]); await clean(admin, [ids[1]]); }
});

it('SC-TC-12: USER receives 403 for Admin Security Center APIs', async () => {
  const user = account(); let id;
  try {
    await seed(user); const result = await login(user); id = result.cookie.split('=', 2)[1];
    assert.equal((await api('/api/admin/security/overview', result.cookie)).status, 403);
  } finally { await clean(user, [id]); }
});

it('SC-TC-13: unauthenticated Security Center API calls return 401', async () => {
  assert.equal((await api('/api/security/overview')).status, 401);
  assert.equal((await api('/api/admin/security/overview')).status, 401);
});

it('SC-TC-14: marking read records readAt without resolving the alert', async () => {
  const user = account(); let id;
  try {
    await seed(user); const first = await login(user); id = first.cookie.split('=', 2)[1];
    const created = await createEnvironmentAlert(user, first.cookie, { ip: '203.0.113.15' });
    const response = await api(`/api/security/alerts/${created.alertId}/read`, first.cookie, { method: 'PATCH', headers: { Origin: baseUrl } });
    assert.equal(response.status, 200);
    const detail = await alertDetail(created.alertId, first.cookie);
    assert.ok(detail.alert.readAt); assert.equal(detail.alert.status, 'OPEN');
  } finally { await clean(user, [id]); }
});

it('SC-TC-15: confirming safe stores resolution timestamp and actor', async () => {
  const user = account(); let id;
  try {
    await seed(user); const first = await login(user); id = first.cookie.split('=', 2)[1];
    const created = await createEnvironmentAlert(user, first.cookie, { ip: '203.0.113.16' });
    const response = await api(`/api/security/alerts/${created.alertId}/resolve`, first.cookie, {
      method: 'PATCH', headers: { Origin: baseUrl, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'safe' }),
    });
    assert.equal(response.status, 200);
    const raw = await client.hGetAll(security.keyAlert(created.alertId));
    assert.equal(raw.status, 'RESOLVED_SAFE'); assert.equal(raw.resolvedBy, user.userId); assert.ok(Number(raw.resolvedAt) > 0);
  } finally { await clean(user, [id]); }
});

it('SC-TC-16: revoking a related non-current session removes its indexes and resolves its alert', async () => {
  const user = account(); const ids = [];
  try {
    await seed(user); const first = await login(user); ids.push(first.cookie.split('=', 2)[1]);
    const second = await login(user, { ua: 'Mozilla/5.0 Firefox/124.0 Linux x86_64' }); ids.push(second.cookie.split('=', 2)[1]);
    const list = await (await api('/api/sessions', first.cookie)).json();
    const target = list.find((session) => session.sessionId === undefined && session.device.includes('Firefox'));
    const detail = await userAlerts(first.cookie); const alert = detail.items.find((item) => item.alertType === 'NEW_LOGIN_ENVIRONMENT');
    assert.ok(alert);
    const response = await api(`/api/security/alerts/${alert.alertId}/revoke-session`, first.cookie, { method: 'POST', headers: { Origin: baseUrl } });
    assert.equal(response.status, 200);
    const body = await response.json(); assert.equal(body.sessionRevoked, true); assert.equal(body.alertStatus, 'RESOLVED_REVOKED');
    const refresh = await (await api('/api/sessions', first.cookie)).json();
    assert.equal(refresh.length, 1); assert.ok(target);

    const third = await login(user, { ua: 'Mozilla/5.0 Safari/17.0 Mac OS X' }); ids.push(third.cookie.split('=', 2)[1]);
    const currentAlert = (await userAlerts(third.cookie)).items.find((item) => item.alertType === 'NEW_LOGIN_ENVIRONMENT');
    const currentRevoke = await api(`/api/security/alerts/${currentAlert.alertId}/revoke-session`, third.cookie, { method: 'POST', headers: { Origin: baseUrl } });
    assert.equal(currentRevoke.status, 200); assert.equal((await currentRevoke.json()).currentSessionRevoked, true);
    assert.equal((await api('/api/me', third.cookie)).status, 401);
  } finally { await clean(user, ids); }
});

it('SC-TC-17: an already expired related session is not reported as revoked', async () => {
  const user = account(); const ids = [];
  try {
    await seed(user); const first = await login(user); ids.push(first.cookie.split('=', 2)[1]);
    const second = await login(user, { ua: 'Mozilla/5.0 Firefox/124.0 Linux x86_64' }); ids.push(second.cookie.split('=', 2)[1]);
    const alert = (await userAlerts(first.cookie)).items.find((item) => item.alertType === 'NEW_LOGIN_ENVIRONMENT');
    const detail = await security.getAlertSession(alert.alertId, user.userId);
    await sessions.revokeSession(user.userId, detail.managementId, ids[0]);
    const response = await api(`/api/security/alerts/${alert.alertId}/revoke-session`, first.cookie, { method: 'POST', headers: { Origin: baseUrl } });
    assert.equal(response.status, 409); assert.equal((await response.json()).sessionActive, false);
    assert.equal((await client.hGet(security.keyAlert(alert.alertId), 'status')), 'OPEN');
  } finally { await clean(user, ids); }
});

it('SC-TC-18: ADMIN can revoke a USER session from its alert', async () => {
  const user = account(); const admin = account('ADMIN'); const ids = [];
  try {
    await seed(user); await seed(admin); const u1 = await login(user); ids.push(u1.cookie.split('=', 2)[1]);
    const u2 = await login(user, { ua: 'Mozilla/5.0 Firefox/124.0 Windows NT 10.0' }); ids.push(u2.cookie.split('=', 2)[1]);
    const a = await login(admin); ids.push(a.cookie.split('=', 2)[1]);
    const alert = (await userAlerts(u1.cookie)).items.find((item) => item.alertType === 'NEW_LOGIN_ENVIRONMENT');
    const response = await api(`/api/admin/security/alerts/${alert.alertId}/revoke-session`, a.cookie, { method: 'POST', headers: { Origin: baseUrl } });
    assert.equal(response.status, 200); assert.equal((await response.json()).alertStatus, 'RESOLVED_REVOKED');
    assert.equal((await api('/api/me', u2.cookie)).status, 401);
  } finally { await clean(user, ids.slice(0, 2)); await clean(admin, ids.slice(2)); }
});

it('SC-TC-19: ADMIN can resolve an alert belonging to a different ADMIN account', async () => {
  const target = account('ADMIN'); const actor = account('ADMIN'); const ids = [];
  try {
    await seed(target); await seed(actor); const t = await login(target); ids.push(t.cookie.split('=', 2)[1]);
    await login(target, { ua: 'Mozilla/5.0 Firefox/124.0 Linux x86_64' });
    const a = await login(actor); ids.push(a.cookie.split('=', 2)[1]);
    const alert = (await userAlerts(t.cookie)).items.find((item) => item.alertType === 'NEW_LOGIN_ENVIRONMENT');
    const response = await api(`/api/admin/security/alerts/${alert.alertId}/resolve`, a.cookie, {
      method: 'PATCH', headers: { Origin: baseUrl, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'safe' }),
    });
    assert.equal(response.status, 200);
    const raw = await client.hGetAll(security.keyAlert(alert.alertId)); assert.equal(raw.resolvedBy, actor.userId);

    const ownAlert = await createEnvironmentAlert(actor, a.cookie, { ip: '203.0.113.71', ua: 'Opera/99.0 Linux' });
    const selfRevoke = await api(`/api/admin/security/alerts/${ownAlert.alertId}/revoke-session`, a.cookie, { method: 'POST', headers: { Origin: baseUrl } });
    assert.equal(selfRevoke.status, 200); assert.equal((await selfRevoke.json()).currentSessionRevoked, true);
    assert.equal((await api('/api/me', a.cookie)).status, 401);
  } finally { await clean(target, [ids[0]]); await clean(actor, [ids[1]]); }
});

it('SC-TC-20: concurrent resolve and revoke cannot produce contradictory alert outcomes', async () => {
  const user = account(); const ids = [];
  try {
    await seed(user); const a = await login(user); ids.push(a.cookie.split('=', 2)[1]);
    const b = await login(user, { ua: 'Mozilla/5.0 Firefox/124.0 Linux x86_64' }); ids.push(b.cookie.split('=', 2)[1]);
    const alert = (await userAlerts(a.cookie)).items.find((item) => item.alertType === 'NEW_LOGIN_ENVIRONMENT');
    const [safe, revoke] = await Promise.all([
      api(`/api/security/alerts/${alert.alertId}/resolve`, a.cookie, { method: 'PATCH', headers: { Origin: baseUrl, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'safe' }) }),
      api(`/api/security/alerts/${alert.alertId}/revoke-session`, a.cookie, { method: 'POST', headers: { Origin: baseUrl } }),
    ]);
    const status = await client.hGet(security.keyAlert(alert.alertId), 'status');
    assert.ok(['RESOLVED_SAFE', 'RESOLVED_REVOKED'].includes(status));
    if (status === 'RESOLVED_SAFE') { assert.equal(safe.status, 200); assert.equal(revoke.status, 409); assert.equal(await client.exists(`session:${ids[1]}`), 1); }
    else { assert.equal(revoke.status, 200); assert.ok([200, 409].includes(safe.status)); assert.equal(await client.exists(`session:${ids[1]}`), 0); }
  } finally { await clean(user, ids); }
});

it('SC-TC-21: cursor pages do not duplicate alerts and severity filters apply', async () => {
  const user = account(); let id;
  try {
    await seed(user); const first = await login(user); id = first.cookie.split('=', 2)[1];
    for (let i = 20; i < 25; i += 1) await createEnvironmentAlert(user, first.cookie, { ip: `203.0.113.${i}` });
    const page1 = await userAlerts(first.cookie, 'limit=2'); assert.equal(page1.items.length, 2); assert.ok(page1.hasMore);
    const page2Response = await api(`/api/security/alerts?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`, first.cookie);
    const page2 = await page2Response.json();
    assert.equal(page2.items.length, 2); assert.equal(new Set([...page1.items, ...page2.items].map((item) => item.alertId)).size, 4);
    const filtered = await userAlerts(first.cookie, 'limit=100&severity=LOW'); assert.ok(filtered.items.every((item) => item.severity === 'LOW'));
  } finally { await clean(user, [id]); }
});

it('SC-TC-22: cleanup removes expired IDs from hashes and status indexes', async () => {
  const user = account(); let id;
  try {
    await seed(user); const first = await login(user); id = first.cookie.split('=', 2)[1];
    const created = await createEnvironmentAlert(user, first.cookie, { ip: '203.0.113.30' });
    const cutoff = Date.now() - security.RETENTION_SECONDS * 1000;
    await client.zAdd(security.globalIndex(), [{ score: cutoff - 1, value: created.alertId }]);
    await client.zAdd(security.userIndex(user.userId), [{ score: cutoff - 1, value: created.alertId }]);
    await security.cleanupOnce();
    assert.equal(await client.exists(security.keyAlert(created.alertId)), 0);
    assert.equal(await client.zScore(security.globalIndex(), created.alertId), null);
    assert.equal(await client.zScore(`${security.userIndex(user.userId)}:open`, created.alertId), null);
  } finally { await clean(user, [id]); }
});

it('SC-TC-23: simultaneous observations for one environment create at most one alert', async () => {
  const user = account(); let id;
  try {
    await seed(user); const first = await login(user); id = first.cookie.split('=', 2)[1];
    const results = await Promise.all(Array.from({ length: 12 }, () => security.observeSuccessfulLogin({
      userId: user.userId, username: user.username, userAgent: 'Firefox/124.0 Windows NT 10.0',
      ip: '203.0.113.40', managementId: crypto.randomUUID(),
    })));
    assert.equal(results.filter((result) => result.alertCreated).length, 1);
    assert.equal((await userAlerts(first.cookie)).items.length, 1);
  } finally { await clean(user, [id]); }
});

it('SC-TC-24: alert data and responses contain no password, cookie, or auth session ID', async () => {
  const user = account(); let id;
  try {
    await seed(user); const first = await login(user); id = first.cookie.split('=', 2)[1];
    await createEnvironmentAlert(user, first.cookie, { ip: '203.0.113.41' });
    const response = await api('/api/security/alerts?limit=10', first.cookie); const body = await response.text();
    assert.doesNotMatch(body, /passwordHash|security-password|sessionId/i);
    const { items } = JSON.parse(body); const raw = await client.hGetAll(security.keyAlert(items[0].alertId));
    assert.equal('passwordHash' in raw, false); assert.equal('sessionId' in raw, false); assert.equal('cookie' in raw, false);
  } finally { await clean(user, [id]); }
});

it('SC-TC-25: missing Origin is rejected and does not resolve a warning', async () => {
  const user = account(); let id;
  try {
    await seed(user); const first = await login(user); id = first.cookie.split('=', 2)[1];
    const alert = await createEnvironmentAlert(user, first.cookie, { ip: '203.0.113.42' });
    const response = await api(`/api/security/alerts/${alert.alertId}/resolve`, first.cookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'safe' }),
    });
    assert.equal(response.status, 403); assert.equal(await client.hGet(security.keyAlert(alert.alertId), 'status'), 'OPEN');
  } finally { await clean(user, [id]); }
});

it('SC-TC-26: Redis alert-write errors do not fail a valid login or undo its session', async () => {
  const user = account(); let id;
  try {
    await seed(user); await client.set(security.knownDevices(user.userId), 'wrong-type');
    const result = await login(user); id = result.cookie.split('=', 2)[1];
    assert.equal(result.response.status, 200); assert.equal(await client.exists(`session:${id}`), 1);
  } finally { await clean(user, [id]); }
});

it('SC-TC-27: a legacy session missing loginTime is not treated as a security event', async () => {
  const user = account(); let id;
  try {
    await seed(user); id = crypto.randomUUID(); const managementId = crypto.randomUUID();
    await client.hSet(`session:${id}`, { userId: user.userId, username: user.username, role: user.role, device: 'legacy', ip: '127.0.0.1', managementId });
    await client.expire(`session:${id}`, 1200); await client.sAdd(`user:sessions:${user.userId}`, id);
    await client.zAdd(`user:sessions:order:${user.userId}`, [{ score: Date.now(), value: id }]);
    const result = await login(user); const loginId = result.cookie.split('=', 2)[1];
    assert.equal(result.response.status, 200); assert.equal((await userAlerts(result.cookie)).items.length, 0);
    assert.equal(await client.exists(`session:${id}`), 1); assert.equal(await client.hExists(`session:${id}`, 'loginTime'), false);
    await clean(user, [id, loginId]); id = loginId;
  } finally { await clean(user, [id]); }
});

it('SC-TC-28: Security Center UI uses real APIs and exposes USER/Admin navigation', () => {
  const publicDir = path.join(__dirname, '..', 'public');
  const html = fs.readFileSync(path.join(publicDir, 'security.html'), 'utf8');
  const script = fs.readFileSync(path.join(publicDir, 'security.js'), 'utf8');
  const layout = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(html, /id="securityRows"/); assert.match(html, /id="securityEvents"/);
  assert.match(script, /\/api\/security\/alerts/); assert.match(script, /\/api\/admin\/security\/alerts/);
  assert.match(layout, /Trung tâm bảo mật/); assert.doesNotMatch(script, /mock|fake alert/i);
});
