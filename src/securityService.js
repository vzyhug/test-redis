const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { client } = require('./redisClient');
const sessions = require('./sessionService');

const DEFAULT_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const RETENTION_SECONDS = positiveIntegerEnv('SECURITY_ALERT_RETENTION_SECONDS', DEFAULT_RETENTION_SECONDS);
const DEDUPE_SECONDS = positiveIntegerEnv('SECURITY_ALERT_DEDUPE_SECONDS', 24 * 60 * 60);
const MAX_KNOWN_MARKERS = positiveIntegerEnv('SECURITY_MAX_KNOWN_MARKERS', 200);
const CLEANUP_INTERVAL_MS = positiveIntegerEnv('SECURITY_CLEANUP_INTERVAL_MS', 15 * 60 * 1000);
const PAGE_LIMIT_MAX = 100;
const MAX_SCAN_PER_REQUEST = 500;
const helpers = fs.readFileSync(path.join(__dirname, 'lua', 'securityHelpers.lua'), 'utf8');
const loadScript = (name) => fs.readFileSync(path.join(__dirname, 'lua', name), 'utf8').replace('-- SECURITY_HELPERS', helpers);
const OBSERVE_SCRIPT = loadScript('observeSecurityLogin.lua');
const LOCKOUT_SCRIPT = loadScript('createSecurityLockoutAlert.lua');

const MUTATE_ALERT_SCRIPT = `
-- SECURITY_HELPERS
local valid, message = validateSecurityKeys({
  {KEYS[1], 'hash'}, {KEYS[2], 'zset'}, {KEYS[3], 'zset'}, {KEYS[4], 'zset'},
  {KEYS[5], 'zset'}, {KEYS[6], 'zset'}, {KEYS[7], 'zset'}, {KEYS[8], 'stream'},
})
if not valid then return redis.error_reply(message) end
local action, actorId, retention = ARGV[1], ARGV[2], tonumber(ARGV[3])
local nowMs = tonumber(ARGV[4])
if not retention or retention < 1 or not nowMs then return redis.error_reply('invalid alert mutation arguments') end
if redis.call('EXISTS', KEYS[1]) == 0 then return {'NOT_FOUND'} end
local alertId = redis.call('HGET', KEYS[1], 'alertId') or ''
local eventValid, eventMessage = validateSecurityKeys({{'security:alert:events:' .. alertId, 'stream'}})
if not eventValid then return redis.error_reply(eventMessage) end
local status = redis.call('HGET', KEYS[1], 'status') or ''
local createdAtMs = tonumber(redis.call('HGET', KEYS[1], 'createdAtMs')) or nowMs
if action == 'READ' then
  local readAt = redis.call('HGET', KEYS[1], 'readAt') or ''
  if readAt ~= '' then return {'ALREADY', readAt} end
  redis.call('HSET', KEYS[1], 'readAt', tostring(nowMs))
  local recorded = appendSecurityEvent(KEYS[8], alertId, 'ALERT_READ', actorId, nowMs, '', retention)
  return {'UPDATED', tostring(nowMs), recorded and '1' or '0'}
end
if action == 'RESOLVE_SAFE' then
  if status == 'PROCESSING' then return {'BUSY'} end
  if status ~= 'OPEN' then return {'ALREADY', status} end
  redis.call('HSET', KEYS[1], 'status', 'RESOLVED_SAFE', 'resolvedAt', tostring(nowMs),
    'resolvedBy', actorId, 'resolution', 'SAFE', 'readAt', redis.call('HGET', KEYS[1], 'readAt') or tostring(nowMs))
  redis.call('ZREM', KEYS[2], alertId); redis.call('ZREM', KEYS[3], alertId)
  redis.call('ZADD', KEYS[6], createdAtMs, alertId); redis.call('ZADD', KEYS[7], createdAtMs, alertId)
  redis.call('EXPIRE', KEYS[6], retention); redis.call('EXPIRE', KEYS[7], retention)
  local recorded = appendSecurityEvent(KEYS[8], alertId, 'ALERT_RESOLVED_SAFE', actorId, nowMs, '', retention)
  return {'UPDATED', 'RESOLVED_SAFE', recorded and '1' or '0'}
end
if action == 'CLAIM_REVOKE' then
  if status == 'PROCESSING' then
    local processingAt = tonumber(redis.call('HGET', KEYS[1], 'processingAt')) or nowMs
    if nowMs - processingAt <= 60000 then return {'BUSY'} end
    redis.call('HSET', KEYS[1], 'status', 'OPEN', 'processingAction', '', 'processingAt', '')
    redis.call('ZADD', KEYS[2], createdAtMs, alertId); redis.call('ZADD', KEYS[3], createdAtMs, alertId)
  elseif status ~= 'OPEN' then
    return {'ALREADY', status}
  end
  redis.call('HSET', KEYS[1], 'status', 'PROCESSING', 'processingAction', 'REVOKE', 'processingAt', tostring(nowMs))
  redis.call('ZREM', KEYS[2], alertId); redis.call('ZREM', KEYS[3], alertId)
  local recorded = appendSecurityEvent(KEYS[8], alertId, 'SESSION_REVOKE_STARTED', actorId, nowMs, '', retention)
  return {'CLAIMED', alertId, recorded and '1' or '0'}
end
if action == 'UNCLAIM_REVOKE' then
  if status ~= 'PROCESSING' or redis.call('HGET', KEYS[1], 'processingAction') ~= 'REVOKE' then return {'CONFLICT', status} end
  redis.call('HSET', KEYS[1], 'status', 'OPEN', 'processingAction', '', 'processingAt', '')
  redis.call('ZADD', KEYS[2], createdAtMs, alertId); redis.call('ZADD', KEYS[3], createdAtMs, alertId)
  local recorded = appendSecurityEvent(KEYS[8], alertId, 'SESSION_REVOKE_FAILED', actorId, nowMs, '', retention)
  return {'UPDATED', recorded and '1' or '0'}
end
if action == 'FINISH_REVOKE' then
  if status ~= 'PROCESSING' or redis.call('HGET', KEYS[1], 'processingAction') ~= 'REVOKE' then return {'CONFLICT', status} end
  redis.call('HSET', KEYS[1], 'status', 'RESOLVED_REVOKED', 'resolvedAt', tostring(nowMs),
    'resolvedBy', actorId, 'resolution', 'SESSION_REVOKED', 'readAt', redis.call('HGET', KEYS[1], 'readAt') or tostring(nowMs),
    'processingAction', '', 'processingAt', '')
  redis.call('ZADD', KEYS[6], createdAtMs, alertId); redis.call('ZADD', KEYS[7], createdAtMs, alertId)
  redis.call('EXPIRE', KEYS[6], retention); redis.call('EXPIRE', KEYS[7], retention)
  local recorded = appendSecurityEvent(KEYS[8], alertId, 'SESSION_REVOKED_FOR_ALERT', actorId, nowMs, '', retention)
  return {'UPDATED', 'RESOLVED_REVOKED', recorded and '1' or '0'}
end
return redis.error_reply('unsupported alert mutation')
`.replace('-- SECURITY_HELPERS', helpers);

