// ============================================================
// sessionService.js - Toàn bộ logic Redis Session tự viết tay
// (Không dùng connect-redis để thấy rõ lệnh trong Profiler)
//
// Quy ước key:
//   user:<userId>             HASH   thông tin user
//   username:<username>       STRING map username -> userId
//   session:<sessionId>       HASH   dữ liệu phiên (có TTL)
//   user:sessions:<userId>    SET    danh sách sessionId của user
//   login:count:<userId>      STRING bộ đếm đăng nhập
// ============================================================
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { client } = require('./redisClient');
const auditService = require('./auditService');

const SESSION_TTL = 1800; // 30 phút
const MAX_SESSIONS = 3;
const SESSION_REF_KEY = process.env.FIRESTORE_SESSION_REF_KEY || crypto.randomBytes(32);
const LOGIN_FAILURE_WINDOW_SECONDS = positiveIntegerEnv('AUTH_FAILURE_WINDOW_SECONDS', 900);
const LOGIN_LOCK_SECONDS = positiveIntegerEnv('AUTH_LOCK_SECONDS', 900);
const LOGIN_FAILURE_THRESHOLD = 5;
const AUDIT_LUA_HELPERS = fs.readFileSync(path.join(__dirname, 'lua', 'auditHelpers.lua'), 'utf8');
function loadLuaScript(name) {
  return fs.readFileSync(path.join(__dirname, 'lua', name), 'utf8')
    .replace('-- AUDIT_HELPERS', AUDIT_LUA_HELPERS);
}
const CREATE_SESSION_SCRIPT = loadLuaScript('createSessionLimited.lua');
const RECORD_LOGIN_FAILURE_SCRIPT = loadLuaScript('recordLoginFailure.lua');
const ENSURE_MANAGEMENT_ID_SCRIPT = fs.readFileSync(path.join(__dirname, 'lua', 'ensureManagementId.lua'), 'utf8');
const REVOKE_SESSION_SCRIPT = loadLuaScript('revokeSession.lua');
const REVOKE_ALL_SESSIONS_SCRIPT = loadLuaScript('revokeAllSessions.lua');
const DELETE_SESSION_AUDIT_SCRIPT = loadLuaScript('deleteSession.lua');
const DELETE_SESSION_SCRIPT = `
  local function keyType(key)
    return redis.call('TYPE', key).ok
  end
  local expected = { 'hash', 'set', 'zset' }
  for index, key in ipairs(KEYS) do
    local actual = keyType(key)
    if actual ~= 'none' and actual ~= expected[index] then
      return redis.error_reply('wrong type for session deletion key')
    end
  end
  redis.call('DEL', KEYS[1])
  redis.call('SREM', KEYS[2], ARGV[1])
  redis.call('ZREM', KEYS[3], ARGV[1])
  return 1
`;

const sessionKey = (sessionId) => `session:${sessionId}`;
const userSessionsKey = (userId) => `user:sessions:${userId}`;
const userSessionsOrderKey = (userId) => `user:sessions:order:${userId}`;
const normalizeUsername = (username) => String(username).trim();
const loginFailureEventsKey = (username) => `auth:fail:events:${normalizeUsername(username)}`;
const loginLockKey = (username) => `auth:lock:${normalizeUsername(username)}`;

function positiveIntegerEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

async function getLoginLockStatus(username) {
  const ttlMs = await client.pTTL(loginLockKey(username));
  if (ttlMs === -2) return { locked: false, retryAfterSeconds: 0 };
  return {
    locked: true,
    retryAfterSeconds: ttlMs > 0 ? Math.ceil(ttlMs / 1000) : LOGIN_LOCK_SECONDS,
  };
}

async function recordLoginFailure(username, context = {}) {
  const userId = context.userId ? String(context.userId) : '';
  const result = await client.eval(RECORD_LOGIN_FAILURE_SCRIPT, {
    keys: [
      loginFailureEventsKey(username), loginLockKey(username), auditService.globalStreamKey(),
      userId ? auditService.userStreamKey(userId) : 'audit:auth:user:_no_account_',
    ],
    arguments: [
      crypto.randomUUID(),
      String(LOGIN_FAILURE_WINDOW_SECONDS),
      String(LOGIN_LOCK_SECONDS),
      String(LOGIN_FAILURE_THRESHOLD),
      String(auditService.RETENTION_SECONDS),
      userId,
      String(context.username || normalizeUsername(username)).slice(0, 64),
      String(context.role || (userId ? 'USER' : 'ANONYMOUS')).slice(0, 16),
      String(context.device || '').slice(0, 256),
      String(context.ip || '').slice(0, 64),
      crypto.randomUUID(),
      crypto.randomUUID(),
      userId ? '1' : '0',
    ],
  });

  const auditRecorded = result[3] !== '0';
  if (!auditRecorded) console.error('[audit] Login failure/lock event could not be fully recorded.');

  return {
    locked: result[0] === 'LOCKED',
    retryAfterSeconds: Number(result[1]) || 0,
    failureCount: Number(result[2]) || 0,
    auditRecorded,
    newlyLocked: result[4] === '1',
  };
}

