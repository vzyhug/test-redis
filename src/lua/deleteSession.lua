-- AUDIT_HELPERS
local expected = { 'hash', 'set', 'zset', 'stream', 'stream' }
for index, key in ipairs(KEYS) do
  local actual = redis.call('TYPE', key).ok
  if actual ~= 'none' and actual ~= expected[index] then
    return redis.error_reply('wrong type for logout key')
  end
end
local sessionId, expectedOwner = ARGV[1], ARGV[2]
local sessionKey = KEYS[1]
if redis.call('TYPE', sessionKey).ok ~= 'hash'
  or redis.call('HGET', sessionKey, 'userId') ~= expectedOwner then
  return { 'NOT_FOUND', '1' }
end
local username = redis.call('HGET', sessionKey, 'username') or ARGV[8]
local device = ARGV[10] ~= '' and ARGV[10] or (redis.call('HGET', sessionKey, 'device') or '')
local ip = ARGV[9] ~= '' and ARGV[9] or (redis.call('HGET', sessionKey, 'ip') or '')
local sessionRef = redis.call('HGET', sessionKey, 'sessionRef') or ''
redis.call('DEL', sessionKey)
redis.call('SREM', KEYS[2], sessionId)
redis.call('ZREM', KEYS[3], sessionId)
local nowMs = auditNowMs()
local fields = auditFields(
  ARGV[3], ARGV[4], ARGV[5], ARGV[6], ARGV[7], expectedOwner, username,
  nowMs, 'SUCCESS', ip, device, nil, '', sessionRef
)
local written = appendAudit(KEYS[4], KEYS[5], '', fields, tonumber(ARGV[11]), nowMs)
return { 'DELETED', written and '1' or '0' }
