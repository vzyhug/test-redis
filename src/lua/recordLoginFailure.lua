-- Atomically enforce a username's sliding failure window and temporary lock.
-- KEYS: failure-event ZSET, lock String.
-- ARGV: unique failure ID, window seconds, lock seconds, threshold.
-- AUDIT_HELPERS

local eventsKey = KEYS[1]
local lockKey = KEYS[2]
local auditGlobalKey = KEYS[3]
local auditUserKey = KEYS[4]
local failureId = ARGV[1]
local windowSeconds = tonumber(ARGV[2])
local lockSeconds = tonumber(ARGV[3])
local threshold = tonumber(ARGV[4])
local auditRetention = tonumber(ARGV[5])
local userId = ARGV[6]
local username = ARGV[7]
local actorRole = ARGV[8]
local device = ARGV[9]
local ip = ARGV[10]
local failureEventId = ARGV[11]
local lockedEventId = ARGV[12]
local hasUser = ARGV[13] == '1'

local function keyType(key)
  return redis.call('TYPE', key).ok
end

local eventsType = keyType(eventsKey)
if eventsType ~= 'none' and eventsType ~= 'zset' then
  return redis.error_reply('wrong type for login failure events')
end
local lockType = keyType(lockKey)
if lockType ~= 'none' and lockType ~= 'string' then
  return redis.error_reply('wrong type for login lock')
end
if not windowSeconds or windowSeconds < 1 or not lockSeconds or lockSeconds < 1
  or not threshold or threshold < 1 or not failureId or failureId == '' then
  return redis.error_reply('invalid login failure arguments')
end
if not auditRetention or auditRetention < 1 or not failureEventId or not lockedEventId then
  return redis.error_reply('invalid audit arguments')
end
local auditOk, auditError = validateAuditStream(auditGlobalKey)
if not auditOk then return redis.error_reply(auditError) end
if hasUser then
  auditOk, auditError = validateAuditStream(auditUserKey)
  if not auditOk then return redis.error_reply(auditError) end
end

if redis.call('EXISTS', lockKey) == 1 then
  local lockTtl = redis.call('PTTL', lockKey)
  local retryAfter = lockTtl > 0 and math.ceil(lockTtl / 1000) or lockSeconds
  return { 'LOCKED', tostring(retryAfter), '0', '1', '0' }
end

local time = redis.call('TIME')
local nowMs = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local cutoff = nowMs - windowSeconds * 1000

-- Failures at or before the cutoff are outside the sliding window.
redis.call('ZREMRANGEBYSCORE', eventsKey, '-inf', cutoff)
redis.call('ZADD', eventsKey, nowMs, failureId)
redis.call('EXPIRE', eventsKey, windowSeconds)

local failureCount = redis.call('ZCARD', eventsKey)
if failureCount >= threshold then
  redis.call('SET', lockKey, '1', 'EX', lockSeconds)
  -- Starting the lock clears the old streak, so it cannot relock immediately
  -- when the lock expires.
  redis.call('DEL', eventsKey)
  local eventTime = nowMs
  local actorId = hasUser and userId or ''
  local actorName = hasUser and username or ''
  local targetId = hasUser and userId or ''
  local targetName = hasUser and username or username
  local failedFields = auditFields(
    failureEventId, 'LOGIN_FAILED', actorId, hasUser and actorRole or 'ANONYMOUS', actorName,
    targetId, targetName, eventTime, 'FAILED', ip, device, nil, 'INVALID_CREDENTIALS'
  )
  local written = appendAudit(auditGlobalKey, hasUser and auditUserKey or '', '', failedFields, auditRetention, eventTime)
  local lockedFields = auditFields(
    lockedEventId, 'LOGIN_LOCKED', 'SYSTEM', 'SYSTEM', 'SYSTEM', targetId, targetName,
    eventTime, 'LOCKED', ip, device, nil, 'FAILURE_THRESHOLD'
  )
  if not appendAudit(auditGlobalKey, hasUser and auditUserKey or '', '', lockedFields, auditRetention, eventTime) then written = false end
  return { 'LOCKED', tostring(lockSeconds), tostring(failureCount), written and '1' or '0', '1' }
end

local actorId = hasUser and userId or ''
local actorName = hasUser and username or ''
local targetId = hasUser and userId or ''
local failedFields = auditFields(
  failureEventId, 'LOGIN_FAILED', actorId, hasUser and actorRole or 'ANONYMOUS', actorName,
  targetId, username, nowMs, 'FAILED', ip, device, nil, 'INVALID_CREDENTIALS'
)
local written = appendAudit(auditGlobalKey, hasUser and auditUserKey or '', '', failedFields, auditRetention, nowMs)
return { 'FAILED', '0', tostring(failureCount), written and '1' or '0', '0' }
