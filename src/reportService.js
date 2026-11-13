const { client } = require('./redisClient');
const audit = require('./auditService');
const security = require('./securityService');

const TIME_ZONE = 'Asia/Ho_Chi_Minh';
const OFFSET_MS = 7 * 60 * 60 * 1000;
const MAX_DAYS = 30;
const BATCH_SIZE = 200;
const MAX_TIED_ALERTS = 1000;
const MAX_ROWS = positiveIntegerEnv('EXPORT_MAX_ROWS', 5000);
const MAX_SCAN = positiveIntegerEnv('EXPORT_MAX_SCAN', 50000);
const EVENT_TYPES = new Set(audit.EVENT_TYPES);
const ALERT_TYPES = new Set(['NEW_LOGIN_ENVIRONMENT', 'LOGIN_LOCKOUT']);
const SEVERITIES = new Set(['LOW', 'MEDIUM', 'HIGH']);
const STATUSES = new Set(['OPEN', 'PROCESSING', 'RESOLVED_SAFE', 'RESOLVED_REVOKED']);

class ReportError extends Error {
  constructor(message, status = 400, code = 'INVALID_REPORT') {
    super(message);
    this.name = 'ReportError';
    this.status = status;
    this.code = code;
  }
}

function positiveIntegerEnv(name, fallback) {
  const number = Number(process.env[name]);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function vnToday(nowMs = Date.now()) {
  return new Date(nowMs + OFFSET_MS).toISOString().slice(0, 10);
}

function vnMidnightMs(date) {
  return Date.parse(`${date}T00:00:00.000Z`) - OFFSET_MS;
}

function validateDateRange(query = {}, nowMs = Date.now()) {
  for (const key of ['from', 'to']) {
    if (query[key] !== undefined && !validDate(query[key])) throw new ReportError(`${key} phải có định dạng YYYY-MM-DD và là ngày hợp lệ`);
  }
  const today = vnToday(nowMs);
  const to = query.to || today;
  const defaultFrom = new Date(vnMidnightMs(to) - 6 * 24 * 60 * 60 * 1000 + OFFSET_MS).toISOString().slice(0, 10);
  const from = query.from || defaultFrom;
  if (from > to) throw new ReportError('Ngày bắt đầu phải nhỏ hơn hoặc bằng ngày kết thúc');
  if (to > today) throw new ReportError('Không thể xuất báo cáo cho ngày trong tương lai');
  const dayCount = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
  if (dayCount > MAX_DAYS) throw new ReportError(`Mỗi lần xuất tối đa ${MAX_DAYS} ngày; hãy chọn khoảng thời gian ngắn hơn`);
  const fromMs = vnMidnightMs(from);
  const toExclusiveMs = vnMidnightMs(to) + 86400000;
  return { from, to, fromMs, toExclusiveMs, toMs: Math.min(toExclusiveMs - 1, nowMs), dayCount };
}

function validateFilters(query = {}, { admin = false, kind }) {
  const range = validateDateRange(query);
  let userId = null;
  if (query.userId !== undefined) {
    if (!admin) throw new ReportError('USER không thể chỉ định userId để xuất báo cáo');
    if (typeof query.userId !== 'string' || !query.userId || query.userId.length > 128 || /[\u0000-\u001f\u007f]/.test(query.userId)) {
      throw new ReportError('userId không hợp lệ');
    }
    userId = query.userId;
  }
  const filters = { ...range, userId, admin };
  if (kind === 'history' || kind === 'summary') {
    if (kind === 'summary' && query.eventType !== undefined && query.eventType !== '') {
      throw new ReportError('eventType không được hỗ trợ cho báo cáo thống kê');
    }
    if (query.eventType !== undefined && query.eventType !== '' && !EVENT_TYPES.has(query.eventType)) {
      throw new ReportError('eventType không hợp lệ');
    }
    filters.eventType = query.eventType || null;
  }
  if (kind === 'security') {
    for (const [key, allowed] of [['severity', SEVERITIES], ['status', STATUSES], ['alertType', ALERT_TYPES]]) {
      if (query[key] !== undefined && query[key] !== '' && (typeof query[key] !== 'string' || !allowed.has(query[key]))) {
        throw new ReportError(`${key} không hợp lệ`);
      }
      filters[key] = query[key] || null;
    }
  }
  return filters;
}

function compareStreamIds(a, b) {
  const [am, as] = a.split('-').map(BigInt);
  const [bm, bs] = b.split('-').map(BigInt);
  return am === bm ? (as < bs ? -1 : as > bs ? 1 : 0) : (am < bm ? -1 : 1);
}

function safeEffectiveFrom(fromMs, retentionSeconds, nowMs = Date.now()) {
  return Math.max(fromMs, nowMs - retentionSeconds * 1000);
}

async function readAuditForReport(filters, { collect = true, onEntry } = {}) {
  const streamKey = filters.admin ? audit.globalStreamKey() : audit.userStreamKey(filters.userId);
  const keyType = await client.type(streamKey);
  if (keyType === 'none') return { rows: [], scanned: 0 };
  if (keyType !== 'stream') throw new ReportError('Nguồn lịch sử Redis không đúng kiểu Stream', 503, 'REDIS_SOURCE_ERROR');

  const now = Date.now();
  const effectiveFrom = safeEffectiveFrom(filters.fromMs, audit.RETENTION_SECONDS, now);
  const endExclusive = Math.min(filters.toExclusiveMs, now + 1);
  if (effectiveFrom >= endExclusive) return { rows: [], scanned: 0 };
  const lowerId = `${Math.max(0, Math.floor(effectiveFrom))}-0`;
  const upperExclusiveId = `(${Math.max(0, Math.floor(endExclusive))}-0`;
  const latest = await client.xRevRange(streamKey, '+', '-', { COUNT: 1 });
  if (!latest.length || compareStreamIds(latest[0].id, lowerId) < 0) return { rows: [], scanned: 0 };
  const upperBound = compareStreamIds(latest[0].id, `${Math.max(0, Math.floor(endExclusive))}-0`) < 0
    ? latest[0].id : upperExclusiveId;
  if (compareStreamIds(upperBound.startsWith('(') ? upperBound.slice(1) : upperBound, lowerId) < 0) return { rows: [], scanned: 0 };

  const rows = [];
  let bound = upperBound;
  let scanned = 0;
  const seenEventIds = new Set();
  while (scanned < MAX_SCAN) {
    const entries = await client.xRevRange(streamKey, bound, lowerId, { COUNT: Math.min(BATCH_SIZE, MAX_SCAN - scanned) });
    if (!entries.length) return { rows, scanned };
    for (const entry of entries) {
      scanned += 1;
      bound = `(${entry.id}`;
      const fields = entry.message || {};
      const occurredAtMs = Number(fields.occurredAtMs);
      if (!Number.isFinite(occurredAtMs) || occurredAtMs < effectiveFrom || occurredAtMs >= endExclusive) continue;
      if (!EVENT_TYPES.has(fields.eventType)) continue;
      if (filters.eventType && fields.eventType !== filters.eventType) continue;
      if (filters.userId && fields.actorUserId !== filters.userId && fields.targetUserId !== filters.userId) continue;
      const eventId = fields.eventId || entry.id;
      if (seenEventIds.has(eventId)) continue;
      seenEventIds.add(eventId);
      const row = {
        id: entry.id, eventId, occurredAtMs, eventType: fields.eventType,
        userId: fields.targetUserId || fields.actorUserId || '',
        username: fields.username || fields.actorUsername || '',
        result: fields.result || '', device: fields.device || '', ip: fields.ip || '',
        reason: fields.reason || '',
        revokedCount: fields.revokedCount === undefined || fields.revokedCount === '' ? null : Number(fields.revokedCount),
      };
      if (onEntry) onEntry(row);
      if (collect) {
        rows.push(row);
        if (rows.length > MAX_ROWS) throw new ReportError(`Báo cáo vượt giới hạn ${MAX_ROWS} dòng; hãy thu hẹp khoảng thời gian hoặc bộ lọc`, 413, 'EXPORT_ROW_LIMIT');
      }
    }
    if (entries.length < Math.min(BATCH_SIZE, MAX_SCAN - scanned + entries.length)) return { rows, scanned };
  }
  const more = await client.xRevRange(streamKey, bound, lowerId, { COUNT: 1 });
  if (more.length) throw new ReportError(`Phạm vi cần quét vượt giới hạn an toàn ${MAX_SCAN} sự kiện; hãy thu hẹp bộ lọc`, 413, 'EXPORT_SCAN_LIMIT');
  return { rows, scanned };
}

async function readScoreRange(key, max, min, limit) {
  const values = await client.sendCommand(['ZREVRANGEBYSCORE', key, String(max), String(min), 'WITHSCORES', 'LIMIT', '0', String(limit)]);
  const rows = [];
  for (let i = 0; i < values.length; i += 2) rows.push({ id: values[i], score: Number(values[i + 1]) });
  return rows;
}

async function nextAlertBatch(indexKey, cursor, minScore, maxScore, count) {
  if (!cursor) return readScoreRange(indexKey, maxScore, minScore, count);
  const tied = await readScoreRange(indexKey, cursor.score, cursor.score, MAX_TIED_ALERTS + 1);
  if (tied.length > MAX_TIED_ALERTS) throw new ReportError('Quá nhiều cảnh báo cùng thời điểm để phân trang an toàn; hãy thu hẹp ngày xuất', 413, 'EXPORT_TIE_LIMIT');
  const afterTied = tied.filter((row) => row.id.localeCompare(cursor.id) < 0);
  if (afterTied.length >= count) return afterTied.slice(0, count);
  const older = await readScoreRange(indexKey, `(${cursor.score}`, minScore, count - afterTied.length);
  return afterTied.concat(older);
}

function alertMatches(alert, filters) {
  return alert.alertId && Number.isFinite(alert.createdAtMs)
    && alert.createdAtMs >= filters.effectiveFrom && alert.createdAtMs <= filters.toMs
    && (!filters.userId || alert.userId === filters.userId)
    && (!filters.severity || alert.severity === filters.severity)
    && (!filters.status || alert.status === filters.status)
    && (!filters.alertType || alert.alertType === filters.alertType);
}

async function readAlertsForReport(filters, { collect = true, onAlert } = {}) {
  const indexKey = filters.admin ? security.globalIndex() : security.userIndex(filters.userId);
  const keyType = await client.type(indexKey);
  if (keyType === 'none') return { rows: [], scanned: 0 };
  if (keyType !== 'zset') throw new ReportError('Nguồn cảnh báo Redis không đúng kiểu Sorted Set', 503, 'REDIS_SOURCE_ERROR');
  const now = Date.now();
  const effectiveFrom = safeEffectiveFrom(filters.fromMs, security.RETENTION_SECONDS, now);
  const maxScore = Math.min(filters.toMs, now);
  if (effectiveFrom > maxScore) return { rows: [], scanned: 0 };
  const scoped = { ...filters, effectiveFrom };
  let cursor = null;
  let scanned = 0;
  const rows = [];
  const seen = new Set();
  while (scanned < MAX_SCAN) {
    const batch = await nextAlertBatch(indexKey, cursor, effectiveFrom, maxScore, Math.min(BATCH_SIZE, MAX_SCAN - scanned));
    if (!batch.length) return { rows, scanned };
    for (const row of batch) {
      if (row.score < effectiveFrom) return { rows, scanned };
      scanned += 1;
      cursor = row;
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const raw = await client.hGetAll(security.keyAlert(row.id));
      const alert = security.securityAlertFromHash(raw);
      if (!alertMatches(alert, scoped)) continue;
      if (onAlert) onAlert(alert);
      if (collect) {
        rows.push(alert);
        if (rows.length > MAX_ROWS) throw new ReportError(`Báo cáo vượt giới hạn ${MAX_ROWS} dòng; hãy thu hẹp khoảng thời gian hoặc bộ lọc`, 413, 'EXPORT_ROW_LIMIT');
      }
    }
    if (batch.length < Math.min(BATCH_SIZE, MAX_SCAN - scanned + batch.length)) return { rows, scanned };
  }
  const more = await nextAlertBatch(indexKey, cursor, effectiveFrom, maxScore, 1);
  if (more.length && more[0].score >= effectiveFrom) throw new ReportError(`Phạm vi cần quét vượt giới hạn an toàn ${MAX_SCAN} cảnh báo; hãy thu hẹp bộ lọc`, 413, 'EXPORT_SCAN_LIMIT');
  return { rows, scanned };
}

function formatVnDateTime(value) {
  const date = new Date(Number(value) + OFFSET_MS);
  return `${date.toISOString().slice(0, 19).replace('T', ' ')} +07:00`;
}

function localDate(value) {
  return new Date(Number(value) + OFFSET_MS).toISOString().slice(0, 10);
}

function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[\s\uFEFF]*[=+@-]/u.test(text) || /^[\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(headers, rows) {
  return `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

function historyCsvRows(events) {
  return events.map((event, index) => [index + 1, formatVnDateTime(event.occurredAtMs), event.username,
    event.eventType, event.result, event.device, event.ip,
    [event.reason, Number.isFinite(event.revokedCount) ? `Số phiên: ${event.revokedCount}` : ''].filter(Boolean).join(' · ') ]);
}

function alertCsvRows(alerts) {
  return alerts.map((alert, index) => [index + 1, alert.alertId, formatVnDateTime(alert.createdAtMs), alert.username,
    alert.alertType, alert.reasons.join('; '), alert.severity, alert.device, alert.ip, alert.status,
    alert.readAt ? 'Có' : 'Không', alert.resolvedAt ? formatVnDateTime(Date.parse(alert.resolvedAt)) : '',
    alert.resolvedBy || '', alert.resolution || '']);
}

function dateBuckets(range) {
  const buckets = new Map();
  for (let offset = 0; offset < range.dayCount; offset += 1) {
    const day = new Date(Date.parse(`${range.from}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
    buckets.set(day, { date: day, success: 0, failed: 0, locked: 0, logout: 0, revoked: 0,
      alerts: 0, low: 0, medium: 0, high: 0 });
  }
  return buckets;
}

function countAuditMetric(buckets, event) {
  const bucket = buckets.get(localDate(event.occurredAtMs));
  if (!bucket) return;
  if (event.eventType === 'LOGIN_SUCCESS') bucket.success += 1;
  else if (event.eventType === 'LOGIN_FAILED') bucket.failed += 1;
  else if (event.eventType === 'LOGIN_LOCKED') bucket.locked += 1;
  else if (['LOGOUT', 'LOGOUT_ALL', 'ADMIN_LOGOUT_ALL'].includes(event.eventType)) bucket.logout += 1;
  if (['SESSION_REVOKED', 'SESSION_AUTO_REVOKED', 'ADMIN_SESSION_REVOKED'].includes(event.eventType)) bucket.revoked += 1;
  else if (['LOGOUT_ALL', 'ADMIN_LOGOUT_ALL'].includes(event.eventType)) bucket.revoked += Number.isFinite(event.revokedCount) ? Math.max(0, event.revokedCount) : 0;
}

function countAlertMetric(buckets, alert) {
  const bucket = buckets.get(localDate(alert.createdAtMs));
  if (!bucket) return;
  bucket.alerts += 1;
  if (alert.severity === 'LOW') bucket.low += 1;
  else if (alert.severity === 'MEDIUM') bucket.medium += 1;
  else if (alert.severity === 'HIGH') bucket.high += 1;
}

async function buildHistory(filters) {
  const { rows } = await readAuditForReport(filters);
  return rows.sort((a, b) => b.occurredAtMs - a.occurredAtMs || b.id.localeCompare(a.id));
}

async function buildSecurity(filters) {
  const { rows } = await readAlertsForReport(filters);
  return rows.sort((a, b) => b.createdAtMs - a.createdAtMs || b.alertId.localeCompare(a.alertId));
}

async function buildSummary(filters) {
  const buckets = dateBuckets(filters);
  await readAuditForReport(filters, { collect: false, onEntry: (event) => countAuditMetric(buckets, event) });
  await readAlertsForReport(filters, { collect: false, onAlert: (alert) => countAlertMetric(buckets, alert) });
  return Array.from(buckets.values()).map((row) => [row.date, row.success, row.failed, row.locked,
    row.logout, row.revoked, row.alerts, row.high, row.low, row.medium]);
}

function fileDate(nowMs = Date.now()) { return vnToday(nowMs); }

module.exports = {
  ReportError, TIME_ZONE, MAX_DAYS, MAX_ROWS, MAX_SCAN, EVENT_TYPES, ALERT_TYPES, SEVERITIES, STATUSES,
  validateDateRange, validateFilters, readAuditForReport, readAlertsForReport,
  formatVnDateTime, csvCell, toCsv, historyCsvRows, alertCsvRows, buildHistory, buildSecurity, buildSummary, fileDate,
};
