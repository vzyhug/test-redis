const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { after, before, test } = require('node:test');
const { once } = require('node:events');

const testRedisUrl = process.env.REDIS_TEST_URL;
if (testRedisUrl) process.env.REDIS_URL = testRedisUrl;
const { client, connectRedis } = require('../src/redisClient');
const { app } = require('../server');
const security = require('../src/securityService');
const audit = require('../src/auditService');
const bcrypt = require('bcrypt');

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

const options = { skip: !testRedisUrl };
const password = 'report-test-password';
const today = () => new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
const shiftDate = (date, days) => {
  const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10);
};
const range = (from = shiftDate(today(), -6), to = today()) => `from=${from}&to=${to}`;

function parseCsv(source) {
  const text = source.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += char;
  }
  return rows.filter((values) => values.some((value) => value !== ''));
}

function account(role) {
  const userId = `report-${crypto.randomUUID()}`;
  return { userId, username: `${userId.replaceAll('-', '_')}`, role };
}

async function seed(user) {
  await client.hSet(`user:${user.userId}`, {
    username: user.username, role: user.role,
    passwordHash: await bcrypt.hash(password, 4),
  });
  await client.set(`username:${user.username}`, user.userId);
}

async function signIn(user, suppliedPassword = password) {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ username: user.username, password: suppliedPassword }),
  });
  return { response, cookie: response.headers.get('set-cookie')?.split(';', 1)[0] || '' };
}

async function api(path, cookie = '', init = {}) {
  return fetch(`${baseUrl}${path}`, { ...init, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(init.headers || {}) } });
}

async function fixture(callback, { login = true, username, prepare } = {}) {
  const user = account('USER');
  if (username) user.username = username;
  const admin = account('ADMIN');
  const globalStart = (await client.xRevRange('audit:auth:global', '+', '-', { COUNT: 1 }))[0]?.id || '-';
  const securityAlertIds = new Set();
  try {
    await Promise.all([seed(user), seed(admin)]);
    if (prepare) await prepare({ user, admin });
    const signed = login ? await signIn(user) : null;
    const adminSigned = login ? await signIn(admin) : null;
    if (login) {
      assert.equal(signed.response.status, 200);
      assert.equal(adminSigned.response.status, 200);
    }
    await callback({ user, admin, cookie: signed?.cookie || '', adminCookie: adminSigned?.cookie || '', securityAlertIds });
  } finally {
    const globalEntries = await client.xRange('audit:auth:global', globalStart === '-' ? '-' : `(${globalStart}`, '+', { COUNT: 10000 }).catch(() => []);
    const userIds = new Set([user.userId, admin.userId]);
    const ownedGlobalIds = globalEntries.filter((entry) => userIds.has(entry.message.actorUserId) || userIds.has(entry.message.targetUserId)).map((entry) => entry.id);
    if (ownedGlobalIds.length) await client.xDel('audit:auth:global', ownedGlobalIds);
    for (const current of [user, admin]) {
      const sessions = await client.sMembers(`user:sessions:${current.userId}`).catch(() => []);
      await client.del([
        `user:${current.userId}`, `username:${current.username}`, `user:sessions:${current.userId}`,
        `user:sessions:order:${current.userId}`, `login:count:${current.userId}`, `audit:auth:user:${current.userId}`,
        `auth:fail:events:${current.username}`, `auth:lock:${current.username}`,
        security.knownDevices(current.userId), security.knownIps(current.userId), security.baseline(current.userId),
        ...sessions.map((id) => `session:${id}`),
      ]);
      const alertIndex = security.userIndex(current.userId);
      const alertIds = await client.zRange(alertIndex, 0, -1).catch(() => []);
      for (const alertId of alertIds) {
        securityAlertIds.add(alertId);
        await client.del(security.keyAlert(alertId), `security:alert:events:${alertId}`);
        for (const index of [security.globalIndex(), `${security.globalIndex()}:open`, `${security.globalIndex()}:high`, `${security.globalIndex()}:resolved`,
          alertIndex, `${alertIndex}:open`, `${alertIndex}:high`, `${alertIndex}:resolved`]) await client.zRem(index, alertId).catch(() => 0);
      }
      await client.del(alertIndex, `${alertIndex}:open`, `${alertIndex}:high`, `${alertIndex}:resolved`);
      const dedupe = await client.scan('0', { MATCH: `security:dedupe:${current.userId}:*`, COUNT: 100 });
      if (dedupe.keys.length) await client.del(dedupe.keys);
    }
    if (securityAlertIds.size && await client.type('security:alerts:events') === 'stream') {
      const events = await client.xRange('security:alerts:events', '-', '+');
      const ids = events.filter((entry) => securityAlertIds.has(entry.message.alertId)).map((entry) => entry.id);
      if (ids.length) await client.xDel('security:alerts:events', ids);
    }
  }
}

