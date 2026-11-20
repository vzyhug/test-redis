const { client } = require('./redisClient');
const { listUserSessions } = require('./sessionService');
const crypto = require('node:crypto');

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

function accountError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function validateAccount(input, { creating = false } = {}) {
  const username = typeof input.username === 'string' ? input.username.trim() : '';
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  const role = typeof input.role === 'string' ? input.role.toUpperCase() : '';
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
    throw accountError('Username phải dài 3–32 ký tự và chỉ gồm chữ, số, dấu ., _ hoặc -');
  }
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw accountError('Email không hợp lệ');
  }
  if (!['USER', 'ADMIN'].includes(role)) throw accountError('Vai trò phải là USER hoặc ADMIN');
  if (creating && (typeof input.password !== 'string' || input.password.length < 8 || Buffer.byteLength(input.password, 'utf8') > 72)) {
    throw accountError('Mật khẩu phải có từ 8 đến 128 ký tự');
  }
  if (!creating && input.password !== undefined && input.password !== ''
    && (typeof input.password !== 'string' || input.password.length < 8 || Buffer.byteLength(input.password, 'utf8') > 72)) {
    throw accountError('Mật khẩu mới phải có từ 8 đến 128 ký tự');
  }
  return { username, email, role };
}

async function createUser(input, passwordHash) {
  const { username, email, role } = validateAccount(input, { creating: true });
  const userId = crypto.randomUUID();
  const result = await client.eval(`
    local userType = redis.call('TYPE', KEYS[1]).ok
    local mapType = redis.call('TYPE', KEYS[2]).ok
    if userType ~= 'none' then return { 'USER_EXISTS' } end
    if mapType ~= 'none' then return { 'USERNAME_EXISTS' } end
    redis.call('HSET', KEYS[1], 'username', ARGV[1], 'email', ARGV[2], 'role', ARGV[3],
      'passwordHash', ARGV[4], 'createdAt', ARGV[5])
    redis.call('SET', KEYS[2], ARGV[6])
    return { 'OK' }
  `, { keys: [`user:${userId}`, `username:${username}`], arguments: [username, email, role, passwordHash, new Date().toISOString(), userId] });
  if (result[0] === 'USERNAME_EXISTS') throw accountError('Username đã tồn tại', 409);
  if (result[0] !== 'OK') throw accountError('Không thể tạo tài khoản', 409);
  return { userId, username, email, role };
}

async function updateUser(userId, input, passwordHash) {
  const current = await getUser(userId);
  if (!current) throw accountError('Không tìm thấy tài khoản', 404);
  const { username, email, role } = validateAccount(input);
  const args = [current.username, username, email, role, userId, passwordHash || ''];
  const result = await client.eval(`
    local userType = redis.call('TYPE', KEYS[1]).ok
    local oldType = redis.call('TYPE', KEYS[2]).ok
    local newType = redis.call('TYPE', KEYS[3]).ok
    if userType ~= 'hash' then return { 'NOT_FOUND' } end
    if redis.call('HGET', KEYS[1], 'username') ~= ARGV[1] then return { 'CONFLICT' } end
    if oldType ~= 'none' and oldType ~= 'string' then return { 'BAD_TYPE' } end
    if newType ~= 'none' and newType ~= 'string' then return { 'BAD_TYPE' } end
    local owner = redis.call('GET', KEYS[3])
    if owner and owner ~= ARGV[5] then return { 'USERNAME_EXISTS' } end
    if KEYS[2] ~= KEYS[3] and redis.call('GET', KEYS[2]) == ARGV[5] then redis.call('DEL', KEYS[2]) end
    redis.call('SET', KEYS[3], ARGV[5])
    redis.call('HSET', KEYS[1], 'username', ARGV[2], 'email', ARGV[3], 'role', ARGV[4])
    if ARGV[6] ~= '' then redis.call('HSET', KEYS[1], 'passwordHash', ARGV[6]) end
    return { 'OK' }
  `, { keys: [`user:${userId}`, `username:${current.username}`, `username:${username}`], arguments: args });
  if (result[0] === 'USERNAME_EXISTS') throw accountError('Username đã tồn tại', 409);
  if (result[0] === 'NOT_FOUND') throw accountError('Không tìm thấy tài khoản', 404);
  if (result[0] === 'CONFLICT') throw accountError('Tài khoản vừa được cập nhật; hãy tải lại trang', 409);
  if (result[0] !== 'OK') throw accountError('Dữ liệu Redis của tài khoản không hợp lệ', 409);
  return { userId, username, email, role };
}

async function deleteUser(userId) {
  const user = await getUser(userId);
  if (!user) throw accountError('Không tìm thấy tài khoản', 404);
  const result = await client.eval(`
    local userType = redis.call('TYPE', KEYS[1]).ok
    local mapType = redis.call('TYPE', KEYS[2]).ok
    local sessionsType = redis.call('TYPE', KEYS[3]).ok
    local orderType = redis.call('TYPE', KEYS[4]).ok
    if userType ~= 'hash' then return 0 end
    if mapType ~= 'none' and mapType ~= 'string' then return redis.error_reply('invalid username mapping type') end
    if sessionsType ~= 'none' and sessionsType ~= 'set' then return redis.error_reply('invalid session index type') end
    if orderType ~= 'none' and orderType ~= 'zset' then return redis.error_reply('invalid session order type') end
    if redis.call('HGET', KEYS[1], 'username') ~= ARGV[2] then return -1 end
    local ids = redis.call('SMEMBERS', KEYS[3])
    for _, id in ipairs(ids) do redis.call('DEL', 'session:' .. id) end
    redis.call('DEL', KEYS[3], KEYS[4])
    if redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('DEL', KEYS[2]) end
    redis.call('DEL', KEYS[1], 'login:count:' .. ARGV[1], 'auth:lock:' .. ARGV[2], 'auth:fail:events:' .. ARGV[2])
    return #ids
  `, { keys: [`user:${userId}`, `username:${user.username}`, `user:sessions:${userId}`, `user:sessions:order:${userId}`], arguments: [userId, user.username] });
  if (Number(result) === -1) throw accountError('Tài khoản vừa được cập nhật; hãy tải lại trang', 409);
  return { ...user, deletedSessionCount: Number(result) || 0 };
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

async function countAdmins() {
  return (await scanUsers()).filter((user) => user.role === 'ADMIN').length;
}

module.exports = { getUser, listUsers, getUserSessions, getOverview, countAdmins, createUser, updateUser, deleteUser };