let cleanupTimer = null;
let cleanupRunning = false;
let userCleanupCursor = '0';

function positiveIntegerEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
function keyAlert(alertId) { return `security:alert:${alertId}`; }
function userIndex(userId) { return `security:user:alerts:${userId}`; }
function globalIndex() { return 'security:alerts:global'; }
function eventStream() { return 'security:alerts:events'; }
function knownDevices(userId) { return `security:known:devices:${userId}`; }
function knownIps(userId) { return `security:known:ips:${userId}`; }
function baseline(userId) { return `security:baseline:${userId}`; }
function dedupeKey(userId, digest) { return `security:dedupe:${userId}:${digest}`; }
function openIndex(index) { return `${index}:open`; }
function highIndex(index) { return `${index}:high`; }
function resolvedIndex(index) { return `${index}:resolved`; }

function normalizeIp(value) {
  const ip = String(value || 'unknown').trim().toLowerCase().replace(/^::ffff:/, '');
  if (ip === '::1' || ip === 'localhost' || /^127\./.test(ip)) return '127.0.0.1';
  return ip || 'unknown';
}

function normalizeDevice(userAgent) {
  const ua = String(userAgent || '').slice(0, 512);
  let browser = 'Unknown browser';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/OPR\//i.test(ua) || /Opera/i.test(ua)) browser = 'Opera';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Chrome\//i.test(ua) || /CriOS\//i.test(ua)) browser = 'Chrome';
  else if (/Safari\//i.test(ua)) browser = 'Safari';
  let os = 'Unknown OS';
  if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
  else if (/Linux/i.test(ua)) os = 'Linux';
  const category = /iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))
    ? 'Tablet' : /Mobile|iPhone|Android/i.test(ua) ? 'Mobile' : 'Desktop';
  return { signature: `${browser}|${os}|${category}`, label: `${browser} · ${os} · ${category}` };
}

