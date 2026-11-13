-- AUDIT_HELPERS
local setKey, orderKey = KEYS[1], KEYS[2]
local userId = ARGV[1]
local auditEnabled = ARGV[10] == '1'
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
for _, id in ipairs(ids) do
  local sessionKind = kind('session:' .. id)
  if sessionKind ~= 'none' and sessionKind ~= 'hash' then return redis.error_reply('wrong type for referenced session') end
end
local removed = 0
for _, id in ipairs(ids) do
  local key = 'session:' .. id
  if kind(key) == 'hash' and redis.call('HGET', key, 'userId') == userId then
    removed = removed + redis.call('DEL', key)
  end
  redis.call('SREM', setKey, id)
  redis.call('ZREM', orderKey, id)
end
if redis.call('SCARD', setKey) == 0 then redis.call('DEL', setKey) end
if redis.call('ZCARD', orderKey) == 0 then redis.call('DEL', orderKey) end
if not auditEnabled then return { 'REVOKED', tostring(removed), '1' } end
local nowMs = auditNowMs()
local targetUsername = redis.call('HGET', 'user:' .. userId, 'username') or ''
local fields = auditFields(
  ARGV[3], ARGV[2], ARGV[4], ARGV[5], ARGV[6], userId, targetUsername,
  nowMs, 'SUCCESS', ARGV[7], ARGV[8], removed, ''
)
local written = appendAudit(KEYS[3], KEYS[4], KEYS[5], fields, tonumber(ARGV[9]), nowMs)
return { 'REVOKED', tostring(removed), written and '1' or '0' }