async function addAudit(user, eventType, occurredAtMs = Date.now(), extra = {}) {
  const id = await client.xAdd(`audit:auth:user:${user.userId}`, '*', {
    eventId: crypto.randomUUID(), eventType, actorUserId: user.userId, actorRole: user.role,
    actorUsername: user.username, targetUserId: user.userId, username: user.username,
    occurredAtMs: String(occurredAtMs), result: eventType === 'LOGIN_FAILED' ? 'FAILED' : 'SUCCESS',
    device: 'Chrome · Windows · Desktop', ip: '127.0.0.1', ...extra,
  });
  return id;
}

let alertSequence = 0;
async function createAlert(user, { severity = 'MEDIUM', status = 'OPEN' } = {}) {
  const knownDevice = crypto.createHash('sha256').update('Chrome|Windows|Desktop').digest('hex');
  await client.sAdd(security.knownDevices(user.userId), knownDevice);
  await client.sAdd(security.knownIps(user.userId), '198.51.100.1');
  await client.set(security.baseline(user.userId), '1', { EX: security.RETENTION_SECONDS });
  alertSequence += 1;
  const ip = `198.51.100.${(alertSequence % 200) + 2}`;
  const observed = await security.observeSuccessfulLogin({ userId: user.userId, username: user.username, userAgent: 'Firefox/124 Windows NT 10', ip, managementId: 'not-an-auth-token' });
  assert.equal(observed.alertCreated, true);
  if (status !== 'OPEN') {
    const now = Date.now();
    await client.hSet(security.keyAlert(observed.alertId), {
      status, readAt: String(now), resolvedAt: String(now), resolvedBy: user.userId,
      resolution: status === 'RESOLVED_SAFE' ? 'SAFE' : 'SESSION_REVOKED',
    });
    const userKey = security.userIndex(user.userId);
    for (const index of [userKey, security.globalIndex()]) {
      await client.zRem(`${index}:open`, observed.alertId);
      await client.zAdd(`${index}:resolved`, { score: now, value: observed.alertId });
    }
  }
  if (severity !== 'MEDIUM') {
    await client.hSet(security.keyAlert(observed.alertId), { severity });
    if (severity === 'HIGH') for (const index of [security.userIndex(user.userId), security.globalIndex()]) {
      await client.zAdd(`${index}:high`, { score: Date.now(), value: observed.alertId });
    }
  }
  return observed.alertId;
}

async function readExport(response) {
  const text = Buffer.from(await response.arrayBuffer()).toString('utf8');
  return { text, rows: parseCsv(text) };
}

test('EX-TC-01: USER exports own activity CSV from Redis', options, async () => fixture(async ({ user, cookie }) => {
  const result = await readExport(await api(`/api/reports/history/export?${range()}`, cookie));
  assert.equal(result.rows[0][3], 'Loại sự kiện');
  assert.ok(result.rows.slice(1).some((row) => row[2] === user.username && row[3] === 'LOGIN_SUCCESS'));
}));

test('EX-TC-02: USER cannot choose another account for history export', options, async () => fixture(async ({ user, cookie }) => {
  const response = await api(`/api/reports/history/export?${range()}&userId=someone-else`, cookie);
  assert.equal(response.status, 400);
}));

test('EX-TC-03: ADMIN exports global activity once per Redis global-stream event', options, async () => fixture(async ({ admin, adminCookie, user }) => {
  await signIn(user);
  const { rows } = await readExport(await api(`/api/admin/reports/history/export?${range()}`, adminCookie));
  assert.ok(rows.slice(1).some((row) => row[2] === user.username && row[3] === 'LOGIN_SUCCESS'));
  assert.equal(rows.slice(1).filter((row) => row[2] === user.username && row[3] === 'LOGIN_SUCCESS').length, 2);
}));

