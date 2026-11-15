const crypto = require('node:crypto');
const { initializeApp, applicationDefault, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { client } = require('./redisClient');

const ENABLED = process.env.FIRESTORE_SYNC_ENABLED === 'true';
const SOURCE_EPOCH = process.env.FIRESTORE_SOURCE_EPOCH || 'redis-session-app-v1';
const POLL_MS = positiveIntegerEnv('FIRESTORE_SYNC_POLL_MS', 1000);
const BATCH_SIZE = Math.min(500, positiveIntegerEnv('FIRESTORE_SYNC_BATCH_SIZE', 50));
const SOURCES = ['audit:auth:global', 'security:alerts:events'];
const TYPE_MAP = {
  LOGIN_SUCCESS: 'login_success', LOGIN_FAILED: 'login_failed', LOGIN_LOCKED: 'login_locked',
  LOGOUT: 'logout', SESSION_REVOKED: 'session_revoked', LOGOUT_ALL: 'logout_all',
  SESSION_AUTO_REVOKED: 'session_auto_revoked', ADMIN_SESSION_REVOKED: 'admin_session_revoked',
  ADMIN_LOGOUT_ALL: 'admin_logout_all',
};

let db = null;
let workerPromise = null;
let stopping = false;
let wakeTimer = null;

function positiveIntegerEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function initialize() {
  if (!ENABLED) return false;
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(SOURCE_EPOCH)) {
    throw new Error('FIRESTORE_SOURCE_EPOCH must contain only letters, numbers, underscores, or hyphens (max 80 chars)');
  }
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
  const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const options = { projectId };
  if (serviceAccountPath) options.credential = cert(serviceAccountPath);
  else options.credential = applicationDefault();
  const app = getApps()[0] || initializeApp(options);
  db = getFirestore(app);
  console.log(`[Firestore] Durable sync enabled for ${projectId || 'ADC project'}`);
  return true;
}

function ensureDb() {
  if (!db) return null;
  return db;
}

async function saveUserProfile(user) {
  const firestore = ensureDb();
  if (!firestore || !user?.userId) return false;
  const userId = String(user.userId);
  const now = Timestamp.now();
  const profile = {
    user_id: userId,
    username: String(user.username || '').slice(0, 64) || null,
    display_name: String(user.displayName || user.username || '').slice(0, 120),
    email: String(user.email || '').slice(0, 254) || null,
    email_verified: Boolean(user.emailVerified),
    avatar_url: String(user.avatarUrl || '').slice(0, 2048) || null,
    status: String(user.status || 'active').slice(0, 24),
    role: String(user.role || 'USER').slice(0, 24),
    auth_provider: 'internal',
    auth_subject: userId,
    updated_at: now,
    schema_version: 1,
  };
  // Explicit field allowlist: passwordHash and all live session identifiers stay in Redis.
  const userRef = firestore.collection('users').doc(userId);
  await firestore.runTransaction(async (transaction) => {
    const existing = await transaction.get(userRef);
    const existingStatus = existing.get('status');
    transaction.set(userRef, {
      ...profile,
      created_at: existing.get('created_at') || (user.createdAt ? Timestamp.fromDate(new Date(user.createdAt)) : now),
      status_changed_at: !existing.exists || existingStatus !== profile.status
        ? now : existing.get('status_changed_at') || now,
    }, { merge: true });
  });
  return true;
}

function compareStreamIds(a, b) {
  const [ams, aseq] = String(a).split('-').map((part) => BigInt(part));
  const [bms, bseq] = String(b).split('-').map((part) => BigInt(part));
  if (ams !== bms) return ams < bms ? -1 : 1;
  return aseq === bseq ? 0 : aseq < bseq ? -1 : 1;
}

function sourceId(source) {
  return crypto.createHash('sha256').update(`${SOURCE_EPOCH}:${source}`).digest('hex');
}

