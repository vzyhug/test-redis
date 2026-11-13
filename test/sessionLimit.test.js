const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const { once } = require('node:events');

const testRedisUrl = process.env.REDIS_TEST_URL;
if (testRedisUrl) {
  process.env.REDIS_URL = testRedisUrl;
  process.env.AUTH_FAILURE_WINDOW_SECONDS = '3';
  process.env.AUTH_LOCK_SECONDS = '2';
}

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

function testUser() {
  const suffix = randomUUID();
  return {
    userId: `test-${suffix}`,
    username: `test-${suffix}`,
    role: 'USER',
  };
}

async function seedTestUser(user) {
  const passwordHash = await bcrypt.hash('test-password', 4);
  await client.hSet(`user:${user.userId}`, {
    username: user.username,
    passwordHash,
    role: user.role,
    email: `${user.username}@example.invalid`,
  });
  await client.set(`username:${user.username}`, user.userId);
}

async function login(user, password = 'test-password') {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ username: user.username, password }),
  });
  return {
    response,
    cookie: response.headers.get('set-cookie')?.split(';', 1)[0],
  };
}

async function removeTestData(userId, sessionIds = []) {
  const keys = [
    `user:sessions:${userId}`,
    `user:sessions:order:${userId}`,
    `audit:auth:user:${userId}`,
    `login:count:${userId}`,
    `user:${userId}`,
    `username:${userId}`,
    `auth:fail:events:${userId}`,
    `auth:lock:${userId}`,
    ...sessionIds.map((id) => `session:${id}`),
  ];
  await client.del(keys);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('AC-01: keeps exactly three active sessions after three logins', {
  skip: !testRedisUrl,
}, async () => {
  const user = testUser();
  const ids = [];
  try {
    await seedTestUser(user);
    for (let i = 0; i < 3; i += 1) {
      const result = await login(user);
      assert.equal(result.response.status, 200);
      ids.push(result.cookie.split('=', 2)[1]);
      await wait(3);
    }

    const setIds = await client.sMembers(`user:sessions:${user.userId}`);
    const orderedIds = await client.zRange(`user:sessions:order:${user.userId}`, 0, -1);
    assert.equal(setIds.length, 3);
    assert.equal(orderedIds.length, 3);
    assert.deepEqual(new Set(setIds), new Set(ids));
    assert.deepEqual(orderedIds, ids);
    for (const id of ids) {
      assert.equal(await client.exists(`session:${id}`), 1);
      const ttl = await client.ttl(`session:${id}`);
      assert.ok(ttl > 0 && ttl <= sessions.SESSION_TTL, `unexpected TTL ${ttl}`);
    }
    assert.equal(await sessions.getLoginCount(user.userId), 3);
  } finally {
    await removeTestData(user.userId, ids);
  }
});

test('AC-02: evicts the oldest session before creating the fourth', {
  skip: !testRedisUrl,
}, async () => {
  const user = testUser();
  const ids = [];
  let oldestCookie;
  try {
    await seedTestUser(user);
    for (let i = 0; i < 4; i += 1) {
      const result = await login(user);
      assert.equal(result.response.status, 200);
      if (i === 0) oldestCookie = result.cookie;
      ids.push(result.cookie.split('=', 2)[1]);
      await wait(5);
    }

    assert.equal(await client.exists(`session:${ids[0]}`), 0);
    for (const id of ids.slice(1)) assert.equal(await client.exists(`session:${id}`), 1);
    assert.equal(await client.sIsMember(`user:sessions:${user.userId}`, ids[0]), false);
    assert.equal(await client.zScore(`user:sessions:order:${user.userId}`, ids[0]), null);
    const revokedRequest = await fetch(`${baseUrl}/api/me`, {
      headers: { Cookie: oldestCookie },
    });
    assert.equal(revokedRequest.status, 401);
    assert.deepEqual(
      await client.zRange(`user:sessions:order:${user.userId}`, 0, -1),
      ids.slice(1)
    );
    assert.equal(await sessions.getLoginCount(user.userId), 4);
  } finally {
    await removeTestData(user.userId, ids);
  }
});

test('AC-15: concurrent logins never leave more than three active sessions', {
  skip: !testRedisUrl,
}, async () => {
  const user = testUser();
  let ids = [];
  try {
    await seedTestUser(user);
    const results = await Promise.all(Array.from({ length: 10 }, () => login(user)));
    for (const result of results) assert.equal(result.response.status, 200);
    ids = results.map((result) => result.cookie.split('=', 2)[1]);

    const setIds = await client.sMembers(`user:sessions:${user.userId}`);
    const orderedIds = await client.zRange(`user:sessions:order:${user.userId}`, 0, -1);
    assert.equal(setIds.length, 3);
    assert.equal(orderedIds.length, 3);
    assert.deepEqual(new Set(setIds), new Set(orderedIds));
    for (const id of setIds) {
      const session = await client.hGetAll(`session:${id}`);
      assert.equal(session.userId, user.userId);
    }
    assert.equal(await sessions.getLoginCount(user.userId), 10);
  } finally {
    await removeTestData(user.userId, ids);
  }
});

test('AC-16: migrates legacy indexes and removes expired references from both indexes', {
  skip: !testRedisUrl,
}, async () => {
  const user = testUser();
  const legacyId = randomUUID();
  const expiredId = randomUUID();
  const createdIds = [];
  try {
    await client.hSet(`session:${legacyId}`, {
      userId: user.userId,
      username: user.username,
      role: user.role,
      device: 'legacy-device',
      ip: '127.0.0.1',
      loginTime: '2020-01-01T00:00:00.000Z',
    });
    await client.expire(`session:${legacyId}`, sessions.SESSION_TTL);
    await client.sAdd(`user:sessions:${user.userId}`, legacyId);
    await client.sAdd(`user:sessions:${user.userId}`, expiredId);
    await client.zAdd(`user:sessions:order:${user.userId}`, { score: 1, value: expiredId });

    createdIds.push(await sessions.createSession(user, 'new-device', '127.0.0.1'));
    assert.equal(await client.sIsMember(`user:sessions:${user.userId}`, expiredId), false);
    assert.equal(await client.zScore(`user:sessions:order:${user.userId}`, expiredId), null);
    const orderAfterMigration = await client.zRange(`user:sessions:order:${user.userId}`, 0, -1);
    assert.ok(orderAfterMigration.includes(legacyId));
    assert.equal(orderAfterMigration[0], legacyId);

    await client.expire(`session:${legacyId}`, 1);
    await wait(1200);
    await sessions.listUserSessions(user.userId);
    assert.equal(await client.sIsMember(`user:sessions:${user.userId}`, legacyId), false);
    assert.equal(await client.zScore(`user:sessions:order:${user.userId}`, legacyId), null);
  } finally {
    await removeTestData(user.userId, [...createdIds, legacyId, expiredId]);
  }
});

test('session deletion removes the hash and both index entries', {
  skip: !testRedisUrl,
}, async () => {
  const user = testUser();
  const ids = [];
  try {
    ids.push(await sessions.createSession(user, 'logout-device', '127.0.0.1'));
    await sessions.deleteSession(ids[0], user.userId);
    assert.equal(await client.exists(`session:${ids[0]}`), 0);
    assert.equal(await client.sIsMember(`user:sessions:${user.userId}`, ids[0]), false);
    assert.equal(await client.zScore(`user:sessions:order:${user.userId}`, ids[0]), null);
  } finally {
    await removeTestData(user.userId, ids);
  }
});

test('sliding TTL refresh does not change the creation order', {
  skip: !testRedisUrl,
}, async () => {
  const user = testUser();
  const ids = [];
  try {
    ids.push(await sessions.createSession(user, 'older', '127.0.0.1'));
    await wait(5);
    ids.push(await sessions.createSession(user, 'newer', '127.0.0.1'));
    const orderBefore = await client.zRange(`user:sessions:order:${user.userId}`, 0, -1);

    await client.expire(`session:${ids[0]}`, 10);
    await sessions.refreshSession(ids[0]);
    const orderAfter = await client.zRange(`user:sessions:order:${user.userId}`, 0, -1);

    assert.deepEqual(orderAfter, orderBefore);
    assert.ok((await client.ttl(`session:${ids[0]}`)) > 10);
  } finally {
    await removeTestData(user.userId, ids);
  }
});

test('session ordering is isolated by user account', {
  skip: !testRedisUrl,
}, async () => {
  const userA = testUser();
  const userB = testUser();
  const idsA = [];
  const idsB = [];
  try {
    for (let i = 0; i < 4; i += 1) {
      idsA.push(await sessions.createSession(userA, `a-${i}`, '127.0.0.1'));
      await wait(3);
    }
    idsB.push(await sessions.createSession(userB, 'b-0', '127.0.0.1'));

    assert.equal(await client.exists(`session:${idsA[0]}`), 0);
    assert.equal(await client.exists(`session:${idsB[0]}`), 1);
    assert.deepEqual(await client.zRange(`user:sessions:order:${userB.userId}`, 0, -1), idsB);
  } finally {
    await removeTestData(userA.userId, idsA);
    await removeTestData(userB.userId, idsB);
  }
});

test('TC-01: first wrong password records one failure without creating a session', {
  skip: !testRedisUrl,
}, async () => {
  const user = testUser();
  try {
    await seedTestUser(user);
    const result = await login(user, 'wrong-password');
    assert.equal(result.response.status, 401);
    assert.equal(await client.zCard(`auth:fail:events:${user.username}`), 1);
    assert.equal(await client.exists(`auth:lock:${user.username}`), 0);
    assert.equal(await client.sCard(`user:sessions:${user.userId}`), 0);
    assert.equal(await sessions.getLoginCount(user.userId), 0);
  } finally {
    await removeTestData(user.userId);
  }
});

test('TC-02: four wrong passwords do not lock the account', {
  skip: !testRedisUrl,
}, async () => {
  const user = testUser();
  try {
    await seedTestUser(user);
    for (let i = 0; i < 4; i += 1) {
      assert.equal((await login(user, 'wrong-password')).response.status, 401);
    }
    assert.equal(await client.zCard(`auth:fail:events:${user.username}`), 4);
    assert.equal(await client.exists(`auth:lock:${user.username}`), 0);
  } finally {
    await removeTestData(user.userId);
  }
});

test('TC-03: the fifth wrong password creates a 15-minute lock without a session', {
  skip: !testRedisUrl,
}, async () => {
  const user = testUser();
  try {
    await seedTestUser(user);
    let result;
    for (let i = 0; i < 5; i += 1) result = await login(user, 'wrong-password');
    assert.equal(result.response.status, 429);
    assert.equal(result.response.headers.get('retry-after'), String(sessions.LOGIN_LOCK_SECONDS));
    const body = await result.response.json();
    assert.equal(body.retryAfterSeconds, sessions.LOGIN_LOCK_SECONDS);
    assert.equal(await client.get(`auth:lock:${user.username}`), '1');
    const lockTtl = await client.ttl(`auth:lock:${user.username}`);
    assert.ok(lockTtl > 0 && lockTtl <= sessions.LOGIN_LOCK_SECONDS);
    assert.equal(await client.exists(`auth:fail:events:${user.username}`), 0);
    assert.equal(await client.sCard(`user:sessions:${user.userId}`), 0);
    assert.equal(await sessions.getLoginCount(user.userId), 0);
  } finally {
    await removeTestData(user.userId);
  }
});

test('TC-04: correct credentials remain blocked and attempts do not extend lock TTL', {
  skip: !testRedisUrl,
}, async () => {
  const user = testUser();
  try {
    await seedTestUser(user);
    for (let i = 0; i < 5; i += 1) await login(user, 'wrong-password');
    const ttlBefore = await client.pTTL(`auth:lock:${user.username}`);
    const result = await login(user);
    const ttlAfter = await client.pTTL(`auth:lock:${user.username}`);
    assert.equal(result.response.status, 429);
    assert.ok(ttlAfter > 0 && ttlAfter <= ttlBefore);
    assert.equal(await client.sCard(`user:sessions:${user.userId}`), 0);
    assert.equal(await sessions.getLoginCount(user.userId), 0);
  } finally {
    await removeTestData(user.userId);
  }
});

test('TC-05: after lock expiry a new failure starts a fresh streak and correct login works', {
  skip: !testRedisUrl,
}, async () => {
  const user = testUser();
  const ids = [];
  try {
    await seedTestUser(user);
    for (let i = 0; i < 5; i += 1) await login(user, 'wrong-password');
    await wait((sessions.LOGIN_LOCK_SECONDS + 0.3) * 1000);
    assert.equal(await client.exists(`auth:lock:${user.username}`), 0);
    assert.equal((await login(user, 'wrong-password')).response.status, 401);
    assert.equal(await client.zCard(`auth:fail:events:${user.username}`), 1);
    const success = await login(user);
    assert.equal(success.response.status, 200);
    ids.push(success.cookie.split('=', 2)[1]);
    assert.equal(await client.exists(`auth:fail:events:${user.username}`), 0);
  } finally {
    await removeTestData(user.userId, ids);
  }
});

test('TC-06: a successful login clears the current failure streak', {
  skip: !testRedisUrl,
}, async () => {
  const user = testUser();
  const ids = [];
  try {
    await seedTestUser(user);
    for (let i = 0; i < 4; i += 1) await login(user, 'wrong-password');
    const success = await login(user);
    assert.equal(success.response.status, 200);
    ids.push(success.cookie.split('=', 2)[1]);
    assert.equal(await client.exists(`auth:fail:events:${user.username}`), 0);
    assert.equal((await login(user, 'wrong-password')).response.status, 401);
    assert.equal(await client.zCard(`auth:fail:events:${user.username}`), 1);
    assert.equal(await client.exists(`auth:lock:${user.username}`), 0);
  } finally {
    await removeTestData(user.userId, ids);
  }
});

test('TC-07: failures older than the sliding window are excluded', {
  skip: !testRedisUrl,
}, async () => {
  const user = testUser();
  try {
    await seedTestUser(user);
    assert.equal((await login(user, 'wrong-password')).response.status, 401);
    await wait(2100);
    assert.equal((await login(user, 'wrong-password')).response.status, 401);
    await wait(1100);
    assert.equal((await login(user, 'wrong-password')).response.status, 401);
    assert.equal(await client.zCard(`auth:fail:events:${user.username}`), 2);
    for (let i = 0; i < 3; i += 1) await login(user, 'wrong-password');
    assert.equal(await client.exists(`auth:lock:${user.username}`), 1);
  } finally {
    await removeTestData(user.userId);
  }
});

test('TC-08: one account lock does not affect another account', {
  skip: !testRedisUrl,
}, async () => {
  const user = testUser();
  const other = testUser();
  const ids = [];
  try {
    await seedTestUser(user);
    await seedTestUser(other);
    for (let i = 0; i < 5; i += 1) await login(user, 'wrong-password');
    assert.equal(await client.exists(`auth:lock:${user.username}`), 1);
    const result = await login(other);
    assert.equal(result.response.status, 200);
    ids.push(result.cookie.split('=', 2)[1]);
    assert.equal(await client.exists(`auth:lock:${other.username}`), 0);
  } finally {
    await removeTestData(user.userId);
    await removeTestData(other.userId, ids);
  }
});

test('TC-09: simultaneous wrong logins are counted atomically and lock once', {
  skip: !testRedisUrl,
}, async () => {
  const user = testUser();
  try {
    await seedTestUser(user);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => login(user, 'wrong-password'))
    );
    const statuses = await Promise.all(results.map((result) => result.response.status));
    assert.ok(statuses.includes(429));
    assert.equal(await client.exists(`auth:lock:${user.username}`), 1);
    assert.equal(await client.exists(`auth:fail:events:${user.username}`), 0);
    assert.equal(await client.sCard(`user:sessions:${user.userId}`), 0);
    assert.equal(await sessions.getLoginCount(user.userId), 0);
  } finally {
    await removeTestData(user.userId);
  }
});

