local function validateAuditStream(key)
  if not key or key == '' then return true end
  local actual = redis.call('TYPE', key).ok
  if actual ~= 'none' and actual ~= 'stream' then
    return false, 'wrong type for audit stream'
  end
  return true
end

local function auditNowMs()
  local time = redis.call('TIME')
  return tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
end

local function auditText(value, maxLength)
  return string.sub(tostring(value or ''), 1, maxLength)
end

local function appendAuditToStream(streamKey, fields, retentionSeconds, nowMs)
  if not streamKey or streamKey == '' then return true end
  local added = redis.pcall('XADD', streamKey, '*', unpack(fields))
  if type(added) == 'table' and added.err then return false end
  local cutoffId = tostring(math.max(0, nowMs - retentionSeconds * 1000)) .. '-0'
  local trimmed = redis.pcall('XTRIM', streamKey, 'MINID', '=', cutoffId)
  local expired = redis.pcall('EXPIRE', streamKey, retentionSeconds)
  return not (type(trimmed) == 'table' and trimmed.err)
    and not (type(expired) == 'table' and expired.err)
end

local function appendAudit(globalKey, targetKey, actorKey, fields, retentionSeconds, nowMs)
  local ok = appendAuditToStream(globalKey, fields, retentionSeconds, nowMs)
  if not appendAuditToStream(targetKey, fields, retentionSeconds, nowMs) then ok = false end
  if actorKey and actorKey ~= '' and actorKey ~= targetKey
    and not appendAuditToStream(actorKey, fields, retentionSeconds, nowMs) then
    ok = false
  end
  return ok
end

local function auditFields(eventId, eventType, actorId, actorRole, actorUsername,
  targetId, username, occurredAtMs, result, ip, device, revokedCount, reason,
  sessionRef, sessionRefs, createdAtMs, expiresAtMs)
  local fields = {
    'eventId', auditText(eventId, 80),
    'eventType', auditText(eventType, 32),
    'actorUserId', auditText(actorId, 128),
    'actorRole', auditText(actorRole, 16),
    'actorUsername', auditText(actorUsername, 64),
    'targetUserId', auditText(targetId, 128),
    'username', auditText(username, 64),
    'occurredAtMs', tostring(occurredAtMs),
    'result', result or '',
  }
  if ip and ip ~= '' then fields[#fields + 1] = 'ip'; fields[#fields + 1] = auditText(ip, 64) end
  if device and device ~= '' then fields[#fields + 1] = 'device'; fields[#fields + 1] = auditText(device, 256) end
  if revokedCount ~= nil then fields[#fields + 1] = 'revokedCount'; fields[#fields + 1] = tostring(revokedCount) end
  if reason and reason ~= '' then fields[#fields + 1] = 'reason'; fields[#fields + 1] = auditText(reason, 80) end
  if sessionRef and sessionRef ~= '' then fields[#fields + 1] = 'sessionRef'; fields[#fields + 1] = auditText(sessionRef, 128) end
  if sessionRefs and sessionRefs ~= '' then fields[#fields + 1] = 'sessionRefs'; fields[#fields + 1] = auditText(sessionRefs, 1024) end
  if createdAtMs then fields[#fields + 1] = 'createdAtMs'; fields[#fields + 1] = tostring(createdAtMs) end
  if expiresAtMs then fields[#fields + 1] = 'expiresAtMs'; fields[#fields + 1] = tostring(expiresAtMs) end
  return fields
end