test('EX-TC-04: ADMIN filters audit export by userId', options, async () => fixture(async ({ admin, adminCookie, user }) => {
  const response = await api(`/api/admin/reports/history/export?${range()}&userId=${user.userId}`, adminCookie);
  const { rows } = await readExport(response);
  assert.ok(rows.slice(1).length > 0);
  assert.ok(rows.slice(1).every((row) => row[2] === user.username));
}));

test('EX-TC-05: audit date filter includes local day start and end-date events', options, async () => fixture(async ({ user, cookie }) => {
  const from = shiftDate(today(), -1);
  const start = Date.parse(`${from}T00:00:00Z`) - 7 * 3600000;
  await addAudit(user, 'LOGIN_SUCCESS', start);
  await addAudit(user, 'LOGIN_FAILED', Date.now() - 5);
  const { rows } = await readExport(await api(`/api/reports/history/export?${range(from, today())}`, cookie));
  assert.ok(rows.slice(1).some((row) => row[1] === `${from} 00:00:00 +07:00`));
  assert.ok(rows.slice(1).some((row) => row[3] === 'LOGIN_FAILED'));
}));

test('EX-TC-06: eventType filter returns only that event type', options, async () => fixture(async ({ user, cookie }) => {
  await addAudit(user, 'LOGIN_FAILED');
  const { rows } = await readExport(await api(`/api/reports/history/export?${range()}&eventType=LOGIN_FAILED`, cookie));
  assert.ok(rows.slice(1).length > 0);
  assert.ok(rows.slice(1).every((row) => row[3] === 'LOGIN_FAILED'));
}));

test('EX-TC-07: USER exports only their Security Center alerts', options, async () => fixture(async ({ user, cookie, admin }) => {
  const ownAlert = await createAlert(user);
  await createAlert(admin);
  const { rows } = await readExport(await api(`/api/reports/security/export?${range()}`, cookie));
  assert.ok(rows.slice(1).some((row) => row[1] === ownAlert));
  assert.ok(rows.slice(1).every((row) => row[3] === user.username));
}));

test('EX-TC-08: ADMIN exports alerts across accounts', options, async () => fixture(async ({ user, admin, adminCookie }) => {
  const userAlert = await createAlert(user);
  const adminAlert = await createAlert(admin);
  const { rows } = await readExport(await api(`/api/admin/reports/security/export?${range()}`, adminCookie));
  assert.ok(rows.some((row) => row[1] === userAlert));
  assert.ok(rows.some((row) => row[1] === adminAlert));
}));

test('EX-TC-09: severity and current status filters apply together', options, async () => fixture(async ({ user, cookie }) => {
  await createAlert(user, { severity: 'HIGH', status: 'RESOLVED_SAFE' });
  await createAlert(user, { severity: 'LOW' });
  const { rows } = await readExport(await api(`/api/reports/security/export?${range()}&severity=HIGH&status=RESOLVED_SAFE`, cookie));
  assert.ok(rows.slice(1).length > 0);
  assert.ok(rows.slice(1).every((row) => row[6] === 'HIGH' && row[9] === 'RESOLVED_SAFE'));
}));

test('EX-TC-10: resolved alert exports current timestamp and actor', options, async () => fixture(async ({ user, cookie }) => {
  const id = await createAlert(user, { status: 'RESOLVED_SAFE' });
  const { rows } = await readExport(await api(`/api/reports/security/export?${range()}&status=RESOLVED_SAFE`, cookie));
  const row = rows.find((value) => value[1] === id);
  assert.ok(row);
  assert.ok(row[11].endsWith('+07:00'));
  assert.equal(row[12], user.userId);
  assert.equal(row[13], 'SAFE');
}));

test('EX-TC-11: summary counts successful and failed logins from audit events', options, async () => fixture(async ({ user, cookie }) => {
  await addAudit(user, 'LOGIN_SUCCESS');
  await addAudit(user, 'LOGIN_FAILED');
  const { rows } = await readExport(await api(`/api/reports/summary/export?from=${today()}&to=${today()}`, cookie));
  const current = rows.find((row) => row[0] === today());
  assert.equal(Number(current[1]), 2);
  assert.equal(Number(current[2]), 1);
}));

