local function checkSecurityType(key, expected)
  local actual = redis.call('TYPE', key).ok
  if actual ~= 'none' and actual ~= expected then
    return false, 'wrong type for security key: ' .. key
  end
  return true
end

local function validateSecurityKeys(keys)
  for _, pair in ipairs(keys) do
    local valid, message = checkSecurityType(pair[1], pair[2])
    if not valid then return false, message end
  end
  return true
end

local appendSecurityEvent

local function storeSecurityAlert(hashKey, userAllKey, globalAllKey, userOpenKey, globalOpenKey,
  userHighKey, globalHighKey, userResolvedKey, globalResolvedKey, streamKey,
  alertId, userId, username, alertType, severity, reasons, title, description,
  nowMs, ip, device, managementId, retentionSeconds)
  redis.call('HSET', hashKey,
    'alertId', alertId, 'userId', userId, 'username', username,
    'alertType', alertType, 'severity', severity, 'reasons', reasons,
    'title', title, 'description', description, 'status', 'OPEN',
    'createdAtMs', tostring(nowMs), 'ip', ip or '', 'device', device or '',
    'relatedManagementId', managementId or '', 'readAt', '', 'resolvedAt', '',
    'resolvedBy', '', 'resolution', '')
  redis.call('PEXPIREAT', hashKey, nowMs + retentionSeconds * 1000)
  redis.call('ZADD', userAllKey, nowMs, alertId)
  redis.call('ZADD', globalAllKey, nowMs, alertId)
  redis.call('ZADD', userOpenKey, nowMs, alertId)
  redis.call('ZADD', globalOpenKey, nowMs, alertId)
  if severity == 'HIGH' then
    redis.call('ZADD', userHighKey, nowMs, alertId)
    redis.call('ZADD', globalHighKey, nowMs, alertId)
  end
  redis.call('EXPIRE', userAllKey, retentionSeconds)
  redis.call('EXPIRE', globalAllKey, retentionSeconds)
  redis.call('EXPIRE', userOpenKey, retentionSeconds)
  redis.call('EXPIRE', globalOpenKey, retentionSeconds)
  redis.call('EXPIRE', userHighKey, retentionSeconds)
  redis.call('EXPIRE', globalHighKey, retentionSeconds)
  redis.call('EXPIRE', userResolvedKey, retentionSeconds)
  redis.call('EXPIRE', globalResolvedKey, retentionSeconds)
  return appendSecurityEvent(streamKey, alertId, 'ALERT_CREATED', 'SYSTEM', nowMs, alertType, retentionSeconds)
end

appendSecurityEvent = function(streamKey, alertId, eventType, actorUserId, nowMs, details, retentionSeconds)
  local cutoffId = tostring(math.max(0, nowMs - retentionSeconds * 1000)) .. '-0'
  local alertStreamKey = 'security:alert:events:' .. alertId
  local alertKey = 'security:alert:' .. alertId
  local userId = redis.call('HGET', alertKey, 'userId') or ''
  local function appendOne(key)
    local result = redis.pcall('XADD', key, '*', 'alertId', alertId, 'userId', userId,
      'eventType', eventType, 'actorUserId', actorUserId, 'occurredAtMs', tostring(nowMs), 'details', details or '')
    if type(result) == 'table' and result.err then return false end
    local trimmed = redis.pcall('XTRIM', key, 'MINID', '=', cutoffId)
    local expired = redis.pcall('EXPIRE', key, retentionSeconds)
    return not (type(trimmed) == 'table' and trimmed.err) and not (type(expired) == 'table' and expired.err)
  end
  local recorded = appendOne(streamKey)
  if not appendOne(alertStreamKey) then recorded = false end
  return recorded
end