test('TC-10: session creation is atomically rejected if a lock wins the race', {
  skip: !testRedisUrl,
}, async () => {
  const user = testUser();
  const originalCompare = bcrypt.compare;
  let releaseCorrect;
  let signalCorrect;
  const correctReady = new Promise((resolve) => { signalCorrect = resolve; });
  const correctGate = new Promise((resolve) => { releaseCorrect = resolve; });
  try {
    await seedTestUser(user);
    bcrypt.compare = async (password, passwordHash) => {
      const matches = await originalCompare(password, passwordHash);
      if (password === 'test-password' && matches) {
        signalCorrect();
        await correctGate;
      }
      return matches;
    };

    const correctRequest = login(user);
    await correctReady;
    const wrongRequests = await Promise.all(
      Array.from({ length: 5 }, () => login(user, 'wrong-password'))
    );
    assert.ok(wrongRequests.some((result) => result.response.status === 429));
    releaseCorrect();
    assert.equal((await correctRequest).response.status, 429);
    assert.equal(await client.sCard(`user:sessions:${user.userId}`), 0);
    assert.equal(await sessions.getLoginCount(user.userId), 0);
  } finally {
    if (releaseCorrect) releaseCorrect();
    bcrypt.compare = originalCompare;
    await removeTestData(user.userId);
  }
});