// Tạo session mới khi login thành công
async function createSession(user, device, ip, authUsername = user.username, options = {}) {
  // Lua script kiểm tra giới hạn, thu hồi session cũ nhất và ghi toàn bộ key nguyên tử.
  const sessionId = crypto.randomUUID();
  const sessionRef = crypto.createHmac('sha256', SESSION_REF_KEY).update(sessionId).digest('hex');
  let managementId = crypto.randomUUID();
  while (managementId === sessionId) managementId = crypto.randomUUID();
  const createdAtMs = Date.now();
  const loginTime = new Date(createdAtMs).toISOString();

  const result = await client.eval(CREATE_SESSION_SCRIPT, {
    keys: [
      userSessionsKey(user.userId),
      userSessionsOrderKey(user.userId),
      `login:count:${user.userId}`,
      sessionKey(sessionId),
      loginLockKey(authUsername),
      loginFailureEventsKey(authUsername),
      auditService.globalStreamKey(),
      auditService.userStreamKey(user.userId),
    ],
    arguments: [
      String(user.userId),
      sessionId,
      user.username || '',
      user.role || '',
      device || 'unknown',
      ip || 'unknown',
      loginTime,
      String(createdAtMs),
      String(SESSION_TTL),
      String(MAX_SESSIONS),
      managementId,
      crypto.randomUUID(),
      crypto.randomUUID(),
      String(auditService.RETENTION_SECONDS),
      String(device || 'unknown').slice(0, 256),
      String(ip || 'unknown').slice(0, 64),
      sessionRef,
    ],
  });

  if (result[0] === 'LOCKED') {
    const error = new Error('Login temporarily locked');
    error.code = 'LOGIN_LOCKED';
    error.retryAfterSeconds = Number(result[1]) || LOGIN_LOCK_SECONDS;
    throw error;
  }

  const auditRecorded = result[2] !== '0';
  if (!auditRecorded) console.error('[audit] Login/session-eviction event could not be fully recorded.');
  return options.returnAuditStatus ? { sessionId, managementId, auditRecorded } : sessionId;
}

// Lấy session (trả null nếu không tồn tại / đã hết hạn)
async function getSession(sessionId) {
  const key = sessionKey(sessionId);

  // EXISTS session:<uuid>
  const exists = await client.exists(key);
  if (!exists) return null;

  // HGETALL session:<uuid>
  const data = await client.hGetAll(key);
  if (!data || !data.userId) return null; // hết hạn đúng lúc giữa 2 lệnh
  data.managementId = await ensureManagementId(sessionId, data.userId);
  if (!data.managementId) return null;
  return data;
}

async function ensureManagementId(sessionId, userId) {
  let managementId = crypto.randomUUID();
  while (managementId === sessionId) managementId = crypto.randomUUID();
  return client.eval(ENSURE_MANAGEMENT_ID_SCRIPT, {
    keys: [sessionKey(sessionId)],
    arguments: [String(userId), managementId],
  });
}

// Gia hạn TTL (sliding session)
async function refreshSession(sessionId) {
  await client.expire(sessionKey(sessionId), SESSION_TTL);
}

// Xóa session khi logout
async function deleteSession(sessionId, userId, auditContext = null) {
  if (userId) {
    if (auditContext) {
      const result = await client.eval(DELETE_SESSION_AUDIT_SCRIPT, {
        keys: [
          sessionKey(sessionId), userSessionsKey(userId), userSessionsOrderKey(userId),
          auditService.globalStreamKey(), auditService.userStreamKey(userId),
        ],
        arguments: [
          sessionId, String(userId), String(auditContext.eventId || crypto.randomUUID()),
          String(auditContext.eventType || 'LOGOUT'), String(auditContext.actorUserId || userId),
          String(auditContext.actorRole || 'USER'), String(auditContext.actorUsername || ''),
          String(auditContext.username || ''), String(auditContext.ip || ''),
          String(auditContext.device || ''), String(auditService.RETENTION_SECONDS),
        ],
      });
      const deleted = result[0] === 'DELETED';
      const auditRecorded = result[1] !== '0';
      if (deleted && !auditRecorded) console.error('[audit] Logout event could not be fully recorded.');
      return { deleted, auditRecorded };
    }
    // Lua giữ Hash và hai chỉ mục nhất quán trong cùng thao tác.
    await client.eval(DELETE_SESSION_SCRIPT, {
      keys: [
        sessionKey(sessionId),
        userSessionsKey(userId),
        userSessionsOrderKey(userId),
      ],
      arguments: [sessionId],
    });
    return;
  }

  // Trường hợp session đã hết TTL, userId không còn trong Hash để suy ra chủ sở hữu.
  await client.del(sessionKey(sessionId));
}