function alertKeys(userId, alertId) {
  const userKey = userIndex(userId);
  const globalKey = globalIndex();
  return {
    alert: keyAlert(alertId), userKey, globalKey,
    userOpen: openIndex(userKey), globalOpen: openIndex(globalKey),
    userHigh: highIndex(userKey), globalHigh: highIndex(globalKey),
    userResolved: resolvedIndex(userKey), globalResolved: resolvedIndex(globalKey),
    events: eventStream(),
  };
}

function securityAlertFromHash(data) {
  if (!data?.alertId) return null;
  const createdAtMs = Number(data.createdAtMs);
  const resolvedAt = Number(data.resolvedAt);
  const readAt = Number(data.readAt);
  return {
    alertId: data.alertId,
    userId: data.userId,
    username: data.username || null,
    alertType: data.alertType,
    severity: data.severity,
    reasons: data.reasons ? data.reasons.split(',').filter(Boolean) : [],
    title: data.title,
    description: data.description,
    status: data.status,
    createdAt: Number.isFinite(createdAtMs) ? new Date(createdAtMs).toISOString() : null,
    createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : null,
    ip: data.ip || null,
    device: data.device || null,
    readAt: Number.isFinite(readAt) && readAt > 0 ? new Date(readAt).toISOString() : null,
    resolvedAt: Number.isFinite(resolvedAt) && resolvedAt > 0 ? new Date(resolvedAt).toISOString() : null,
    resolvedBy: data.resolvedBy || null,
    resolution: data.resolution || null,
    hasRelatedSession: Boolean(data.relatedManagementId),
    role: data.role || null,
    failureCount: data.failureCount ? Number(data.failureCount) : null,
    lockSeconds: data.lockSeconds ? Number(data.lockSeconds) : null,
  };
}

async function observeSuccessfulLogin({ userId, username, userAgent, ip, managementId }) {
  try {
    const device = normalizeDevice(userAgent);
    const normalizedIp = normalizeIp(ip);
    const deviceDigest = crypto.createHash('sha256').update(device.signature).digest('hex');
    const pairDigest = crypto.createHash('sha256').update(`${deviceDigest}|${normalizedIp}`).digest('hex');
    const alertId = crypto.randomUUID();
    const keys = alertKeys(userId, alertId);
    const result = await client.eval(OBSERVE_SCRIPT, {
      keys: [knownDevices(userId), knownIps(userId), baseline(userId), dedupeKey(userId, pairDigest),
        keys.alert, keys.userKey, keys.globalKey, keys.userOpen, keys.globalOpen,
        keys.userHigh, keys.globalHigh, keys.userResolved, keys.globalResolved, keys.events],
      arguments: [String(userId), String(username || '').slice(0, 64), deviceDigest, normalizedIp,
        device.label, String(managementId || ''), pairDigest, alertId, String(RETENTION_SECONDS),
        String(DEDUPE_SECONDS), String(MAX_KNOWN_MARKERS)],
    });
    if (result[0] === 'ALERT_CREATED') {
      const historyRecorded = result[2] === '1';
      if (!historyRecorded) console.error('[security] Login environment alert was saved without a complete event history.');
      return { alertCreated: true, alertId: String(result[1]), historyRecorded };
    }
    return { alertCreated: false, baselineCreated: result[0] === 'BASELINE_CREATED', historyRecorded: true };
  } catch (error) {
    console.error('[security] Could not record successful login environment:', error.message);
    return { alertCreated: false, historyRecorded: false };
  }
}