test('TC-11: unknown usernames receive the same auth error and are rate limited', {
  skip: !testRedisUrl,
}, async () => {
  const unknown = testUser();
  try {
    const messages = [];
    for (let i = 0; i < 4; i += 1) {
      const result = await login(unknown, 'wrong-password');
      assert.equal(result.response.status, 401);
      messages.push((await result.response.json()).message);
    }
    const last = await login(unknown, 'wrong-password');
    assert.equal(last.response.status, 429);
    assert.equal(await client.exists(`user:${unknown.userId}`), 0);
    assert.equal(await client.zCard(`auth:fail:events:${unknown.username}`), 0);
    assert.equal(await client.exists(`auth:lock:${unknown.username}`), 1);
    assert.ok(messages.every((message) => message === messages[0]));
  } finally {
    await removeTestData(unknown.userId);
  }
});

test('TC-12: locking does not revoke or refresh an existing session', {
  skip: !testRedisUrl,
}, async () => {
  const user = testUser();
  const ids = [];
  try {
    await seedTestUser(user);
    const success = await login(user);
    assert.equal(success.response.status, 200);
    ids.push(success.cookie.split('=', 2)[1]);
    const key = `session:${ids[0]}`;
    const ttlBefore = await client.ttl(key);
    for (let i = 0; i < 5; i += 1) await login(user, 'wrong-password');
    const ttlAfter = await client.ttl(key);
    assert.equal(await client.exists(key), 1);
    assert.ok(ttlAfter > 0 && ttlAfter <= ttlBefore);
    assert.ok(ttlBefore - ttlAfter <= 5);
  } finally {
    await removeTestData(user.userId, ids);
  }
});
