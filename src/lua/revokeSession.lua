-- AUDIT_HELPERS
local setKey, orderKey = KEYS[1], KEYS[2]
local userId, managementId, currentId = ARGV[1], ARGV[2], ARGV[3]
local auditEnabled = ARGV[12] == '1'
local function kind(key) return redis.call('TYPE', key).ok end
local setType, orderType = kind(setKey), kind(orderKey)
if setType ~= 'none' and setType ~= 'set' then return redis.error_reply('wrong type for session set') end
if orderType ~= 'none' and orderType ~= 'zset' then return redis.error_reply('wrong type for session order') end
if auditEnabled then
  local valid, errorMessage = validateAuditStream(KEYS[3])
  if not valid then return redis.error_reply(errorMessage) end
  valid, errorMessage = validateAuditStream(KEYS[4])
  if not valid then return redis.error_reply(errorMessage) end
  if KEYS[5] ~= KEYS[4] then
    valid, errorMessage = validateAuditStream(KEYS[5])
    if not valid then return redis.error_reply(errorMessage) end
  end
end
if redis.call('SCARD', setKey) > 1000 or redis.call('ZCARD', orderKey) > 1000 then
  return redis.error_reply('session index exceeds safe limit')
end
local ids, seen = {}, {}
for _, id in ipairs(redis.call('SMEMBERS', setKey)) do if not seen[id] then ids[#ids + 1] = id; seen[id] = true end end
for _, id in ipairs(redis.call('ZRANGE', orderKey, 0, -1)) do if not seen[id] then ids[#ids + 1] = id; seen[id] = true end end
local matchId = nil
for _, id in ipairs(ids) do
  local sessionKind = kind('session:' .. id)
  if sessionKind ~= 'none' and sessionKind ~= 'hash' then return redis.error_reply('wrong type for referenced session') end
  if sessionKind == 'hash' and redis.call('HGET', 'session:' .. id, 'userId') == userId
    and redis.call('HGET', 'session:' .. id, 'managementId') == managementId then
    matchId = id
  end
end
if matchId == currentId then return { 'CURRENT', '1' } end
if not matchId then
  for _, id in ipairs(ids) do
    local owner = redis.call('HGET', 'session:' .. id, 'userId')
    if owner ~= userId then redis.call('SREM', setKey, id); redis.call('ZREM', orderKey, id) end
  end
  return { 'NOT_FOUND', '1' }
end
local targetKey = 'session:' .. matchId
local targetUsername = redis.call('HGET', targetKey, 'username') or ''
local targetDevice = redis.call('HGET', targetKey, 'device') or ''
local targetIp = redis.call('HGET', targetKey, 'ip') or ''
local sessionRef = redis.call('HGET', targetKey, 'sessionRef') or ''
redis.call('DEL', targetKey)
redis.call('SREM', setKey, matchId)
redis.call('ZREM', orderKey, matchId)
if not auditEnabled then return { 'REVOKED', '1' } end
local nowMs = auditNowMs()
local fields = auditFields(
  ARGV[5], ARGV[4], ARGV[6], ARGV[7], ARGV[8], userId, targetUsername,
  nowMs, 'SUCCESS', ARGV[9] ~= '' and ARGV[9] or targetIp,
  ARGV[10] ~= '' and ARGV[10] or targetDevice, nil, '', sessionRef
)
local written = appendAudit(KEYS[3], KEYS[4], KEYS[5], fields, tonumber(ARGV[11]), nowMs)
return { 'REVOKED', written and '1' or '0' }
