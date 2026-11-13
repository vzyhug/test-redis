-- KEYS: known devices, known IPs, baseline, dedupe marker, alert hash,
-- user/global all, user/global open, user/global high, user/global resolved, events stream.
-- ARGV: userId, username, device signature, IP, display device, managementId,
-- device digest, alertId, retention seconds, dedupe seconds, marker cap.
-- SECURITY_HELPERS
local userId, username, deviceSignature, ip = ARGV[1], ARGV[2], ARGV[3], ARGV[4]
local displayDevice, managementId, deviceDigest = ARGV[5], ARGV[6], ARGV[7]
local alertId, retention, dedupeSeconds, markerCap = ARGV[8], tonumber(ARGV[9]), tonumber(ARGV[10]), tonumber(ARGV[11])
local valid, message = validateSecurityKeys({
  {KEYS[1], 'set'}, {KEYS[2], 'set'}, {KEYS[3], 'string'}, {KEYS[4], 'string'}, {KEYS[5], 'hash'},
  {KEYS[6], 'zset'}, {KEYS[7], 'zset'}, {KEYS[8], 'zset'}, {KEYS[9], 'zset'},
  {KEYS[10], 'zset'}, {KEYS[11], 'zset'}, {KEYS[12], 'zset'}, {KEYS[13], 'zset'}, {KEYS[14], 'stream'},
  {'security:alert:events:' .. ARGV[8], 'stream'},
})
if not valid then return redis.error_reply(message) end
if not retention or retention < 1 or not dedupeSeconds or dedupeSeconds < 1 or not markerCap or markerCap < 1 then
  return redis.error_reply('invalid security retention arguments')
end
local time = redis.call('TIME')
local nowMs = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local baselineExists = redis.call('EXISTS', KEYS[3]) == 1
if not baselineExists then
  redis.call('SET', KEYS[3], '1', 'EX', retention)
  redis.call('SADD', KEYS[1], deviceSignature)
  redis.call('SADD', KEYS[2], ip)
  redis.call('EXPIRE', KEYS[1], retention)
  redis.call('EXPIRE', KEYS[2], retention)
  return {'BASELINE_CREATED', '0', '1'}
end
local newDevice = redis.call('SISMEMBER', KEYS[1], deviceSignature) == 0
local newIp = redis.call('SISMEMBER', KEYS[2], ip) == 0
redis.call('SADD', KEYS[1], deviceSignature)
redis.call('SADD', KEYS[2], ip)
redis.call('EXPIRE', KEYS[1], retention)
redis.call('EXPIRE', KEYS[2], retention)
while redis.call('SCARD', KEYS[1]) > markerCap do redis.call('SPOP', KEYS[1]) end
while redis.call('SCARD', KEYS[2]) > markerCap do redis.call('SPOP', KEYS[2]) end
redis.call('EXPIRE', KEYS[3], retention)
if not newDevice and not newIp then return {'KNOWN', '0', '1'} end
local dedupeExists = redis.call('EXISTS', KEYS[4]) == 1
if dedupeExists then return {'DEDUPED', '0', '1'} end
redis.call('SET', KEYS[4], '1', 'EX', dedupeSeconds)
local reasons = {}
if newDevice then reasons[#reasons + 1] = 'NEW_DEVICE' end
if newIp then reasons[#reasons + 1] = 'NEW_IP' end
local reasonText = table.concat(reasons, ',')
local severity = newDevice and 'MEDIUM' or 'LOW'
local title = (newDevice and newIp) and 'Phát hiện môi trường đăng nhập mới'
  or (newDevice and 'Phát hiện đăng nhập từ thiết bị hoặc trình duyệt mới'
  or 'Phát hiện đăng nhập từ địa chỉ IP mới')
local description = 'Lần đăng nhập thành công này có dấu hiệu mới: ' .. reasonText
local recorded = storeSecurityAlert(KEYS[5], KEYS[6], KEYS[7], KEYS[8], KEYS[9], KEYS[10], KEYS[11], KEYS[12], KEYS[13], KEYS[14],
  alertId, userId, username, 'NEW_LOGIN_ENVIRONMENT', severity, reasonText, title, description,
  nowMs, ip, displayDevice, managementId, retention)
if #redis.call('SMEMBERS', KEYS[1]) > markerCap then return redis.error_reply('security device marker cap exceeded') end
return {'ALERT_CREATED', alertId, recorded and '1' or '0'}