function stableEvent(source, streamId, fields) {
  const occurredMs = Number(fields.occurredAtMs);
  if (!Number.isSafeInteger(occurredMs) || occurredMs < 0) {
    throw new Error(`Invalid occurredAtMs in ${source}/${streamId}`);
  }
  const isSecurity = source === 'security:alerts:events';
  const type = isSecurity ? String(fields.eventType || 'SECURITY_EVENT') : String(fields.eventType || 'UNKNOWN');
  const eventId = isSecurity ? `security-${SOURCE_EPOCH}-${streamId}` : String(fields.eventId || `audit-${streamId}`);
  const userId = isSecurity ? String(fields.userId || '') : String(fields.targetUserId || fields.actorUserId || '');
  const payload = isSecurity
    ? { alert_id: String(fields.alertId || ''), actor_user_id: String(fields.actorUserId || '') || null, details: String(fields.details || '').slice(0, 256) || null }
    : {
      actor_user_id: String(fields.actorUserId || '') || null,
      actor_role: String(fields.actorRole || '') || null,
      actor_username: String(fields.actorUsername || '') || null,
      target_user_id: String(fields.targetUserId || '') || null,
      username: String(fields.username || '') || null,
      revoked_count: fields.revokedCount === undefined ? null : Number(fields.revokedCount),
      reason: String(fields.reason || '') || null,
      created_at_ms: fields.createdAtMs === undefined ? null : Number(fields.createdAtMs),
      expires_at_ms: fields.expiresAtMs === undefined ? null : Number(fields.expiresAtMs),
      session_refs: String(fields.sessionRefs || '').split(',').filter(Boolean),
    };
  const normalized = {
    event_id: eventId,
    event_type: isSecurity ? type.toLowerCase() : (TYPE_MAP[type] || type.toLowerCase()),
    user_id: userId || null,
    session_ref: String(fields.sessionRef || '') || null,
    occurred_at: Timestamp.fromMillis(occurredMs),
    result: isSecurity ? 'recorded' : String(fields.result || '').toLowerCase() || 'unknown',
    reason: String(fields.reason || fields.details || '') || null,
    ip: isSecurity ? null : String(fields.ip || '') || null,
    device_name: isSecurity ? null : String(fields.device || '') || null,
    request_id: eventId,
    source_epoch: SOURCE_EPOCH,
    source_stream_key: source,
    source_stream_id: streamId,
    payload,
    schema_version: 1,
  };
  const hashable = { ...normalized, occurred_at_ms: occurredMs };
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify(hashable)).digest('hex');
  return {
    eventId, occurredMs, userId, normalized, payloadHash,
    eventType: type, isSecurity, sessionRef: normalized.session_ref,
  };
}

