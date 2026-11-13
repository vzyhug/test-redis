const { client } = require('./redisClient');
const { listUserSessions } = require('./sessionService');

const USER_KEY_PATTERN = /^user:(?!sessions(?::|$))([^:]+)$/;

async function getUser(userId) {
  if (typeof userId !== 'string' || !userId || userId.length > 128 || /[\u0000-\u001f\u007f]/.test(userId)) {
    return null;
  }
  const key = `user:${userId}`;
  if (await client.type(key) !== 'hash') return null;
  const data = await client.hGetAll(key);
  if (!data.username || !data.role) return null;
  return {
    userId,
    username: data.username,
    email: data.email || '',
    role: data.role,
  };
}

async function scanUsers() {
  const users = [];
  let cursor = '0';
  do {
    const result = await client.scan(cursor, { MATCH: 'user:*', COUNT: 100 });
    cursor = String(result.cursor);
    for (const key of result.keys) {
      const match = USER_KEY_PATTERN.exec(key);
      if (!match || await client.type(key) !== 'hash') continue;
      const data = await client.hGetAll(key);
      if (!data.username || !data.role) continue;
      users.push({
        userId: match[1],
        username: data.username,
        email: data.email || '',
        role: data.role,
      });
    }
  } while (cursor !== '0');
  users.sort((a, b) => a.username.localeCompare(b.username) || a.userId.localeCompare(b.userId));
  return users;
}

async function listUsers({ offset = 0, limit = 25, search = '' } = {}) {
  const users = await scanUsers();
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const filtered = normalizedSearch
    ? users.filter((user) => user.username.toLocaleLowerCase().includes(normalizedSearch)
      || user.userId.toLocaleLowerCase().includes(normalizedSearch))
    : users;
  const page = filtered.slice(offset, offset + limit);
  const result = await Promise.all(page.map(async (user) => ({
    ...user,
    activeSessionCount: (await listUserSessions(user.userId)).length,
  })));
  return {
    users: result,
    total: filtered.length,
    nextOffset: offset + result.length < filtered.length ? offset + result.length : null,
  };
}

async function getUserSessions(userId, currentSessionId) {
  const user = await getUser(userId);
  if (!user) return null;
  const sessions = await listUserSessions(userId);
  return {
    user,
    sessions: sessions.map((session) => ({
      managementId: session.managementId,
      device: session.device || 'unknown',
      ip: session.ip || 'unknown',
      loginTime: session.loginTime || null,
      ttl: session.ttl,
      status: 'ACTIVE',
      current: session.sessionId === currentSessionId,
    })),
  };
}

async function getOverview() {
  const users = await scanUsers();
  const overview = {
    totalUsers: users.length,
    activeAccounts: 0,
    totalActiveSessions: 0,
    activeSessionsByRole: { USER: 0, ADMIN: 0 },
  };
  for (const user of users) {
    const sessions = await listUserSessions(user.userId);
    if (sessions.length) overview.activeAccounts += 1;
    overview.totalActiveSessions += sessions.length;
    if (user.role === 'USER' || user.role === 'ADMIN') {
      overview.activeSessionsByRole[user.role] += sessions.length;
    }
  }
  return overview;
}

module.exports = { getUser, listUsers, getUserSessions, getOverview };
