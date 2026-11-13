const { client } = require('./redisClient');

const DEFAULT_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const RETENTION_SECONDS = positiveIntegerEnv('AUDIT_RETENTION_SECONDS', DEFAULT_RETENTION_SECONDS);
const CLEANUP_INTERVAL_MS = positiveIntegerEnv('AUDIT_CLEANUP_INTERVAL_MS', 15 * 60 * 1000);
const CLEANUP_SCAN_COUNT = positiveIntegerEnv('AUDIT_CLEANUP_SCAN_COUNT', 100);
const MAX_READ_COUNT = 100;
const MAX_SCAN_PER_REQUEST = 500;
const EVENT_TYPES = Object.freeze([
  'LOGIN_SUCCESS', 'LOGIN_FAILED', 'LOGIN_LOCKED', 'LOGOUT', 'SESSION_REVOKED',
  'LOGOUT_ALL', 'SESSION_AUTO_REVOKED', 'ADMIN_SESSION_REVOKED', 'ADMIN_LOGOUT_ALL',
]);

let cleanupCursor = '0';
let cleanupTimer = null;
let cleanupRunning = false;

function positiveIntegerEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function globalStreamKey() { return 'audit:auth:global'; }
function userStreamKey(userId) { return `audit:auth:user:${userId}`; }