test('EX-TC-12: summary selects one source stream and does not double-count actor/user copies', options, async () => fixture(async ({ user, admin, adminCookie, cookie }) => {
  const personal = await readExport(await api(`/api/reports/summary/export?from=${today()}&to=${today()}`, cookie));
  const global = await readExport(await api(`/api/admin/reports/summary/export?from=${today()}&to=${today()}&userId=${user.userId}`, adminCookie));
  const personalCount = Number(personal.rows.find((row) => row[0] === today())[1]);
  const globalCount = Number(global.rows.find((row) => row[0] === today())[1]);
  assert.equal(personalCount, globalCount);
  assert.ok(await client.exists(`user:${admin.userId}`));
}));

test('EX-TC-13: summary groups real audit activity by Vietnam day', options, async () => fixture(async ({ user, cookie }) => {
  const { rows } = await readExport(await api(`/api/reports/summary/export?from=${today()}&to=${today()}`, cookie));
  assert.equal(rows.length, 2);
  assert.equal(rows[1][0], today());
  assert.ok(Number(rows[1][1]) >= 1);
}));

test('EX-TC-14: CSV preserves Vietnamese text with UTF-8 BOM', options, async () => fixture(async ({ user, cookie }) => {
  await addAudit(user, 'LOGIN_FAILED', Date.now(), { username: 'Nguyễn Văn Á' });
  const { text, rows } = await readExport(await api(`/api/reports/history/export?${range()}`, cookie));
  assert.ok(text.startsWith('\uFEFF'));
  assert.ok(rows.some((row) => row[2] === 'Nguyễn Văn Á'));
}));

test('EX-TC-15: CSV quotes commas, quotation marks, and embedded newlines', options, async () => fixture(async ({ user, cookie }) => {
  await addAudit(user, 'LOGIN_FAILED', Date.now(), { username: 'Nguyễn, "An"\nPhòng 2', reason: 'INVALID, "PASSWORD"\r\nRETRY' });
  const { rows } = await readExport(await api(`/api/reports/history/export?${range()}`, cookie));
  const row = rows.find((value) => value[2].includes('Nguyễn'));
  assert.equal(row[2], 'Nguyễn, "An"\nPhòng 2');
  assert.equal(row[7], 'INVALID, "PASSWORD"\r\nRETRY');
}));

test('EX-TC-16: CSV formula prefixes are neutralized for spreadsheet imports', options, async () => fixture(async ({ user, cookie }) => {
  await addAudit(user, 'LOGIN_FAILED', Date.now(), { username: '=HYPERLINK("https://invalid")' });
  const { rows } = await readExport(await api(`/api/reports/history/export?${range()}`, cookie));
  assert.equal(rows.find((row) => row[2].startsWith("'=HYPERLINK"))[2], "'=HYPERLINK(\"https://invalid\")");
}));

test('EX-TC-17: exported files omit authentication and password secrets', options, async () => fixture(async ({ user, cookie }) => {
  const { text } = await readExport(await api(`/api/reports/history/export?${range()}`, cookie));
  for (const secret of ['passwordHash', password, 'sessionId', cookie.split('=')[1]]) assert.equal(text.includes(secret), false);
}));

test('EX-TC-18: unauthenticated report request returns 401', options, async () => fixture(async () => {
  const response = await api(`/api/reports/history/export?${range()}`);
  assert.equal(response.status, 401);
}));

test('EX-TC-19: USER cannot call Admin report API', options, async () => fixture(async ({ cookie }) => {
  const response = await api(`/api/admin/reports/history/export?${range()}`, cookie);
  assert.equal(response.status, 403);
}));

test('EX-TC-20: reversed date range returns 400', options, async () => fixture(async ({ cookie }) => {
  const response = await api(`/api/reports/history/export?from=${today()}&to=${shiftDate(today(), -1)}`, cookie);
  assert.equal(response.status, 400);
}));

test('EX-TC-21: range longer than 30 inclusive days returns 400', options, async () => fixture(async ({ cookie }) => {
  const response = await api(`/api/reports/history/export?from=${shiftDate(today(), -30)}&to=${today()}`, cookie);
  assert.equal(response.status, 400);
}));