async function createLockoutAlert({ userId, username, role, ip, userAgent, failureCount, lockSeconds }) {
  try {
    if (!userId) return { alertCreated: false, skipped: true };
    const alertId = crypto.randomUUID();
    const keys = alertKeys(userId, alertId);
    const device = normalizeDevice(userAgent);
    const result = await client.eval(LOCKOUT_SCRIPT, {
      keys: [keys.alert, keys.userKey, keys.globalKey, keys.userOpen, keys.globalOpen,
        keys.userHigh, keys.globalHigh, keys.userResolved, keys.globalResolved, keys.events],
      arguments: [alertId, String(userId), String(username || '').slice(0, 64), String(role || 'USER'),
        normalizeIp(ip), device.label, String(failureCount), String(lockSeconds), String(RETENTION_SECONDS)],
    });
    const historyRecorded = result[1] === '1';
    if (!historyRecorded) console.error('[security] Lockout alert was saved without a complete event history.');
    return { alertCreated: true, alertId: String(result[0]), historyRecorded };
  } catch (error) {
    console.error('[security] Could not create login lockout alert:', error.message);
    return { alertCreated: false, historyRecorded: false };
  }
}

async function readScoreRange(key, max, min, limit) {
  const values = await client.sendCommand(['ZREVRANGEBYSCORE', key, max, min, 'WITHSCORES', 'LIMIT', '0', String(limit)]);
  const rows = [];
  for (let i = 0; i < values.length; i += 2) rows.push({ id: values[i], score: Number(values[i + 1]) });
  return rows;
}

function encodeCursor(row) { return Buffer.from(JSON.stringify(row)).toString('base64url'); }
function decodeCursor(cursor) {
  if (!cursor) return null;
  if (typeof cursor !== 'string' || cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('cursor không hợp lệ');
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Number.isFinite(parsed.score) || typeof parsed.id !== 'string' || !parsed.id) throw new Error();
    return { score: parsed.score, id: parsed.id };
  } catch { throw new Error('cursor không hợp lệ'); }
}

async function candidateBatch(indexKey, cursor, count) {
  if (!cursor) return readScoreRange(indexKey, '+inf', '-inf', count);
  const tied = await readScoreRange(indexKey, String(cursor.score), String(cursor.score), 1000);
  const afterTied = tied.filter((row) => row.id.localeCompare(cursor.id) < 0);
  if (afterTied.length >= count) return afterTied.slice(0, count);
  const older = await readScoreRange(indexKey, `(${cursor.score}`, '-inf', count - afterTied.length);
  return afterTied.concat(older);
}

function validateListQuery(query = {}, admin = false) {
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMIT_MAX) throw new Error(`limit phải từ 1 đến ${PAGE_LIMIT_MAX}`);
  const severity = query.severity || null;
  if (severity && !['LOW', 'MEDIUM', 'HIGH'].includes(severity)) throw new Error('severity không hợp lệ');
  const status = query.status || null;
  if (status && !['OPEN', 'RESOLVED_SAFE', 'RESOLVED_REVOKED'].includes(status)) throw new Error('status không hợp lệ');
  const alertType = query.alertType || null;
  if (alertType && !['NEW_LOGIN_ENVIRONMENT', 'LOGIN_LOCKOUT'].includes(alertType)) throw new Error('alertType không hợp lệ');
  const userId = admin && typeof query.userId === 'string' && query.userId ? query.userId : null;
  if (admin && query.userId !== undefined && (!userId || userId.length > 128 || /[\u0000-\u001f\u007f]/.test(userId))) throw new Error('userId không hợp lệ');
  const search = admin && typeof query.q === 'string' ? query.q.trim().slice(0, 64).toLocaleLowerCase() : '';
  const from = query.from === undefined ? null : Date.parse(String(query.from));
  const to = query.to === undefined ? null : Date.parse(String(query.to));
  if (query.from !== undefined && !Number.isFinite(from)) throw new Error('from không hợp lệ');
  if (query.to !== undefined && !Number.isFinite(to)) throw new Error('to không hợp lệ');
  if (from !== null && to !== null && from > to) throw new Error('from phải nhỏ hơn hoặc bằng to');
  const cursor = decodeCursor(query.cursor || null);
  return { limit, severity, status, alertType, userId, search, from, to, cursor };
}