function parseStreamTime(value) {
  if (typeof value !== 'string' || value.length > 64 || !value) return null;
  if (/^\d{10,13}$/.test(value)) {
    const number = Number(value);
    return value.length === 10 ? number * 1000 : number;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validateHistoryQuery(query = {}, { allowUserId = false } = {}) {
  const limitValue = query.limit === undefined ? 20 : Number(query.limit);
  if (!Number.isInteger(limitValue) || limitValue < 1 || limitValue > MAX_READ_COUNT) {
    return { error: `limit phải nằm trong khoảng 1 đến ${MAX_READ_COUNT}` };
  }
  const cursor = query.cursor || null;
  if (cursor !== null && (typeof cursor !== 'string' || !/^\d{1,15}-\d{1,15}$/.test(cursor))) {
    return { error: 'cursor không hợp lệ' };
  }
  const eventType = query.eventType || null;
  if (eventType !== null && !EVENT_TYPES.includes(eventType)) return { error: 'eventType không hợp lệ' };
  const userId = allowUserId && typeof query.userId === 'string' ? query.userId : null;
  if (allowUserId && query.userId !== undefined && (!userId || userId.length > 128 || /[\u0000-\u001f\u007f]/.test(userId))) {
    return { error: 'userId không hợp lệ' };
  }
  const from = query.from === undefined ? null : parseStreamTime(String(query.from));
  const to = query.to === undefined ? null : parseStreamTime(String(query.to));
  if (query.from !== undefined && from === null) return { error: 'from không hợp lệ' };
  if (query.to !== undefined && to === null) return { error: 'to không hợp lệ' };
  if (from !== null && to !== null && from > to) return { error: 'from phải nhỏ hơn hoặc bằng to' };
  const cutoffMs = Date.now() - RETENTION_SECONDS * 1000;
  return {
    value: {
      limit: limitValue,
      cursor,
      eventType,
      userId,
      from: from === null ? cutoffMs : Math.max(from, cutoffMs),
      to: to === null ? Date.now() : Math.min(to, Date.now()),
      cutoffMs,
    },
  };
}

function entryFieldsToObject(entry) {
  const fields = entry.message || {};
  const occurredAtMs = Number(fields.occurredAtMs);
  return {
    id: entry.id,
    eventId: fields.eventId,
    eventType: fields.eventType,
    actorUserId: fields.actorUserId || null,
    actorRole: fields.actorRole || null,
    actorUsername: fields.actorUsername || null,
    targetUserId: fields.targetUserId || null,
    username: fields.username || null,
    occurredAt: Number.isFinite(occurredAtMs) ? new Date(occurredAtMs).toISOString() : null,
    occurredAtMs: Number.isFinite(occurredAtMs) ? occurredAtMs : null,
    result: fields.result || null,
    device: fields.device || null,
    ip: fields.ip || null,
    revokedCount: fields.revokedCount === undefined ? null : Number(fields.revokedCount),
    reason: fields.reason || null,
  };
}

async function trimStream(streamKey, cutoffMs = Date.now() - RETENTION_SECONDS * 1000) {
  if (await client.type(streamKey) !== 'stream') return 0;
  const cutoffId = `${Math.max(0, Math.floor(cutoffMs))}-0`;
  return client.eval("return redis.call('XTRIM', KEYS[1], 'MINID', '=', ARGV[1])", {
    keys: [streamKey], arguments: [cutoffId],
  });
}

function matches(entry, filters) {
  const fields = entry.message || {};
  const at = Number(fields.occurredAtMs);
  if (!Number.isFinite(at) || at < filters.from || at > filters.to) return false;
  if (filters.eventType && fields.eventType !== filters.eventType) return false;
  if (filters.userId && fields.actorUserId !== filters.userId && fields.targetUserId !== filters.userId) return false;
  return true;
}

async function readHistory(streamKey, filters) {
  const initialType = await client.type(streamKey);
  if (initialType !== 'none' && initialType !== 'stream') throw new Error('Audit history key has an invalid type');
  if (initialType === 'none') return { items: [], nextCursor: null, hasMore: false };
  await trimStream(streamKey, filters.cutoffMs);

  let bound = filters.cursor ? `(${filters.cursor}` : '+';
  let scanned = 0;
  let exhausted = false;
  let stoppedAtTimeBoundary = false;
  const items = [];
  let lastScannedId = null;
  let overflowResult = null;

  while (scanned < MAX_SCAN_PER_REQUEST && !exhausted && !overflowResult) {
    const count = Math.min(100, MAX_SCAN_PER_REQUEST - scanned);
    const batch = await client.xRevRange(streamKey, bound, '-', { COUNT: count });
    if (!batch.length) { exhausted = true; break; }

    for (const entry of batch) {
      scanned += 1;
      lastScannedId = entry.id;
      bound = `(${entry.id}`;
      const at = Number(entry.message?.occurredAtMs);
      if (Number.isFinite(at) && at < filters.from) {
        exhausted = true;
        stoppedAtTimeBoundary = true;
        break;
      }
      if (!matches(entry, filters)) continue;
      if (items.length === filters.limit) {
        overflowResult = entry;
        break;
      }
      items.push(entryFieldsToObject(entry));
    }
    if (overflowResult || exhausted) break;
    if (batch.length < count) exhausted = true;
  }

  if (overflowResult) {
    return { items, nextCursor: items[items.length - 1].id, hasMore: true };
  }
  if (exhausted || stoppedAtTimeBoundary || !lastScannedId) {
    return { items, nextCursor: null, hasMore: false };
  }
  const more = await client.xRevRange(streamKey, `(${lastScannedId}`, '-', { COUNT: 1 });
  return {
    items,
    nextCursor: more.length ? lastScannedId : null,
    hasMore: more.length > 0,
  };
}

async function cleanupOnce() {
  await trimStream(globalStreamKey());
  // Process a bounded number of SCAN pages per pass. A larger keyspace continues
  // from cleanupCursor on the next timer tick; normal project datasets get a full pass.
  let pages = 0;
  do {
    const result = await client.scan(cleanupCursor, {
      MATCH: 'audit:auth:user:*',
      COUNT: CLEANUP_SCAN_COUNT,
    });
    cleanupCursor = String(result.cursor);
    for (const key of result.keys) {
      if (!/^audit:auth:user:[^:]+$/.test(key)) continue;
      await trimStream(key);
    }
    pages += 1;
  } while (cleanupCursor !== '0' && pages < 100);
}

async function cleanupSafely() {
  if (cleanupRunning || !client.isReady) return;
  cleanupRunning = true;
  try { await cleanupOnce(); }
  catch (error) { console.error('[audit cleanup] Failed to trim expired audit entries:', error.message); }
  finally { cleanupRunning = false; }
}

async function startCleanup() {
  await cleanupSafely();
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = setInterval(cleanupSafely, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
}

function stopCleanup() {
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = null;
}

module.exports = {
  DEFAULT_RETENTION_SECONDS,
  RETENTION_SECONDS,
  CLEANUP_INTERVAL_MS,
  MAX_READ_COUNT,
  MAX_SCAN_PER_REQUEST,
  EVENT_TYPES,
  globalStreamKey,
  userStreamKey,
  validateHistoryQuery,
  readHistory,
  trimStream,
  cleanupOnce,
  startCleanup,
  stopCleanup,
};