test('EX-TC-22: exceeding EXPORT_MAX_ROWS fails instead of returning a truncated CSV', options, async () => fixture(async ({ user, cookie }) => {
  const response = await api(`/api/reports/history/export?from=${today()}&to=${today()}`, cookie);
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, 'EXPORT_ROW_LIMIT');
}, { prepare: async ({ user }) => {
  const start = Date.now() - 10_000;
  const multi = client.multi();
  for (let i = 0; i < 5001; i += 1) multi.xAdd(`audit:auth:user:${user.userId}`, `${start}-${i}`, {
    eventId: `bulk-${i}`, eventType: 'LOGIN_SUCCESS', actorUserId: user.userId,
    targetUserId: user.userId, username: user.username, occurredAtMs: String(start + i), result: 'SUCCESS',
  });
  await multi.exec();
} }));

test('EX-TC-23: no data returns a valid header-only CSV and empty marker', options, async () => fixture(async ({ user, cookie }) => {
  const emptyDate = shiftDate(today(), -20);
  const response = await api(`/api/reports/history/export?from=${emptyDate}&to=${emptyDate}`, cookie);
  const { rows } = await readExport(response);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-report-empty'), 'true');
  assert.equal(rows.length, 1);
}));

test('EX-TC-24: Redis source type error returns JSON 503, not CSV', options, async () => fixture(async ({ user, cookie }) => {
  const key = `audit:auth:user:${user.userId}`;
  await client.set(key, 'wrong-type');
  const response = await api(`/api/reports/history/export?${range()}`, cookie);
  assert.equal(response.status, 503);
  assert.match(response.headers.get('content-type'), /application\/json/);
}));

test('EX-TC-25: export does not alter audit and alert records beyond auth middleware TTL refresh', options, async () => fixture(async ({ user, cookie }) => {
  await createAlert(user);
  const before = {
    stream: await client.xRange(`audit:auth:user:${user.userId}`, '-', '+'),
    alerts: await client.zRange(security.userIndex(user.userId), 0, -1),
  };
  await api(`/api/reports/summary/export?${range()}`, cookie);
  const afterState = {
    stream: await client.xRange(`audit:auth:user:${user.userId}`, '-', '+'),
    alerts: await client.zRange(security.userIndex(user.userId), 0, -1),
  };
  assert.deepEqual(afterState, before);
}));

test('EX-TC-26: exported timestamps use one explicit Vietnam timezone format', options, async () => fixture(async ({ user, cookie }) => {
  const { rows } = await readExport(await api(`/api/reports/history/export?${range()}`, cookie));
  assert.match(rows[1][1], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+07:00$/);
}));

test('EX-TC-27: batched stream export contains every row once across page boundaries', options, async () => fixture(async ({ user, cookie }) => {
  const { rows } = await readExport(await api(`/api/reports/history/export?${range()}`, cookie));
  const ids = rows.slice(1).map((row) => row[7]).filter((value) => value.startsWith('page-'));
  assert.equal(rows.length, 532);
  assert.equal(ids.length, 530);
  assert.equal(new Set(ids).size, ids.length);
}, { prepare: async ({ user }) => {
  const start = Date.now() - 10_000;
  const multi = client.multi();
  for (let i = 0; i < 530; i += 1) multi.xAdd(`audit:auth:user:${user.userId}`, `${start}-${i}`, {
    eventId: `page-${i}`, eventType: 'LOGIN_SUCCESS', actorUserId: user.userId,
    targetUserId: user.userId, username: user.username, occurredAtMs: String(start + i), result: 'SUCCESS', reason: `page-${i}`,
  });
  await multi.exec();
} }));

test('EX-TC-28: response has CSV content type, attachment name, and BOM header', options, async () => fixture(async ({ cookie }) => {
  const response = await api(`/api/reports/history/export?${range()}`, cookie);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/csv; charset=utf-8/i);
  assert.match(response.headers.get('content-disposition'), /^attachment; filename="lich-su-hoat-dong-\d{4}-\d{2}-\d{2}\.csv"$/);
  assert.ok(Buffer.from(await response.arrayBuffer()).toString('utf8').startsWith('\uFEFF'));
}));