async function applyEvent(source, entry) {
  const firestore = ensureDb();
  const fields = entry.message || {};
  const event = stableEvent(source, entry.id, fields);
  const checkpointRef = firestore.collection('auth_sync_checkpoints').doc(sourceId(source));
  const receiptId = crypto.createHash('sha256').update(`${SOURCE_EPOCH}:${source}:${entry.id}`).digest('hex');
  const receiptRef = firestore.collection('auth_event_receipts').doc(receiptId);
  const eventRef = firestore.collection('activity_events').doc(event.eventId);
  const systemRef = firestore.collection('system_auth_stats').doc('total');
  const userRef = event.userId ? firestore.collection('user_auth_stats').doc(event.userId) : null;
  const endingReason = {
    LOGOUT: 'user_logout', SESSION_REVOKED: 'admin_revoke',
    SESSION_AUTO_REVOKED: 'session_limit', ADMIN_SESSION_REVOKED: 'admin_revoke',
    LOGOUT_ALL: 'logout_all', ADMIN_LOGOUT_ALL: 'admin_logout_all',
  }[event.eventType] || null;
  const sessionRefs = new Set(event.sessionRef ? [event.sessionRef] : []);
  if (['LOGOUT_ALL', 'ADMIN_LOGOUT_ALL'].includes(event.eventType)) {
    for (const ref of event.normalized.payload.session_refs) sessionRefs.add(ref);
  }
  const sessionRefList = event.eventType === 'LOGIN_SUCCESS' && event.sessionRef
    ? [event.sessionRef] : ['LOGOUT', 'SESSION_REVOKED', 'SESSION_AUTO_REVOKED', 'ADMIN_SESSION_REVOKED', 'LOGOUT_ALL', 'ADMIN_LOGOUT_ALL'].includes(event.eventType)
      ? Array.from(sessionRefs) : [];
  const sessionRefsMap = new Map(sessionRefList.map((ref) => [
    ref, firestore.collection('session_history').doc(ref),
  ]));

  await firestore.runTransaction(async (transaction) => {
    const [checkpointSnap, receiptSnap, eventSnap, systemSnap, userSnap, ...sessionSnaps] = await Promise.all([
      transaction.get(checkpointRef), transaction.get(receiptRef), transaction.get(eventRef),
      transaction.get(systemRef), userRef ? transaction.get(userRef) : Promise.resolve(null),
      ...Array.from(sessionRefsMap.values(), (ref) => transaction.get(ref)),
    ]);
    const previousId = checkpointSnap.get('last_stream_id') || '0-0';
    if (compareStreamIds(entry.id, previousId) <= 0) return;
    if (receiptSnap.exists) {
      if (receiptSnap.get('payload_hash') !== event.payloadHash) {
        throw new Error(`Firestore receipt payload conflict for ${source}/${entry.id}`);
      }
      if (!eventSnap.exists) throw new Error(`Firestore receipt exists without event ${event.eventId}`);
    } else {
      if (eventSnap.exists) throw new Error(`Firestore event exists without receipt ${event.eventId}`);
      transaction.create(eventRef, {
        ...event.normalized,
        ingested_at: FieldValue.serverTimestamp(),
      });
      transaction.create(receiptRef, {
        applied_at: FieldValue.serverTimestamp(), payload_hash: event.payloadHash, schema_version: 1,
      });

      if (!event.isSecurity) {
        const system = systemSnap.data() || {};
        const userStats = userSnap?.data() || {};
        const systemPatch = { updated_at: FieldValue.serverTimestamp(), schema_version: 1 };
        const userPatch = { user_id: event.userId, updated_at: FieldValue.serverTimestamp(), schema_version: 1 };
        if (event.eventType === 'LOGIN_SUCCESS') {
          systemPatch.login_success_total = Number(system.login_success_total || 0) + 1;
          userPatch.login_success_total = Number(userStats.login_success_total || 0) + 1;
          const at = event.normalized.occurred_at;
          if (!system.counting_started_at) systemPatch.counting_started_at = at;
          if (!userStats.counting_started_at) userPatch.counting_started_at = at;
          if (!system.last_login_at || system.last_login_at.toMillis() < event.occurredMs) systemPatch.last_login_at = at;
          if (!userStats.last_login_at || userStats.last_login_at.toMillis() < event.occurredMs) userPatch.last_login_at = at;
        } else if (event.eventType === 'LOGIN_FAILED') {
          systemPatch.login_failed_total = Number(system.login_failed_total || 0) + 1;
          if (!event.userId) systemPatch.login_failed_unknown_total = Number(system.login_failed_unknown_total || 0) + 1;
          else {
            userPatch.login_failed_total = Number(userStats.login_failed_total || 0) + 1;
            if (!userStats.counting_started_at) userPatch.counting_started_at = event.normalized.occurred_at;
            if (!userStats.last_failed_login_at || userStats.last_failed_login_at.toMillis() < event.occurredMs) userPatch.last_failed_login_at = event.normalized.occurred_at;
          }
        }
        transaction.set(systemRef, systemPatch, { merge: true });
        if (userRef) transaction.set(userRef, userPatch, { merge: true });
      }

      if (event.eventType === 'LOGIN_SUCCESS' && event.sessionRef) {
        const createdAtMs = Number(event.normalized.payload.created_at_ms);
        const expiresAtMs = Number(event.normalized.payload.expires_at_ms);
        if (!Number.isSafeInteger(createdAtMs) || !Number.isSafeInteger(expiresAtMs)) {
          throw new Error(`Login event is missing session timestamps at ${source}/${entry.id}`);
        }
        const oldSession = sessionSnaps[0];
        transaction.set(sessionRefsMap.get(event.sessionRef), {
          session_ref: event.sessionRef, user_id: event.userId, status: 'open',
          created_at: Timestamp.fromMillis(createdAtMs), last_seen_at: Timestamp.fromMillis(createdAtMs),
          expires_at: Timestamp.fromMillis(expiresAtMs), absolute_expires_at: null,
          ended_at: null, end_reason: null, auth_method: 'password',
          ip_created: event.normalized.ip, ip_last: event.normalized.ip, user_agent: null,
          device_name: event.normalized.device_name, creation_event_id: event.eventId,
          last_event_id: event.eventId, source_epoch: SOURCE_EPOCH, source_stream_id: entry.id,
          ingested_at: oldSession.exists ? oldSession.get('ingested_at') : FieldValue.serverTimestamp(),
          updated_at: FieldValue.serverTimestamp(), expire_at: null, schema_version: 1,
        }, { merge: true });
      } else if (sessionRefList.length) {
        for (let index = 0; index < sessionRefList.length; index += 1) {
          const ref = sessionRefList[index];
          const sessionSnap = sessionSnaps[index];
          if (!sessionSnap.exists || sessionSnap.get('status') !== 'open') continue;
          const status = ['SESSION_REVOKED', 'SESSION_AUTO_REVOKED', 'ADMIN_SESSION_REVOKED'].includes(event.eventType)
            ? 'revoked' : 'logged_out';
          transaction.set(sessionRefsMap.get(ref), {
            status, ended_at: event.normalized.occurred_at, end_reason: endingReason,
            last_event_id: event.eventId, updated_at: FieldValue.serverTimestamp(),
            source_epoch: SOURCE_EPOCH, source_stream_id: entry.id,
          }, { merge: true });
        }
      }
    }
    transaction.set(checkpointRef, {
      source_epoch: SOURCE_EPOCH, source_stream_key: source,
      last_stream_id: entry.id, last_event_id: event.eventId,
      updated_at: FieldValue.serverTimestamp(), schema_version: 1,
    }, { merge: true });
  });
}