async function listAlerts(indexKey, query, { admin = false } = {}) {
  const filters = validateListQuery(query, admin);
  const baseIndex = admin ? globalIndex() : indexKey;
  const selectedIndex = filters.status === 'OPEN' ? openIndex(baseIndex)
    : (filters.status === 'RESOLVED_SAFE' || filters.status === 'RESOLVED_REVOKED') ? resolvedIndex(baseIndex)
      : !filters.status && filters.severity === 'HIGH' ? highIndex(baseIndex) : baseIndex;
  const cutoff = Date.now() - RETENTION_SECONDS * 1000;
  let cursor = filters.cursor;
  let scanned = 0;
  let exhausted = false;
  let overflow = null;
  const items = [];
  let lastScanned = null;
  while (scanned < MAX_SCAN_PER_REQUEST && !exhausted && !overflow) {
    const batch = await candidateBatch(selectedIndex, cursor, Math.min(100, MAX_SCAN_PER_REQUEST - scanned));
    if (!batch.length) { exhausted = true; break; }
    for (const row of batch) {
      scanned += 1; lastScanned = row; cursor = row;
      if (!Number.isFinite(row.score) || row.score < cutoff) { exhausted = true; break; }
      const raw = await client.hGetAll(keyAlert(row.id));
      if (!raw.alertId) {
        await Promise.all([client.zRem(selectedIndex, row.id), client.zRem(baseIndex, row.id),
          client.zRem(openIndex(baseIndex), row.id), client.zRem(highIndex(baseIndex), row.id), client.zRem(resolvedIndex(baseIndex), row.id)]);
        continue;
      }
      const item = securityAlertFromHash(raw);
      if (filters.severity && item.severity !== filters.severity) continue;
      if (filters.status && item.status !== filters.status) continue;
      if (filters.alertType && item.alertType !== filters.alertType) continue;
      if (filters.userId && item.userId !== filters.userId) continue;
      if (filters.search && !item.userId.toLocaleLowerCase().includes(filters.search)
        && !(item.username || '').toLocaleLowerCase().includes(filters.search)) continue;
      if (filters.from !== null && item.createdAtMs < filters.from) continue;
      if (filters.to !== null && item.createdAtMs > filters.to) continue;
      if (items.length === filters.limit) { overflow = row; break; }
      items.push(item);
    }
    if (batch.length < Math.min(100, MAX_SCAN_PER_REQUEST - scanned + batch.length)) exhausted = true;
  }
  const hasMore = Boolean(overflow) || (!exhausted && scanned >= MAX_SCAN_PER_REQUEST);
  const nextCursor = hasMore ? encodeCursor(overflow ? lastScannedBefore(items, lastScanned, overflow, selectedIndex) : lastScanned) : null;
  return { items, nextCursor, hasMore };
}

function lastScannedBefore(items, lastScanned, overflow, selectedIndex) {
  // Pagination cursor is reconstructed from the last returned item when the next matching
  // item was found; nonmatching candidates are intentionally rescanned only within one page.
  const returned = items[items.length - 1];
  return { id: returned.alertId, score: Number(returned.createdAtMs) };
}

async function getOverview(indexKey) {
  const cutoff = Date.now() - RETENTION_SECONDS * 1000;
  const [total, open, high, resolved] = await Promise.all([
    client.zCount(indexKey, cutoff, '+inf'), client.zCount(openIndex(indexKey), cutoff, '+inf'),
    client.zCount(highIndex(indexKey), cutoff, '+inf'), client.zCount(resolvedIndex(indexKey), cutoff, '+inf'),
  ]);
  return { total, open, high, resolved };
}

async function getAlert(alertId, expectedUserId = null, currentManagementId = null) {
  if (typeof alertId !== 'string' || !/^[0-9a-f-]{36}$/i.test(alertId)) return null;
  const raw = await client.hGetAll(keyAlert(alertId));
  if (!raw.alertId || (expectedUserId && raw.userId !== String(expectedUserId))) return null;
  const alert = securityAlertFromHash(raw);
  const liveSessions = await sessions.listUserSessions(raw.userId);
  alert.relatedSessionActive = raw.relatedManagementId
    ? liveSessions.some((session) => session.managementId === raw.relatedManagementId) : false;
  alert.relatedSessionCurrent = Boolean(raw.relatedManagementId && currentManagementId
    && raw.relatedManagementId === String(currentManagementId));
  return alert;
}

async function getAlertSession(alertId, expectedUserId = null) {
  if (typeof alertId !== 'string' || !/^[0-9a-f-]{36}$/i.test(alertId)) return null;
  const raw = await client.hGetAll(keyAlert(alertId));
  if (!raw.alertId || (expectedUserId && raw.userId !== String(expectedUserId))) return null;
  return { userId: raw.userId, username: raw.username || null, managementId: raw.relatedManagementId || null };
}

