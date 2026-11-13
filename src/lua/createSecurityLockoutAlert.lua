-- KEYS: alert hash, user/global all, user/global open, user/global high,
-- user/global resolved, events stream.
-- ARGV: alertId, userId, username, role, ip, normalized device, failure count,
-- lock seconds, retention seconds.
-- SECURITY_HELPERS
local alertId, userId, username = ARGV[1], ARGV[2], ARGV[3]
local role, ip, device = ARGV[4], ARGV[5], ARGV[6]
local count, lockSeconds, retention = tonumber(ARGV[7]), tonumber(ARGV[8]), tonumber(ARGV[9])
local valid, message = validateSecurityKeys({
  {KEYS[1], 'hash'}, {KEYS[2], 'zset'}, {KEYS[3], 'zset'}, {KEYS[4], 'zset'}, {KEYS[5], 'zset'},
  {KEYS[6], 'zset'}, {KEYS[7], 'zset'}, {KEYS[8], 'zset'}, {KEYS[9], 'zset'}, {KEYS[10], 'stream'},
  {'security:alert:events:' .. ARGV[1], 'stream'},
})
if not valid then return redis.error_reply(message) end
if not count or count < 1 or not lockSeconds or lockSeconds < 1 or not retention or retention < 1 then
  return redis.error_reply('invalid security lockout arguments')
end
local time = redis.call('TIME')
local nowMs = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local description = 'Redis đã kích hoạt khóa tạm thời sau ' .. tostring(count) .. ' lần đăng nhập sai; thời hạn ' .. tostring(lockSeconds) .. ' giây.'
local recorded = storeSecurityAlert(KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[6], KEYS[7], KEYS[8], KEYS[9], KEYS[10],
  alertId, userId, username, 'LOGIN_LOCKOUT', 'HIGH', 'FAILURE_THRESHOLD',
  'Tài khoản bị khóa tạm thời do đăng nhập sai nhiều lần', description,
  nowMs, ip, device, '', retention)
redis.call('HSET', KEYS[1], 'role', role, 'failureCount', tostring(count), 'lockSeconds', tostring(lockSeconds))
return {alertId, recorded and '1' or '0'}