// Lấy các session còn hợp lệ của user, dọn các tham chiếu "mồ côi"
async function listUserSessions(userId) {
  // Hợp nhất hai chỉ mục để cũng dọn được tham chiếu chỉ còn trong một chỉ mục.
  const setKey = userSessionsKey(userId);
  const orderKey = userSessionsOrderKey(userId);
  const ids = new Set([
    ...(await client.sMembers(setKey)),
    ...(await client.zRange(orderKey, 0, -1)),
  ]);
  const result = [];

  for (const id of ids) {
    const key = sessionKey(id);
    const exists = await client.exists(key);

    if (exists) {
      const data = await client.hGetAll(key);
      const ttl = await client.ttl(key); // thời gian còn lại (giây)
      if (data && data.userId === String(userId) && ttl !== -2) {
        data.managementId = await ensureManagementId(id, userId);
        if (data.managementId) result.push({ sessionId: id, ...data, ttl });
        else {
          await client.sRem(setKey, id);
          await client.zRem(orderKey, id);
        }
      } else {
        // Loại bỏ tham chiếu hết hạn/hỏng khỏi cả hai chỉ mục.
        await client.sRem(setKey, id);
        await client.zRem(orderKey, id);
      }
    } else {
      // Session đã hết hạn (TTL) nhưng vẫn còn trong chỉ mục -> dọn dẹp.
      await client.sRem(setKey, id);
      await client.zRem(orderKey, id);
    }
  }
  return result;
}

async function revokeSession(userId, managementId, currentSessionId, auditContext = null) {
  const result = await client.eval(REVOKE_SESSION_SCRIPT, {
    keys: [
      userSessionsKey(userId), userSessionsOrderKey(userId), auditService.globalStreamKey(),
      auditService.userStreamKey(userId), auditContext?.actorUserId && auditContext.actorUserId !== String(userId)
        ? auditService.userStreamKey(auditContext.actorUserId) : auditService.userStreamKey(userId),
    ],
    arguments: [
      String(userId), String(managementId), String(currentSessionId),
      String(auditContext?.eventType || ''), String(auditContext?.eventId || ''),
      String(auditContext?.actorUserId || ''), String(auditContext?.actorRole || ''),
      String(auditContext?.actorUsername || ''), String(auditContext?.ip || ''),
      String(auditContext?.device || ''), String(auditService.RETENTION_SECONDS),
      auditContext ? '1' : '0',
    ],
  });
  const status = String(result[0]);
  const auditRecorded = result[1] !== '0';
  if (status === 'REVOKED' && auditContext && !auditRecorded) {
    console.error('[audit] Session revocation event could not be fully recorded.');
  }
  return { status, auditRecorded };
}

async function revokeAllSessions(userId, auditContext = null) {
  const actorId = String(auditContext?.actorUserId || '');
  const result = await client.eval(REVOKE_ALL_SESSIONS_SCRIPT, {
    keys: [
      userSessionsKey(userId), userSessionsOrderKey(userId), auditService.globalStreamKey(),
      auditService.userStreamKey(userId), actorId && actorId !== String(userId)
        ? auditService.userStreamKey(actorId) : auditService.userStreamKey(userId),
    ],
    arguments: [
      String(userId), String(auditContext?.eventType || ''), String(auditContext?.eventId || ''),
      actorId, String(auditContext?.actorRole || ''), String(auditContext?.actorUsername || ''),
      String(auditContext?.ip || ''), String(auditContext?.device || ''),
      String(auditService.RETENTION_SECONDS), auditContext ? '1' : '0',
    ],
  });
  const revokedCount = Number(result[1]) || 0;
  const auditRecorded = result[2] !== '0';
  if (auditContext && !auditRecorded) console.error('[audit] Logout-all event could not be fully recorded.');
  return { revokedCount, auditRecorded };
}

// Đọc bộ đếm đăng nhập
async function getLoginCount(userId) {
  const count = await client.get(`login:count:${userId}`);
  return Number(count) || 0;
}

module.exports = {
  SESSION_TTL,
  MAX_SESSIONS,
  LOGIN_FAILURE_WINDOW_SECONDS,
  LOGIN_LOCK_SECONDS,
  LOGIN_FAILURE_THRESHOLD,
  normalizeUsername,
  getLoginLockStatus,
  recordLoginFailure,
  createSession,
  getSession,
  refreshSession,
  deleteSession,
  listUserSessions,
  revokeSession,
  revokeAllSessions,
  getLoginCount,
};