async function syncSource(source) {
  const firestore = ensureDb();
  const checkpoint = await firestore.collection('auth_sync_checkpoints').doc(sourceId(source)).get();
  let cursor = checkpoint.get('last_stream_id') || '0-0';
  const keyType = await client.type(source);
  if (keyType === 'none') return 0;
  if (keyType !== 'stream') throw new Error(`Expected Redis Stream at ${source}; found ${keyType}`);
  let processed = 0;
  while (!stopping && processed < BATCH_SIZE) {
    const entries = await client.xRange(source, `(${cursor}`, '+', { COUNT: Math.min(25, BATCH_SIZE - processed) });
    if (!entries.length) break;
    for (const entry of entries) {
      await applyEvent(source, entry);
      cursor = entry.id;
      processed += 1;
    }
  }
  return processed;
}

async function syncExistingUserProfiles() {
  let cursor = '0';
  let count = 0;
  do {
    const result = await client.scan(cursor, { MATCH: 'user:*', COUNT: 100 });
    cursor = String(result.cursor);
    for (const key of result.keys) {
      const match = /^user:([^:]+)$/.exec(key);
      if (!match || await client.type(key) !== 'hash') continue;
      const data = await client.hGetAll(key);
      if (!data.username) continue;
      await saveUserProfile({
        userId: match[1], username: data.username, role: data.role,
        email: data.email, status: data.status,
      });
      count += 1;
    }
  } while (cursor !== '0' && !stopping);
  console.log(`[Firestore] Synced ${count} Redis user profiles`);
}

function wait(ms) {
  return new Promise((resolve) => {
    wakeTimer = setTimeout(resolve, ms);
    wakeTimer.unref?.();
  });
}

async function runWorker() {
  try { await syncExistingUserProfiles(); }
  catch (error) { console.error('[Firestore sync] Could not sync existing user profiles; will continue with stream events:', error.message); }
  while (!stopping) {
    let didWork = 0;
    try {
      for (const source of SOURCES) didWork += await syncSource(source);
    } catch (error) {
      console.error('[Firestore sync] Batch failed; will retry from the last committed checkpoint:', error.message);
    }
    if (!stopping && didWork === 0) await wait(POLL_MS);
  }
}

function startWorker() {
  if (!ENABLED || !db || workerPromise) return;
  stopping = false;
  workerPromise = runWorker().finally(() => { workerPromise = null; });
}

async function stopWorker() {
  stopping = true;
  if (wakeTimer) clearTimeout(wakeTimer);
  if (workerPromise) await workerPromise;
  workerPromise = null;
}

module.exports = { ENABLED, initialize, saveUserProfile, startWorker, stopWorker };