function mutationKeys(userId, alertId) {
  const keys = alertKeys(userId, alertId);
  return [keys.alert, keys.userOpen, keys.globalOpen, keys.userHigh, keys.globalHigh,
    keys.userResolved, keys.globalResolved, keys.events];
}

async function mutateAlert({ userId, alertId, action, actorUserId }) {
  const keys = alertKeys(userId, alertId);
  const result = await client.eval(MUTATE_ALERT_SCRIPT, {
    keys: mutationKeys(userId, alertId),
    arguments: [action, String(actorUserId), String(RETENTION_SECONDS), String(Date.now())],
  });
  return { status: String(result[0]), value: result[1] === undefined ? null : String(result[1]), historyRecorded: result[2] !== '0' };
}

async function readAlertEvents(alertId, { limit = 50 } = {}) {
  const key = `security:alert:events:${alertId}`;
  if (await client.type(key) !== 'stream') return [];
  const entries = await client.xRevRange(key, '+', '-', { COUNT: Math.min(100, Math.max(1, limit)) });
  const events = [];
  for (const entry of entries) {
    if (entry.message?.alertId !== alertId) continue;
    const timestamp = Number(entry.message.occurredAtMs);
    events.push({
      id: entry.id, eventType: entry.message.eventType,
      actorUserId: entry.message.actorUserId || null,
      occurredAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
      details: entry.message.details || null,
    });
    if (events.length >= Math.min(100, Math.max(1, limit))) break;
  }
  return events;
}

async function listAlertEvents(alertId, expectedUserId = null) {
  const alert = await getAlert(alertId, expectedUserId);
  if (!alert) return null;
  return readAlertEvents(alertId);
}

async function cleanupOnce() {
  const cutoffMs = Date.now() - RETENTION_SECONDS * 1000;
  const stale = await client.zRangeByScore(globalIndex(), '-inf', String(cutoffMs), { LIMIT: { offset: 0, count: 1000 } });
  for (const alertId of stale) {
    const raw = await client.hGetAll(keyAlert(alertId));
    if (raw.userId) {
      const userKey = userIndex(raw.userId);
      await Promise.all([client.zRem(userKey, alertId), client.zRem(openIndex(userKey), alertId),
        client.zRem(highIndex(userKey), alertId), client.zRem(resolvedIndex(userKey), alertId)]);
    }
    const globalKey = globalIndex();
    await Promise.all([client.del(keyAlert(alertId), `security:alert:events:${alertId}`), client.zRem(globalKey, alertId),
      client.zRem(openIndex(globalKey), alertId), client.zRem(highIndex(globalKey), alertId),
      client.zRem(resolvedIndex(globalKey), alertId)]);
  }
  const result = await client.scan(userCleanupCursor, { MATCH: 'security:user:alerts:*', COUNT: 50 });
  userCleanupCursor = String(result.cursor);
  for (const key of result.keys) {
    if (!/^security:user:alerts:[^:]+(?::(?:open|high|resolved))?$/.test(key)) continue;
    await client.zRemRangeByScore(key, '-inf', String(cutoffMs));
  }
  const eventKey = eventStream();
  if (await client.type(eventKey) === 'stream') {
    const cutoffId = `${cutoffMs}-0`;
    await client.eval("return redis.call('XTRIM', KEYS[1], 'MINID', '=', ARGV[1])", { keys: [eventKey], arguments: [cutoffId] });
  }
}

async function cleanupSafely() {
  if (cleanupRunning || !client.isReady) return;
  cleanupRunning = true;
  try { await cleanupOnce(); }
  catch (error) { console.error('[security cleanup] Failed to remove expired security data:', error.message); }
  finally { cleanupRunning = false; }
}
async function startCleanup() {
  await cleanupSafely();
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = setInterval(cleanupSafely, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
}
function stopCleanup() { if (cleanupTimer) clearInterval(cleanupTimer); cleanupTimer = null; }

module.exports = {
  DEFAULT_RETENTION_SECONDS, RETENTION_SECONDS, DEDUPE_SECONDS, MAX_KNOWN_MARKERS,
  normalizeIp, normalizeDevice, securityAlertFromHash, observeSuccessfulLogin, createLockoutAlert,
  validateListQuery, listAlerts, getOverview, getAlert, mutateAlert, readAlertEvents,
  getAlertSession, listAlertEvents, cleanupOnce, startCleanup, stopCleanup,
  userIndex, globalIndex, keyAlert, eventStream, knownDevices, knownIps, baseline,
};
